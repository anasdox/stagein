# StageIn

**Join the performance. Shape the moment.**

A person in the audience — in the room or watching a stream — joins a lottery from their phone. One
of them is drawn. Their waiting screen becomes an XY pad that drives two musical macros for a bounded
number of seconds. The values travel through a relay, get validated and smoothed, and land on a Norns
that turns them into two MIDI CC (or OSC) messages.

This repository is the **MVP** of [`PRD_StageIn_v0.2.md`](./PRD_StageIn_v0.2.md), with the Norns
**emulated** so the whole thing runs on a laptop with no hardware.

---

## Quick start

```bash
mise trust            # first time only: mise.toml lives in this repo
cp .env.example .env
mise run up           # docker compose: relay + emulated Norns
```

Then, in another terminal:

```bash
mise run urls         # prints every URL, including the host token
mise run demo         # plays the whole ritual, narrated
mise run smoke        # 43 acceptance checks against the running stack
```

`mise run demo` is the fastest way to see what this is: it opens registrations,
brings six phones into the lottery, arms the device, draws a winner, plays three gestures through the
pad, cuts it with the kill switch, and returns to the safe values — narrating each beat and drawing
the Norns screen in the terminal. Open the stage view and the Norns panel first and it plays in the
browser too; `--lead 15` waits fifteen seconds so you have time.

| Surface | URL | Who |
| --- | --- | --- |
| Host console | `http://localhost:8080/host/DEMO01#t=dev-host-token-change-me` | artist / operator |
| Participant | open the host console and scan the QR, or use its join link | audience |
| Stage view | `http://localhost:8080/stage/DEMO01` | projector |
| OBS source | `http://localhost:8080/stage/DEMO01?transparent=1` | stream |
| Norns front panel | `http://localhost:8081` | the emulated device |

Without Docker:

```bash
mise run dev          # relay + Norns simulator in one terminal
```

### Running it for real, with phones

Phones cannot resolve `localhost`. Set `PUBLIC_BASE_URL` to an address they can reach, or the QR code
will point nowhere:

```bash
PUBLIC_BASE_URL=http://192.168.1.42:8080 mise run up
```

`mise run urls` lists the candidate LAN addresses.

---

## A run-through

1. Open the **host console**. The session starts with registrations open.
2. Open the **Norns panel** and press **K3** — the device arms. Nothing reaches the output until it
   does; that is the point.
3. Scan the QR (or open the join link in a few browser tabs). A stage name is already filled in —
   keep it and press *Rejoindre la loterie*, or type your own over it first.
4. Press **Lancer le tirage**. A five-second countdown runs, then exactly one person is drawn.
5. The winner's phone vibrates and offers *Prendre le contrôle*. They have 10 s to take it, otherwise
   the relay redraws.
6. They drag. The Norns panel shows the requested position and, trailing behind it, the smoothed
   value actually being sent — plus the two CC numbers changing.
7. After 30 s the pad locks itself and the output glides back to the preset's safe value.
8. **Space bar** in the host console, or a **K3 double-tap** on the device, cuts everything instantly.

---

## Architecture

```
  phone (join.html)          host console            stage view / OBS
        │  WS                    │  WS                    │  WS
        └─────────────┬──────────┴────────────┬───────────┘
                      ▼                       ▼
              ┌──────────────────────────────────────┐
              │  relay  (packages/relay)             │
              │  sessions · presence · draw          │
              │  temporary grants · validation       │
              └───────────────┬──────────────────────┘
                              │ WS, dialled *outbound* by the device
                              ▼
              ┌──────────────────────────────────────┐
              │  Norns                               │
              │  Lua 5.4 running                     │
              │  packages/norns-script/lib/engine.lua│
              │  clamp · slew · map · kill · screen  │
              └───────────────┬──────────────────────┘
                              ▼
                      MIDI CC  /  OSC
```

| Package | What it is |
| --- | --- |
| `packages/protocol` | Wire types, frame validation, and the smoothing maths shared by both sides |
| `packages/relay` | HTTP + WebSocket relay, session state machine, and the three web UIs |
| `packages/norns-script` | **The deployable Norns script.** Ships to `~/dust/code/stagein/` |
| `packages/norns-sim` | The emulator harness: fake screen, encoders, keys, MIDI, outbound socket |

### The Norns is a real Lua script — the same one that deploys

`packages/norns-script/lib/engine.lua` is executed by a genuine Lua 5.4 interpreter (`wasmoon`, Lua
compiled to WebAssembly — no system Lua, no native build) and uses the ordinary Norns idioms:
`init()`, `redraw()`, `enc(n, d)`, `key(n, z)`, `screen.*`, `params:add`, `metro.init`,
`midi.connect`.

Crucially the simulator **mounts that file out of the deployable package** rather than keeping a copy,
so there is no second version to drift. A passing rehearsal says something about the hardware.

```
packages/norns-script/          → ~/dust/code/stagein/     runs on the device
  stagein.lua                       stagein.lua            entry point matron loads
  lib/engine.lua                    lib/engine.lua         ← also run by the simulator
  lib/json.lua                      lib/json.lua           ← also run by the simulator
  lib/relay_osc.lua                 lib/relay_osc.lua      device transport
  bridge/stagein_bridge.py          bridge/…               companion holding the link

packages/norns-sim/                                        simulator only
  lua/norns_shim.lua                fake matron runtime
  lua/boot.lua                      emulator entry point
  src/*.ts                          fake hardware
```

`engine.lua` holds every musical decision: authorisation, clamping, slew, speed cap, CC mapping,
safe-value return, the kill switch, the 128×64 display. It reaches outside itself through exactly
**one seam** — five guarded references that fall back to matron's own facilities when the emulator's
`_host_*` globals are absent:

```lua
local now_ms = _host_now or function() return util.time() * 1000 end
local ARM_MODE = _host_arm_mode or 'latch'
local MIDI_BACKEND = _host_midi_backend or 'midi'
```

`mise run norns:check` fails if anything outside that seam creeps in — the regression that would
quietly make the simulator prove nothing about the device.

### Why the device needs a companion process

matron ships no WebSocket client, so PRD §18's "small companion service" is real:

```
engine  --OSC /stagein/out-->  bridge  --WS-->  relay
engine  <--OSC /stagein/in--   bridge  <--WS--  relay
                               bridge  --OSC /stagein/{up,down}--> engine
```

`bridge/stagein_bridge.py` is **Python 3 standard library only** — a hand-rolled RFC 6455 client and
OSC codec. A Norns cannot be assumed to have pip access or a toolchain, and a dependency that fails
to install on the day of a show is a dependency that does not exist. `norns:check` asserts the import
list stays inside the stdlib.

The engine never learns which transport it has: the simulator installs its own `relay` table, the
device gets `lib/relay_osc.lua`. Losing the link drops the grant, which makes the engine glide back
to the safe values on its next tick (PRD §7).

The front panel at `http://localhost:8081` renders the display list the script emits, so what you see
is what the device would draw. E1–E3 and K1–K3 are clickable, and bound to <kbd>q</kbd>/<kbd>w</kbd>
<kbd>e</kbd>/<kbd>r</kbd> <kbd>t</kbd>/<kbd>y</kbd> and <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd>.

### Where the safety actually lives

PRD §7 asks for the musical limits to hold on the device *even though the relay already validated*.
Both layers are implemented, and the acceptance test proves each one separately:

| Barrier | Enforced by | Proven by |
| --- | --- | --- |
| Schema, bounds, token, expiry, replay, rate | relay | §4, §5 checks |
| Arming gate, stale frames, clamp, slew, speed cap, range | `stagein.lua` | §5b checks (device disarmed → relay still forwards, device refuses) |
| Kill | both, independently | §6 checks |

The device-side barrier is only observable when the two disagree, which is why the test disarms the
device and confirms the relay keeps forwarding while the output stays parked on the safe value.

---

## Verifying the MIDI output

There is no soundcard in a container, so the two CC streams are made auditable instead:

- **stdout** — `[midi] ch1 CC74 = 83`, visible in `mise run logs`.
- **the front panel** — a live MIDI monitor.
- **a JSONL journal** — `MIDI_LOG_FILE`, mounted at `/data/midi.jsonl` under compose:

  ```bash
  docker compose exec norns tail -f /data/midi.jsonl
  ```

On `SIGTERM` — `docker compose stop`, or Ctrl-C — the script's `cleanup()` runs and emits the safe
values before the process exits, so stopping the stack never leaves the rig parked on a participant's
last gesture:

```
[norns] SIGTERM — returning to safe values and exiting
[midi] ch1 CC74 = 64
[midi] ch1 CC91 = 10
```

Other backends, via `MIDI_BACKEND`:

| Value | Effect |
| --- | --- |
| `log` | stdout + panel + journal (default) |
| `osc` | UDP OSC to `OSC_HOST:OSC_PORT`, for SuperCollider or Max |
| `midi` | a real MIDI port — needs the optional `easymidi` dependency, so run it outside Docker |

```bash
pnpm --filter @stagein/norns-sim add easymidi   # native build, on the host
MIDI_BACKEND=midi mise run norns
```

---

## Norns controls (PRD §12)

| Control | Action |
| --- | --- |
| E1 | preset (`filter+delay`, `filter+reverb`, `texture+space`) |
| E2 | control duration, 10–60 s |
| E3 | macro intensity — squeezes both ranges toward their midpoint, 0 % = no audible movement |
| K1 | switch page / help |
| K2 | open registrations, then fire the draw |
| K3 | arm; double-tap kills |

`ARM_MODE=deadman` swaps K3 for the literal PRD reading: armed only while held, releasing kills. The
default `latch` is the stage-practical one — nobody holds a button for a 30-second take.

Encoder changes are sent to the relay as configuration patches, so the host console and the device
stay in sync in both directions.

---

## Deploying to a Norns

```bash
mise run norns:check                          # 26 checks, no hardware needed
mise run norns:bridge-test                    # 11 checks, needs a running relay
NORNS=we@norns.local mise run norns:deploy    # preflight, then install
```

`norns:deploy` checks the device before copying anything — ssh reachable, `python3` present, `setsid`
present, `~/dust/code` present, `tar` present — then streams the tree in, verifies all five files
landed, and compiles the bridge **on the device**. A failure on the ground is cheap; the same failure
during a soundcheck is not.

Then, on the Norns:

1. `SELECT > stagein`. The first load writes `~/dust/data/stagein/config.json` and says so on screen.
2. `mise run norns:config` — fill in `relay_ws_url`, `session`, and the `norns_token` from the host
   console. The bridge refuses to start while the token is still the placeholder, rather than
   retrying against a relay that will reject it.
3. Reload the script, then press **K3** to arm. `mise run norns:logs` tails the bridge.

The token lives in `~/dust/data`, never in the script directory, so sharing the script never shares
the credential.

## Acceptance

Three suites, 82 checks. Each covers a layer the others cannot reach:

| Suite | Checks | Needs | Covers |
| --- | --- | --- | --- |
| `mise run smoke` | 45 | running stack | the product: PRD §14 criteria, end to end |
| `mise run norns:check` | 26 | nothing | the bundle is complete, parses, and boots |
| `mise run norns:bridge-test` | 11 | running relay | the device's OSC↔WebSocket transport |

`mise run smoke` drives the live stack — the real relay over its three WebSocket surfaces, and the
real Lua script through its front panel — and checks the MVP criteria of PRD §14:

```
0 · stack reachable                              3 checks
1 · host console (FR-01, FR-02, FR-14)           5
2 · Norns arming gate (FR-12)                    2
3 · lottery (FR-03…FR-06)                        7
4 · authorisation (FR-07, §11)                   3
5 · gesture → MIDI CC (FR-09…FR-11, NFR-01)      8
5b · the device enforces its own limits (NFR-07) 3
6 · kill switch (FR-12, <100 ms)                 7
7 · automatic expiry (FR-08)                     4
8 · disconnection (FR-13, §16)                   2
9 · stack left usable                            1
                                                45 checks
```

It asserts, among other things: exactly one winner is drawn; only the winner's token works; a
non-winner holding that token is still refused; out-of-range coordinates are clamped rather than
passed through; replayed sequence numbers are dropped; two distinct CC numbers are emitted and every
value stays inside 0–127 and inside the configured range; the kill reaches the device in under 100 ms
and nothing gets past it; the window ends on its own within 500 ms of the configured duration; and a
dropped phone sends the output back to the safe value.

The test rewrites the demo session's state as it goes, and resets it at the end. Do not run it
against a live performance.

### Are we sure we can deploy?

The three suites above answer "does it work". They do not answer "is the thing we would ship
complete", because they all run against a working tree full of build output. That needs a separate
check — a **clean-room rebuild**: export only the files a fresh clone would contain, build from that,
and run acceptance against the result.

```bash
CLEAN=$(mktemp -d)
git ls-files -co --exclude-standard -z | tar --null -T - -cf - | tar -xf - -C "$CLEAN"
cd "$CLEAN" && PORT=8090 NORNS_PORT=8091 PUBLIC_BASE_URL=http://localhost:8090 \
  docker compose -p stagein-clean up -d --build
SMOKE_RELAY_URL=http://localhost:8090 SMOKE_PANEL_URL=http://localhost:8091 mise run smoke
```

This is what caught the image not copying `pnpm-lock.yaml`: builds passed while silently re-resolving
every dependency from the registry, so an unrelated upstream release could have changed what shipped
without a single line of our code changing. The build now uses `--frozen-lockfile`, which makes the
image a function of the committed lockfile.

What each layer of evidence does and does not cover:

| Question | Answered by | Not covered |
| --- | --- | --- |
| Does the product work? | `smoke`, against containers | real mobile networks, real audiences |
| Is the shippable file set complete? | clean-room rebuild | — |
| Is the image reproducible? | `--frozen-lockfile` + committed lockfile | no digest pinning of the base image |
| Is the Norns bundle complete? | `norns:check` | matron's `include()` and `osc.event` delivery |
| Does the device transport work? | `norns:bridge-test` | real MIDI ports, this Norns' python3 |
| Will it install on *that* Norns? | `norns:deploy` preflight | — |

---

## Configuration

Everything is environment-driven; `.env` is read by both `mise` and `docker compose`.

### Relay

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `8080` | |
| `PUBLIC_BASE_URL` | `http://localhost:8080` | Baked into join links and QR codes — **set this for a real test** |
| `BOOTSTRAP_SESSION_ID` | `DEMO01` | Session created at startup; empty disables it |
| `BOOTSTRAP_HOST_TOKEN` | `dev-host-token-change-me` | **Change before exposing the relay** |
| `BOOTSTRAP_NORNS_TOKEN` | `dev-norns-token-change-me` | **Change before exposing the relay** |
| `MAX_PARTICIPANTS` | `200` | NFR-03 |
| `IDLE_TIMEOUT_MS` | `8000` | Presence expiry (FR-04) |
| `RECONNECT_WINDOW_MS` | `20000` | How long a device may reappear and keep its entry (NFR-05) |

### Norns simulator

| Variable | Default | Notes |
| --- | --- | --- |
| `NORNS_PORT` | `8081` | Front panel |
| `RELAY_WS_URL` | `ws://localhost:8080/ws/norns` | Outbound only |
| `STAGEIN_SESSION` | `DEMO01` | Also re-pairable from the panel at runtime |
| `STAGEIN_NORNS_TOKEN` | `dev-norns-token-change-me` | |
| `ARM_MODE` | `latch` | or `deadman` |
| `MIDI_BACKEND` | `log` | `log` · `osc` · `midi` |
| `MIDI_LOG_FILE` | — | JSONL journal of every emitted CC |

Per-session musical settings — duration, activation delay, mobile rate, slew, speed cap, CC numbers,
channels, ranges, safe values, inversion, pad start, end behaviour, re-win — live in the session, are
edited from the host console or the encoders, and are clamped server-side to the bounds in
`packages/protocol/src/session.ts`. A host cannot widen the envelope past what PRD §8 allows.

---

## Tasks

| Task | What it does |
| --- | --- |
| `mise run up` / `down` / `logs` | docker compose lifecycle |
| `mise run dev` | relay + simulator locally, prefixed output, watch mode |
| `mise run relay` / `norns` | one at a time |
| `mise run build` / `typecheck` / `clean` | TypeScript |
| `mise run demo` | play a scripted performance against the running stack |
| `mise run smoke` | the acceptance check |
| `mise run urls` | demo URLs and LAN hints |
| `mise run norns:package` | build the device bundle into `dist/norns` |
| `mise run norns:check` | is the bundle deployable? (no hardware) |
| `mise run norns:bridge-test` | prove the device transport (needs a relay) |
| `mise run norns:deploy` | preflight + install on a Norns |
| `mise run norns:config` / `norns:logs` | edit the device config / tail the bridge |

---

## What is deliberately not here

Tracking the PRD's non-objectives and phase plan, this is **P1 — MVP privé**, so the following are
out of scope: collaborative sequencing, master volume control, native apps, monetisation, persistent
profiles, several simultaneous winners, and the optional Twitch connector (FR-16, *Could*).

Known gaps to close before a public pilot (**P2**):

- **Nothing is committed and there is no CI.** Every verification above is run by hand. Until they run
  on a pipeline against a tagged revision, "it passed" is a statement about one laptop at one moment.
  This is the largest remaining deployment risk, and it is process, not code.
- **The default tokens are live defaults.** `docker compose` falls back to `dev-host-token-change-me`,
  so an operator who forgets `.env` gets a relay anyone can drive. The relay does not refuse to start
  on a placeholder token the way the Norns bridge does — it should.
- **No TLS.** NFR-06 wants TLS end to end; run behind a reverse proxy or a tunnel. The relay speaks
  plain HTTP and trusts `X-Forwarded-For`.
- **The runtime image ships devDependencies** (TypeScript and friends): correct, but larger than it
  needs to be, and a wider surface than a production image should carry.
- **The base image is a floating tag** (`node:22-alpine`), so a rebuild months from now is not the
  same image. Pin by digest before a pilot matters.
- **State is in memory.** Restarting the relay drops every session. Fine for one set, not for uptime
  targets across a stream.
- **`POST /api/sessions` is unauthenticated**, rate-limited per IP only. Put it behind auth before
  the relay is reachable from the internet.
- **The 200-participant target is untested at scale.** The mechanism is there (per-connection rate
  limiting, one 50 ms tick per session, diff-free broadcast) but the figure is not measured.
- **Latency is measured on a LAN.** P95 came out at single-digit milliseconds here; NFR-01's 250 ms
  budget only means something over real mobile networks.
- **`padStart: 'last'`** reads the Norns' current output, so it needs the device online to be exact.

## Open PRD questions, and what the code does today

PRD §17 leaves five decisions open. Each is implemented as a configuration flag rather than a
hardcoded guess, so a rehearsal can settle them:

| Question | Current default | Flag |
| --- | --- | --- |
| Can the winner re-enter the next draw? | no | `winnerCanRewin` |
| Is a pseudonym required to join? | a stage name is assigned, editable before joining | — |
| Where does the pad start? | centre | `padStart` (`center` · `safe` · `last`) |
| Which device and which CC for the pilot? | CC 74 filter, CC 91 delay, channel 1 | `macros.x` / `macros.y` |
| Manual or automatic draw? | manual (host or K2), automatic redraw only after a no-show | `autoRedrawOnNoShow` |
| Keep statistics between shows? | no — nothing is persisted | — |
