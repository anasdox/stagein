#!/usr/bin/env python3
"""StageIn bridge — the Norns' outbound link to the relay.

matron has no WebSocket client, so this companion process holds the connection
and translates it to local OSC (PRD §18):

    engine  --osc /stagein/out-->  bridge  --ws-->  relay
    engine  <--osc /stagein/in--   bridge  <--ws--  relay
                                   bridge  --osc /stagein/{up,down}--> engine

Deliberately **standard library only**. A Norns cannot be assumed to have pip
access or a working toolchain, and a dependency that fails to install on the day
of a show is a dependency that does not exist. That means a hand-rolled RFC 6455
client and a hand-rolled OSC codec; both are small and only need the narrow
slice the protocol uses (text frames, one string argument).

Run by lib/relay_osc.lua; also runnable directly for testing:

    python3 stagein_bridge.py --config config.json
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import selectors
import socket
import ssl
import struct
import sys
import threading
import time
from urllib.parse import urlparse

FIRMWARE = "stagein-bridge 0.2"

# ---------------------------------------------------------------------------
# logging
# ---------------------------------------------------------------------------


def log(message: str) -> None:
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S")
    print(f"{stamp} [bridge] {message}", flush=True)


# ---------------------------------------------------------------------------
# OSC
# ---------------------------------------------------------------------------


def _pad(raw: bytes) -> bytes:
    """OSC pads every field to a 4-byte boundary."""
    return raw + b"\x00" * ((4 - len(raw) % 4) % 4)


def osc_encode(address: str, argument: str) -> bytes:
    """One address, one string argument — all this protocol needs."""
    return (
        _pad(address.encode("utf-8") + b"\x00")
        + _pad(b",s\x00")
        + _pad(argument.encode("utf-8") + b"\x00")
    )


def _read_osc_string(data: bytes, offset: int) -> tuple[str, int]:
    end = data.index(b"\x00", offset)
    text = data[offset:end].decode("utf-8", "replace")
    return text, offset + (((end - offset) // 4) + 1) * 4


def osc_decode(data: bytes) -> tuple[str, list[str]]:
    """Decode an OSC message, keeping only string arguments."""
    address, offset = _read_osc_string(data, 0)
    args: list[str] = []
    if offset < len(data) and data[offset : offset + 1] == b",":
        tags, offset = _read_osc_string(data, offset)
        for tag in tags[1:]:
            if tag == "s":
                value, offset = _read_osc_string(data, offset)
                args.append(value)
            elif tag in "ifd":  # skip numeric arguments we do not use
                offset += 8 if tag == "d" else 4
    return address, args


# ---------------------------------------------------------------------------
# WebSocket client (RFC 6455, client side, text frames)
# ---------------------------------------------------------------------------

OP_CONTINUATION = 0x0
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA


class WebSocketError(Exception):
    pass


class WebSocket:
    """Minimal client. Blocking, one frame at a time, text payloads only."""

    def __init__(self, url: str, timeout: float = 10.0) -> None:
        parsed = urlparse(url)
        if parsed.scheme not in ("ws", "wss"):
            raise WebSocketError(f"unsupported scheme {parsed.scheme!r}")
        secure = parsed.scheme == "wss"
        host = parsed.hostname
        if not host:
            raise WebSocketError("missing host")
        port = parsed.port or (443 if secure else 80)
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"

        self._buffer = b""
        self._closed = False

        raw = socket.create_connection((host, port), timeout=timeout)
        if secure:
            context = ssl.create_default_context()
            raw = context.wrap_socket(raw, server_hostname=host)
        self.sock = raw

        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            f"User-Agent: {FIRMWARE}\r\n"
            "\r\n"
        )
        self.sock.sendall(request.encode("ascii"))

        header = self._read_until(b"\r\n\r\n")
        status = header.split(b"\r\n", 1)[0].decode("latin-1")
        if "101" not in status:
            raise WebSocketError(f"handshake refused: {status}")
        # The Sec-WebSocket-Accept digest is not verified: this client only ever
        # dials the relay it was configured with, over TLS in production, so the
        # check would add no protection the transport does not already give.

        self.sock.settimeout(None)

    # -- raw io ------------------------------------------------------------

    def _read_until(self, marker: bytes) -> bytes:
        while marker not in self._buffer:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise WebSocketError("connection closed during handshake")
            self._buffer += chunk
        head, _, rest = self._buffer.partition(marker)
        self._buffer = rest
        return head

    def _read_exact(self, count: int) -> bytes:
        while len(self._buffer) < count:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise WebSocketError("connection closed")
            self._buffer += chunk
        out, self._buffer = self._buffer[:count], self._buffer[count:]
        return out

    # -- frames ------------------------------------------------------------

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        if self._closed:
            return
        header = bytearray()
        header.append(0x80 | opcode)  # FIN set; this client never fragments
        length = len(payload)
        # Client frames must always be masked (RFC 6455 §5.3).
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += struct.pack("!H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack("!Q", length)
        mask = os.urandom(4)
        header += mask
        masked = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def send_text(self, text: str) -> None:
        self._send_frame(OP_TEXT, text.encode("utf-8"))

    def recv_text(self) -> str | None:
        """Return the next text payload, or None for a control frame."""
        first, second = self._read_exact(2)
        opcode = first & 0x0F
        length = second & 0x7F
        if length == 126:
            (length,) = struct.unpack("!H", self._read_exact(2))
        elif length == 127:
            (length,) = struct.unpack("!Q", self._read_exact(8))
        if second & 0x80:  # a server must not mask
            raise WebSocketError("masked frame from server")
        payload = self._read_exact(length) if length else b""

        if opcode == OP_TEXT:
            return payload.decode("utf-8", "replace")
        if opcode == OP_PING:
            self._send_frame(OP_PONG, payload)
            return None
        if opcode in (OP_PONG, OP_BINARY, OP_CONTINUATION):
            return None
        if opcode == OP_CLOSE:
            raise WebSocketError("server closed the connection")
        raise WebSocketError(f"unexpected opcode {opcode}")

    def close(self) -> None:
        if self._closed:
            return
        try:
            self._send_frame(OP_CLOSE, b"\x03\xe8")  # 1000 normal closure
        except OSError:
            pass
        self._closed = True
        try:
            self.sock.close()
        except OSError:
            pass


# ---------------------------------------------------------------------------
# bridge
# ---------------------------------------------------------------------------


class Bridge:
    def __init__(self, config: dict) -> None:
        self.relay_url: str = config["relay_ws_url"]
        self.session: str = str(config.get("session", "")).upper()
        self.token: str = config.get("norns_token", "")
        self.matron_port: int = int(config.get("matron_osc_port", 10111))
        self.bridge_port: int = int(config.get("bridge_osc_port", 10112))
        self.reconnect_min = float(config.get("reconnect_min_s", 0.5))
        self.reconnect_max = float(config.get("reconnect_max_s", 5.0))

        self.ws: WebSocket | None = None
        self._ws_lock = threading.Lock()
        self.running = True

        self.udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.udp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.udp.bind(("127.0.0.1", self.bridge_port))

    @property
    def url(self) -> str:
        separator = "&" if "?" in self.relay_url else "?"
        return f"{self.relay_url}{separator}session={self.session}"

    # -- osc toward matron -------------------------------------------------

    def to_engine(self, address: str, payload: str = "") -> None:
        try:
            self.udp.sendto(osc_encode(address, payload), ("127.0.0.1", self.matron_port))
        except OSError as err:
            log(f"osc send failed: {err}")

    # -- websocket --------------------------------------------------------

    def send_frame(self, text: str) -> None:
        with self._ws_lock:
            if self.ws is None:
                return
            try:
                self.ws.send_text(text)
            except (WebSocketError, OSError) as err:
                log(f"ws send failed: {err}")

    def _udp_loop(self) -> None:
        """Frames from the engine, forwarded to the relay."""
        selector = selectors.DefaultSelector()
        selector.register(self.udp, selectors.EVENT_READ)
        while self.running:
            if not selector.select(timeout=0.25):
                continue
            try:
                data, _ = self.udp.recvfrom(65535)
            except OSError:
                continue
            try:
                address, args = osc_decode(data)
            except (ValueError, IndexError):
                continue
            if address == "/stagein/out" and args:
                self.send_frame(args[0])

    def run(self) -> None:
        log(f"bridge up: relay={self.url} osc in={self.bridge_port} out={self.matron_port}")
        if not self.token or self.token.startswith("paste-"):
            log("REFUSING TO START: norns_token is not configured")
            return

        threading.Thread(target=self._udp_loop, name="osc-in", daemon=True).start()

        backoff = self.reconnect_min
        while self.running:
            try:
                ws = WebSocket(self.url)
                with self._ws_lock:
                    self.ws = ws
                log("connected")
                ws.send_text(
                    json.dumps({"t": "hello", "nornsToken": self.token, "firmware": FIRMWARE})
                )
                self.to_engine("/stagein/up")
                backoff = self.reconnect_min

                while self.running:
                    text = ws.recv_text()
                    if text is not None:
                        self.to_engine("/stagein/in", text)

            except (WebSocketError, OSError) as err:
                log(f"disconnected: {err}")
            except Exception as err:  # never let the bridge die on a bad frame
                log(f"unexpected error: {err!r}")
            finally:
                with self._ws_lock:
                    if self.ws is not None:
                        self.ws.close()
                        self.ws = None
                # The engine must know immediately: no link means no
                # authorisation, and it glides back to the safe values.
                self.to_engine("/stagein/down")

            if not self.running:
                break
            log(f"reconnecting in {backoff:.1f}s")
            time.sleep(backoff)
            backoff = min(self.reconnect_max, backoff * 1.7)

    def stop(self) -> None:
        self.running = False
        with self._ws_lock:
            if self.ws is not None:
                self.ws.close()
                self.ws = None
        try:
            self.udp.close()
        except OSError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description="StageIn Norns bridge")
    parser.add_argument("--config", required=True, help="path to config.json")
    args = parser.parse_args()

    try:
        with open(args.config, "r", encoding="utf-8") as handle:
            config = json.load(handle)
    except (OSError, json.JSONDecodeError) as err:
        log(f"cannot read config {args.config}: {err}")
        return 1

    missing = [key for key in ("relay_ws_url", "session", "norns_token") if not config.get(key)]
    if missing:
        log(f"config is missing: {', '.join(missing)}")
        return 1

    bridge = Bridge(config)
    try:
        bridge.run()
    except KeyboardInterrupt:
        pass
    finally:
        bridge.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
