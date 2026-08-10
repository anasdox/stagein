# StageIn — runbook

Written for **one person**, who is also the artist or standing next to them. No
colleague to call, no second machine, no on-call rotation. So every procedure
here is a single command you can type from memory, and every failure has an
answer that fits on one line.

If you only remember three things:

```bash
mise run show:preflight    # before doors — refuses to say GO when it should not
mise run show:status       # one glance, any time
mise run show:panic        # stop everything, now
```

---

## The day before

**1. Generate real tokens.** The shipped ones are public — they are in the
repository.

```bash
mise run show:secrets
```

It writes new tokens to `.env`, keeps the old file as `.env.bak`, and tells you
the two follow-ups: restart the stack, and put the new Norns token on the device.

**2. Point the QR at an address phones can reach.** This is the single most
common way the evening fails: the QR carries `localhost`, and nobody can join.

The join link is the bare domain — `https://stagein.betafactory.co` — with no
session code and no key. It is short enough to say into a microphone, small
enough to make a QR that survives a dark room, and it does not change when the
relay restarts. Print it, project it, put it on a sticker: it keeps working.

The rotating key still exists, off by default, and the host console turns it on
per session (*Clé dans le lien*). Use it when the link circulates somewhere you
cannot see — a stream chat — where being able to revoke it means something.
Never with a printed code: rotating would kill every copy already in the room.

```bash
# find the address, then put it in .env
mise run urls
# PUBLIC_BASE_URL=http://192.168.1.42:8080
```

**3. Put the script on the Norns.**

```bash
NORNS=we@norns.local mise run norns:deploy
mise run norns:config      # relay_ws_url, session, norns_token
```

The deploy preflights the device first — ssh, `python3`, `setsid`, `~/dust/code`
— and copies nothing if any of that is missing. A failure here is cheap.

**4. Choose the MIDI port on the device.** matron has sixteen virtual ports and
sends to exactly one; a port with nothing behind it swallows every CC without a
word. The script picks the lowest port that actually holds a device and names it
in **PARAMS > midi out** (`1 MicroFreak`, `2 none`, `3 Launchpad (absent)` for a
port that remembers a device no longer plugged in). Pick the instrument you mean:
the lowest port is often a controller, not the synth. If the screen shows
**NO MIDI OUT**, no port is mapped at all — map one in SYSTEM > DEVICES > MIDI.

**5. Decide the two macros with the artist.** Defaults are CC 74 filter and
CC 91 delay on channel 1, ranges 30–100 and 0–70. Change them from the host
console or with E1/E3 on the device. **Never map the master volume.**

---

## In the venue, T-30

```bash
mise run show:start        # brings the stack up and prints every URL
mise run show:preflight    # go / no-go
```

`preflight` exits non-zero when it says NO-GO, and it blocks on the things that
actually ruin an evening:

| It says | It means |
| --- | --- |
| `PUBLIC_BASE_URL points at localhost` | the QR leads nowhere; no one can join |
| `the host token is the shipped default` | anyone who reads the repo can drive your show |
| `relay is not answering` | nothing is running |
| `the Norns is not connected` | the bridge is down — `mise run norns:logs` |
| `a kill is still active` | left latched from last time; nothing will pass |
| `nothing is behind MIDI port N` | the device is sending into an empty virtual port — silence all set |

And it warns, without blocking, about the two silent failures:

- **the Norns is not armed** — the ritual runs, the winner moves the pad, and
  nothing comes out. Press **K3**.
- **the Norns is only logging MIDI** — same silence, different cause. Set
  `MIDI_BACKEND=midi` on the device.

The device also reports which virtual port it sends through, so the preflight
blocks on an empty one rather than leaving you to discover it. The same fact is
visible in three other places: **NO MIDI OUT** across the bottom left of the
device screen, *port MIDI* in the host console, and `NO MIDI OUT` in
`mise run show:status --watch` — which is the one that catches an interface
unplugged mid-set. A device running a script older than this reports no port at
all; the preflight says so and asks for a redeploy rather than guessing.

Then, with a phone in your hand, **scan the QR yourself and join once**. Nothing
in this repository can prove a phone on the venue's network reaches the relay.
That test takes fifteen seconds and is the only one that matters.

```bash
mise run show:qr           # the QR in the terminal, to check or to show
```

Someone whose camera will not scan can type the domain instead. That is the
point of the short link.

---

## During the set

Open the host console on your laptop (`mise run urls` prints the link with the
token). Everything below also works from the terminal, which is faster when the
browser is buried behind a DAW.

| You want | Command | Also |
| --- | --- | --- |
| see where things stand | `mise run show:status --watch` | host console |
| open registrations | `mise run show:reopen` | K2 on the Norns |
| draw a winner | `mise run show:draw --in 5` | K2 again, or the console |
| stop everything | `mise run show:panic` | **space bar** in the console, **K3 double-tap** on the device |

A draw that refuses now says why, on the device screen and in the console —
*nobody entered*, or *no draw from ACTIVE* if a window is still running. You no
longer have to reset the session to get another draw: the previous winner is
skipped while somebody else is entered, and drawn again when they are the only
one left, which is what happens in a rehearsal with one phone.

The kill has three independent paths on purpose. The device one keeps working
when the relay is gone; the relay one keeps working when the device screen is
out of reach. Use whichever is closest to your hand.

After a kill, `mise run show:reopen` clears it and restarts the cycle.

---

## When it breaks

**Nobody can join.** Almost always the address. `mise run show:qr` — if it warns
about localhost, that is the answer. Otherwise, from a phone on the venue Wi-Fi,
open the join URL by hand. If that fails, the venue network is isolating clients
(common on guest Wi-Fi) and no configuration will fix it: tether the relay
machine and the phones to the same hotspot.

**The Norns went offline mid-set.** The music is unaffected — the device holds
its own limits and glides back to the safe preset on its own. Fix it between
draws, not during one:

```bash
mise run norns:logs        # the bridge says why it dropped
```

It reconnects by itself with backoff. If it does not, reload the script on the
device (SELECT > stagein), which restarts the bridge.

**Sound went somewhere ugly.** `mise run show:panic`, then reduce the range
before rearming: **E3** on the device narrows both macros toward their midpoint.
0 % means no audible movement at all — a safe place to restart from.

**Someone put something on the screen.** The name filter runs in the relay, but
no blocklist is complete. Hide every name instantly from the host console
(*Pseudos sur la vue publique → masqués*), and block the device from the
participant list. The public view stops showing names within one frame; the
relay stops sending them at all.

**The whole relay is gone.** The Norns is musically autonomous — it is already
back on the safe preset and the set continues. Restart when you have a moment:

```bash
mise run show:start
```

Sessions are in memory, so everyone re-joins. That is a known limitation, not a
malfunction.

---

## After

```bash
mise run show:archive      # BEFORE show:stop — it reads from the containers
mise run show:stop
```

`archive` saves the relay log, the device log and the MIDI journal to
`archive/<timestamp>/`. It reports what it actually captured and exits non-zero
if something is missing — a partial archive never reads as a complete one.

That journal is what tells you afterwards exactly which CC values the rig was
sent, and when. Worth keeping for any set where something sounded wrong.

`show:stop` is safe: both services emit the safe CC values on the way out, so
stopping the stack never leaves the rig on a participant's last gesture.

---

## Hosting the relay on a public VPS

The Norns dials **out**, so the relay is the only piece that needs a public
address — and once it has one, the QR works from any network, not just the
venue's Wi-Fi.

```bash
mise run vps:check      # read-only: access, docker, DNS, ports, firewall
mise run vps:setup      # once: docker + ufw limited to 22/80/443
mise run vps:deploy     # ship, build, start, verify over HTTPS
```

TLS, ports 80/443 and the firewall belong to the **machine**, not to this
project — they live in the `vps-infra` repository, which runs a shared edge so
several projects can share one VPS. StageIn only declares the hostname it wants:

```yaml
    networks: [edge]
    labels:
      caddy: stagein.betafactory.co
      caddy.reverse_proxy: "{{upstreams 8080}}"
```

A certificate is obtained automatically for that name, and `wss://` comes with
it. Bring the edge up first (`mise run proxy:up` in `vps-infra`), then deploy
here.

The name is a subdomain of the wildcard zone that machine serves, so there is no
DNS step. Do **not** use the hostname OVH assigns to the VPS: it belongs to the
machine, the edge answers it with a 404, and claiming it here would collide with
that and take the relay offline.

Three things differ from the laptop stack, all deliberate:

- **The relay is not published on any port.** The shared edge is the only way
  in, which is also what lets other projects share the machine.
- **The Norns simulator is absent.** Its front panel has no authentication and
  can arm and kill the rig — it must never face the internet. The real device,
  or the simulator on your own machine, dials in from wherever it is.
- **Session creation is closed** (`NODE_ENV=production`). Otherwise the endpoint
  hands a host token and a Norns token to anybody who asks. Sessions come from
  configuration.

Tokens are generated **on the server** on first deploy, into
`~/stagein/deploy/.env`, and never touch this repository. `vps:deploy` prints
them once, along with the Norns settings to enter.

Point the device at it:

```
relay_ws_url  wss://<your-vps-hostname>/ws/norns
```

Then the venue only needs outbound internet — no port forwarding, no captive
portal fight, no dependence on the house Wi-Fi reaching your laptop.

---

## Checking the code still works

Four suites, none of which need hardware:

```bash
mise run ui-check          # the participant page renders and behaves
mise run norns:check       # the device bundle is complete and boots
mise run smoke             # the whole ritual, against a running stack
mise run norns:bridge-test # the device transport, against a running stack
```

Run all four after any change. `ui-check` and `norns:check` need nothing running
and take a second; the other two need `mise run show:start` first.

---

## What no command here can tell you

Stated plainly, because a runbook that implies more coverage than it has is
worse than none:

- **Whether phones reach the relay on that venue's network.** Only a phone can
  answer that. Do it at T-30.
- **Whether the Norns makes sound.** The stack proves CC values leave the device;
  it cannot hear the rig. Check with your ears before doors.
- **Whether 200 people work.** The mechanism is there and untested at scale.
- **Whether the bridge runs on your particular Norns image.** `norns:deploy`
  checks `python3` exists and compiles the bridge on the device, which is most of
  it — but it has never run on real hardware.
