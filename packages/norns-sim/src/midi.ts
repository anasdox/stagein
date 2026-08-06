import { appendFile } from 'node:fs';
import { createSocket, type Socket } from 'node:dgram';

import type { NornsConfig } from './config';

export interface CcEvent {
  at: number;
  channel: number;
  cc: number;
  value: number;
}

/**
 * Where the Norns output actually goes.
 *
 * `log`  — stdout + the emulator panel + an optional JSONL file. This is what
 *          makes "the Norns emits two verifiable MIDI CC" checkable without a
 *          soundcard, which is the whole point of running in Docker.
 * `osc`  — UDP OSC messages, so a real SuperCollider/Max patch can listen.
 * `midi` — a real MIDI port, when the optional native dependency is present.
 */
export class MidiOut {
  readonly monitor: CcEvent[] = [];
  private total = 0;
  private socket: Socket | null = null;
  private device: { send(type: string, msg: Record<string, number>): void } | null = null;
  private readonly listeners = new Set<(e: CcEvent) => void>();
  backend: string;

  constructor(private readonly config: NornsConfig) {
    this.backend = config.midiBackend;
    if (config.midiBackend === 'osc') {
      this.socket = createSocket('udp4');
      this.socket.on('error', (err) => console.error('[midi] osc socket error', err));
    }
    if (config.midiBackend === 'midi') {
      this.device = openRealMidi(config.midiPortName);
      if (!this.device) {
        console.warn('[midi] easymidi unavailable — falling back to log backend');
        this.backend = 'log';
      }
    }
  }

  onEvent(fn: (e: CcEvent) => void): void {
    this.listeners.add(fn);
  }

  get count(): number {
    return this.total;
  }

  cc(channel: number, cc: number, value: number): void {
    const event: CcEvent = { at: Date.now(), channel, cc, value };
    this.total++;

    this.monitor.push(event);
    if (this.monitor.length > 200) this.monitor.shift();

    if (this.device) {
      // easymidi channels are 0-based.
      this.device.send('cc', { channel: channel - 1, controller: cc, value });
    }

    console.log(`[midi] ch${channel} CC${cc} = ${value}`);

    if (this.config.midiLogFile) {
      appendFile(this.config.midiLogFile, `${JSON.stringify(event)}\n`, (err) => {
        if (err) console.error('[midi] log write failed', err);
      });
    }

    for (const fn of this.listeners) fn(event);
  }

  /** OSC path + single float argument — enough for two macros (PRD §8). */
  osc(address: string, value: number): void {
    const event: CcEvent = { at: Date.now(), channel: 0, cc: -1, value };
    this.total++;
    this.monitor.push(event);
    if (this.monitor.length > 200) this.monitor.shift();
    console.log(`[osc]  ${address} ${value}`);
    if (this.socket) {
      const packet = encodeOsc(address, value);
      this.socket.send(packet, this.config.oscPort, this.config.oscHost, (err) => {
        if (err) console.error('[midi] osc send failed', err);
      });
    }
    for (const fn of this.listeners) fn(event);
  }

  close(): void {
    this.socket?.close();
    const closable = this.device as unknown as { close?: () => void } | null;
    closable?.close?.();
  }
}

function openRealMidi(portName: string): { send(t: string, m: Record<string, number>): void } | null {
  try {
    // Optional native dependency: absent in the container, present on a laptop
    // wired to the actual rig.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const easymidi = require('easymidi') as {
      Output: new (name: string, virtual?: boolean) => { send(t: string, m: Record<string, number>): void };
    };
    return new easymidi.Output(portName, true);
  } catch {
    return null;
  }
}

/** Minimal OSC 1.0 encoder: one address, one float32 argument. */
function encodeOsc(address: string, value: number): Buffer {
  const pad = (buf: Buffer): Buffer => {
    const remainder = buf.length % 4;
    return remainder === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - remainder)]);
  };
  const addr = pad(Buffer.concat([Buffer.from(address, 'ascii'), Buffer.alloc(1)]));
  const tags = pad(Buffer.concat([Buffer.from(',f', 'ascii'), Buffer.alloc(1)]));
  const arg = Buffer.alloc(4);
  arg.writeFloatBE(value, 0);
  return Buffer.concat([addr, tags, arg]);
}
