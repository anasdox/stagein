-- StageIn — norns client
--
-- Join the performance. Shape the moment.
--
-- Receives validated X/Y from the StageIn relay and turns it into two MIDI CC
-- (or OSC) values. Every musical limit is enforced here, on the device, even
-- though the relay already validated the same values (PRD §7, NFR-07): clamp,
-- slew, speed cap, authorisation window, stale-frame rejection, kill switch.
--
--   E1  preset          K1  page / help
--   E2  control length  K2  open registrations, then fire the draw
--   E3  macro intensity K3  ARM  (double-tap or release = KILL)

-- The loader supplies json: matron resolves it with include(), the emulator
-- mounts it on package.path. One seam, so this file needs no environment test.
local json = _stagein_json or require('json')

-- Time, logging and output default to matron's own facilities; the emulator
-- overrides them by injecting `_host_*` globals before this file loads. Keeping
-- the indirection in one place is what lets this file be byte-identical on the
-- device and under the simulator.
local now_ms = _host_now or function() return util.time() * 1000 end

local function log(level, message)
  if _host_log then
    _host_log(level, message)
  else
    print('stagein [' .. level .. '] ' .. message)
  end
end

local ARM_MODE = _host_arm_mode or 'latch'
local MIDI_BACKEND = _host_midi_backend or 'midi'

--- Engine rate. 60 Hz means a kill lands in at most ~17 ms, well inside the
--- 100 ms the acceptance criteria allow.
local ENGINE_HZ = 60
local STATUS_HZ = 5
local REDRAW_HZ = 15
--- A frame older than this never reaches the mapping stage (PRD §9.1).
local MAX_FRAME_AGE_MS = 750
local DOUBLE_TAP_MS = 350
--- How long a message from the relay stays on the screen. Long enough to read
--- from arm's length, short enough not to sit on top of the arm/kill banner.
local NOTICE_MS = 3500

-- The virtual port every value leaves through, and which one it is. matron hands
-- out a port whether or not a device sits behind it, so `out` being non-nil
-- proves nothing about anything hearing us — that is what port_live() is for.
local out = nil
local out_port = 1

-- ---------------------------------------------------------------------------
-- state
-- ---------------------------------------------------------------------------

local s = {
  online = false,
  session = '------',
  session_state = 'CLOSED',
  entrants = 0,
  connected = 0,
  winner = nil,
  remaining_ms = nil,
  countdown_ms = nil,

  armed = false,
  killed = false,
  holding = false,

  grant = nil, -- { id = string, expires_at = relay-clock ms }
  last_seq = -1,
  rejected = 0,
  accepted = 0,

  target_x = 0.5,
  target_y = 0.5,
  out_x = 0.5,
  out_y = 0.5,
  cc_x = -1,
  cc_y = -1,

  clock_samples = {},
  clock_offset = nil, -- relay clock - local clock
  last_msg_at = nil,
  last_engine_at = nil,

  page = 1,
  k3_last_press = 0,
  kill_started_at = nil,
  notice = nil, -- transient message from the relay
  notice_until = nil,
}

--- Mirrors the relay's session config. Defaults match PRD §8 so the device is
--- musically safe even before the relay ever answers.
local cfg = {
  control_ms = 30000,
  slew_ms = 250,
  max_rate = 2.0,
  end_behavior = 'return-safe',
  preset = 'filter+delay',
  x = { name = 'Filter', cc = 74, channel = 1, min = 30, max = 100, invert = false, safe = 64, osc = '/stagein/filter' },
  y = { name = 'Delay', cc = 91, channel = 1, min = 0, max = 70, invert = false, safe = 10, osc = '/stagein/delay' },
}

--- Snapshot of the ranges the preset defines, so E3 scales from the preset
--- rather than compounding on its own previous output.
local base = { x = { min = 30, max = 100 }, y = { min = 0, max = 70 } }

-- ---------------------------------------------------------------------------
-- mapping maths (mirror of packages/protocol/src/dsp.ts)
-- ---------------------------------------------------------------------------

local function clamp01(v)
  return util.clamp(v, 0, 1)
end

--- One-pole ramp toward `target`, then a hard cap on distance covered per
--- second. Both stages are required: the ramp removes steps, the cap makes a
--- teleporting input (packet loss, a finger jumping) impossible to hear.
local function slew_step(current, target, dt, slew_ms, max_rate)
  if dt <= 0 then return current end
  local tau = math.max(slew_ms, 1) / 1000 / 3
  local alpha = 1 - math.exp(-dt / tau)
  local next_v = current + (target - current) * alpha
  local max_delta = max_rate * dt
  next_v = util.clamp(next_v, current - max_delta, current + max_delta)
  if math.abs(target - next_v) < 1 / 512 then next_v = target end
  return clamp01(next_v)
end

local function map_to_cc(norm, macro)
  local lo = math.min(macro.min, macro.max)
  local hi = math.max(macro.min, macro.max)
  local n = clamp01(norm)
  if macro.invert then n = 1 - n end
  return math.floor(util.clamp(lo + n * (hi - lo), 0, 127) + 0.5)
end

local function cc_to_norm(cc, macro)
  local lo = math.min(macro.min, macro.max)
  local hi = math.max(macro.min, macro.max)
  if hi == lo then return 0 end
  local n = clamp01((util.clamp(cc, lo, hi) - lo) / (hi - lo))
  if macro.invert then n = 1 - n end
  return n
end

local function safe_position()
  return cc_to_norm(cfg.x.safe, cfg.x), cc_to_norm(cfg.y.safe, cfg.y)
end

-- ---------------------------------------------------------------------------
-- output
--
-- matron exposes sixteen virtual MIDI ports, mapped to whatever is plugged in
-- from SYSTEM > DEVICES > MIDI. A port keeps the *name* of the last device that
-- sat there long after that device is gone, so the name proves nothing: only
-- `device` does, and `connected` is matron's own mirror of it. Sending to an
-- empty port is a silent no-op inside norns' vport wrapper — every value
-- accepted, mapped, displayed and dropped, which is the quietest way to lose a
-- show.
-- ---------------------------------------------------------------------------

local function port_at(i)
  return midi.vports and midi.vports[i] or nil
end

--- Is a device actually listening on port `i`? `gone` is the device matron is in
--- the middle of removing, which it has not unmapped yet (see watch_devices).
local function port_live(i, gone)
  local port = port_at(i)
  if not port then return false end
  if gone and gone.port == i then return false end
  return port.device ~= nil or port.connected == true
end

local function port_label(i, gone)
  local port = port_at(i)
  local name = (port and port.name) or 'none'
  -- "never mapped" and "mapped to something that is not here" look identical in
  -- a menu and sound identical on stage. Say which one this is.
  if name ~= 'none' and not port_live(i, gone) then name = name .. ' (absent)' end
  return string.format('%d %s', i, name)
end

local function port_labels(gone)
  local names = {}
  for i = 1, 16 do
    names[i] = port_label(i, gone)
  end
  return names
end

--- Rewrite the option list in place, so the menu the operator scrolls through
--- still tells the truth after something is plugged in or pulled out. matron
--- copies the table it was given at add time, hence the lookup.
local function refresh_port_labels(gone)
  local param = params and params.lookup_param and params:lookup_param('midi_device')
  if not param or not param.options then return end
  local names = port_labels(gone)
  for i = 1, 16 do
    param.options[i] = names[i]
  end
end

--- The lowest port with a device behind it, or 1 when nothing is plugged in yet.
--- matron drops each device it finds into the lowest free port, so this is
--- almost always 1 — and "almost always" is not a thing to discover on stage.
local function first_live_port()
  for i = 1, 16 do
    if port_live(i) then return i end
  end
  return 1
end

local function connect_midi(index)
  out = midi.connect(index)
  out_port = index
  -- The new port has never heard the current values. Marking both axes dirty
  -- makes the next tick resend them, so a port change is audible immediately
  -- instead of at the participant's next movement.
  s.cc_x, s.cc_y = -1, -1
  if port_live(index) then
    log('info', 'midi out: ' .. port_label(index))
  else
    log('warn', 'midi out: ' .. port_label(index) .. ' — nothing mapped, no MIDI leaves the device')
  end
end

--- matron calls these globals when a MIDI device appears or disappears, and
--- resets them itself when it clears a script, so nothing leaks between scripts.
--- Report, never re-route: quietly following whatever was just plugged in could
--- send a participant's gestures to the wrong instrument, which is worse than
--- the silence it would fix.
local function watch_devices()
  midi.add = function(dev)
    -- matron has already re-mapped the ports by the time it calls this.
    refresh_port_labels()
    log('info', string.format('midi device %s — out is %s', tostring(dev and dev.name), port_label(out_port)))
  end
  midi.remove = function(dev)
    -- It unmaps them *after* this one, hence passing the departing device along.
    refresh_port_labels(dev)
    log('warn', string.format('midi device %s unplugged — out is %s', tostring(dev and dev.name), port_label(out_port, dev)))
  end
end

local function emit(macro, value, axis)
  if MIDI_BACKEND == 'osc' then
    osc.send(nil, macro.osc, { value })
  else
    -- `out` is nil until init() connects MIDI. cleanup() can run before that
    -- (a previous load crashed mid-init) and an error here stops matron from
    -- freeing this script's metros — orphans then repaint stale state forever.
    if not out then return end
    out:cc(macro.cc, value, macro.channel)
  end
  if axis == 'x' then s.cc_x = value else s.cc_y = value end
end

-- ---------------------------------------------------------------------------
-- authorisation
-- ---------------------------------------------------------------------------

local function relay_now()
  return now_ms() + (s.clock_offset or 0)
end

--- The single gate every value passes through. Four independent reasons to
--- refuse: no kill, device armed, a grant exists, the grant has not expired.
local function authorised()
  if s.killed then return false end
  if not s.armed then return false end
  if not s.grant then return false end
  if relay_now() > s.grant.expires_at then return false end
  return true
end

-- ---------------------------------------------------------------------------
-- engine
-- ---------------------------------------------------------------------------

local function engine_tick()
  local now = now_ms()
  local dt = s.last_engine_at and (now - s.last_engine_at) / 1000 or 1 / ENGINE_HZ
  s.last_engine_at = now
  if dt > 0.25 then dt = 0.25 end -- a host stall must not become a jump

  local tx, ty
  if authorised() then
    tx, ty = s.target_x, s.target_y
  elseif cfg.end_behavior == 'hold' and s.holding and not s.killed then
    -- Freeze where the participant left it (PRD §8, "maintien selon preset").
    tx, ty = s.out_x, s.out_y
  else
    -- Glide back to the preset's safe value (FR-13).
    tx, ty = safe_position()
  end

  s.out_x = slew_step(s.out_x, tx, dt, cfg.slew_ms, cfg.max_rate)
  s.out_y = slew_step(s.out_y, ty, dt, cfg.slew_ms, cfg.max_rate)

  local cx = map_to_cc(s.out_x, cfg.x)
  local cy = map_to_cc(s.out_y, cfg.y)
  if cx ~= s.cc_x then emit(cfg.x, cx, 'x') end
  if cy ~= s.cc_y then emit(cfg.y, cy, 'y') end

  if s.kill_started_at then
    -- now_ms is a float on real hardware (util.time() * 1000); %d would throw.
    log('warn', string.format('KILL applied in %d ms', math.floor(now - s.kill_started_at + 0.5)))
    s.kill_started_at = nil
  end
end

-- ---------------------------------------------------------------------------
-- kill switch (FR-12)
-- ---------------------------------------------------------------------------

local function do_kill(source)
  if s.killed then return end
  s.killed = true
  s.armed = false
  s.grant = nil
  s.holding = false
  s.kill_started_at = now_ms()
  if source ~= 'relay' then relay.send({ t = 'kill' }) end
  log('warn', 'KILL (' .. source .. ')')
end

local function do_arm()
  s.killed = false
  s.armed = true
  relay.send({ t = 'arm' })
  log('info', 'ARMED')
end

local function do_disarm()
  s.armed = false
  log('info', 'disarmed')
end

-- ---------------------------------------------------------------------------
-- relay protocol
-- ---------------------------------------------------------------------------

local function apply_config(c)
  if not c then return end
  local preset_changed = c.preset and c.preset ~= cfg.preset
  cfg.control_ms = c.controlDurationMs or cfg.control_ms
  cfg.slew_ms = c.slewMs or cfg.slew_ms
  cfg.max_rate = c.maxRatePerSec or cfg.max_rate
  cfg.end_behavior = c.endBehavior or cfg.end_behavior
  cfg.preset = c.preset or cfg.preset

  if c.macros then
    for _, axis in ipairs({ 'x', 'y' }) do
      local m = c.macros[axis]
      if m then
        cfg[axis].name = m.name or cfg[axis].name
        cfg[axis].cc = m.cc or cfg[axis].cc
        cfg[axis].channel = m.channel or cfg[axis].channel
        cfg[axis].min = m.min or cfg[axis].min
        cfg[axis].max = m.max or cfg[axis].max
        cfg[axis].safe = m.safe or cfg[axis].safe
        cfg[axis].osc = m.osc or cfg[axis].osc
        if m.invert ~= nil then cfg[axis].invert = m.invert end
      end
    end
  end

  -- Re-anchor the intensity reference whenever the preset itself changes.
  if preset_changed or not base.anchored then
    base.x.min, base.x.max = cfg.x.min, cfg.x.max
    base.y.min, base.y.max = cfg.y.min, cfg.y.max
    base.anchored = true
    params:set('intensity', 100, true)
  end

  -- Lua division always yields a float; matron's number param stores it as-is.
  params:set('duration', math.floor(cfg.control_ms / 1000 + 0.5), true)
end

local function apply_state(st)
  if not st then return end
  s.session = st.sessionId or s.session
  s.session_state = st.state or s.session_state
  s.entrants = st.entrants or 0
  s.connected = st.connected or 0
  s.winner = (st.winnerPseudo ~= json.null) and st.winnerPseudo or nil
  s.remaining_ms = (st.remainingMs ~= json.null) and st.remainingMs or nil
  s.countdown_ms = (st.countdownMs ~= json.null) and st.countdownMs or nil
end

local function note_clock(relay_ts)
  -- offset = relay - local, bounded below by (relay_ts - local_now); the
  -- largest sample seen is the closest estimate that never over-rejects.
  local sample = relay_ts - now_ms()
  local list = s.clock_samples
  list[#list + 1] = sample
  if #list > 20 then table.remove(list, 1) end
  local best = list[1]
  for _, v in ipairs(list) do if v > best then best = v end end
  s.clock_offset = best
end

local function on_xy(m)
  -- Same checks the relay already ran. Duplicated on purpose (NFR-07).
  if not authorised() then
    s.rejected = s.rejected + 1
    return
  end
  if m.grantId ~= s.grant.id then
    s.rejected = s.rejected + 1
    return
  end
  if type(m.seq) ~= 'number' or m.seq <= s.last_seq then
    s.rejected = s.rejected + 1
    return
  end
  if type(m.x) ~= 'number' or type(m.y) ~= 'number' then
    s.rejected = s.rejected + 1
    return
  end

  local age = nil
  if s.clock_offset and type(m.originTs) == 'number' then
    age = relay_now() - m.originTs
    if age > MAX_FRAME_AGE_MS then
      s.rejected = s.rejected + 1
      return
    end
  end

  s.last_seq = m.seq
  s.accepted = s.accepted + 1
  s.target_x = clamp01(m.x)
  s.target_y = clamp01(m.y)
  s.last_msg_at = now_ms()

  if age and age >= 0 then
    relay.send({ t = 'latency', grantId = m.grantId, seq = m.seq, ms = age })
  end
end

function relay_message(m)
  local t = m.t
  if t == 'welcome' then
    s.online = true
    apply_config(m.config)
    apply_state(m.state)
    log('info', 'paired with session ' .. tostring(m.sessionId))
  elseif t == 'config' then
    apply_config(m.config)
  elseif t == 'state' then
    apply_state(m.state)
  elseif t == 'grant' then
    s.grant = { id = m.grantId, expires_at = m.expiresAt }
    s.last_seq = -1
    s.holding = true
    if m.pad then
      s.target_x = clamp01(m.pad.x or 0.5)
      s.target_y = clamp01(m.pad.y or 0.5)
    end
    log('info', 'grant ' .. tostring(m.grantId) .. (s.armed and '' or ' (NOT ARMED — no output)'))
  elseif t == 'xy' then
    on_xy(m)
  elseif t == 'end' then
    s.grant = nil
    s.last_seq = -1
    cfg.end_behavior = m.behavior or cfg.end_behavior
    if cfg.end_behavior ~= 'hold' then s.holding = false end
    log('info', 'control ended: ' .. tostring(m.reason))
  elseif t == 'kill' then
    do_kill('relay')
  elseif t == 'ping' then
    note_clock(m.ts)
    relay.send({ t = 'pong', id = m.id, ts = now_ms() })
  elseif t == 'error' then
    log('error', 'relay: ' .. tostring(m.code) .. ' ' .. tostring(m.message))
    -- On stage the log is invisible. A refused K2 leaves the session state
    -- untouched, which looks exactly like a key that did nothing, so put the
    -- reason on the screen for a few seconds.
    s.notice = tostring(m.message)
    s.notice_until = now_ms() + NOTICE_MS
  end
end

function relay_open()
  s.online = true
  log('info', 'relay connected')
end

function relay_close()
  s.online = false
  s.grant = nil
  s.clock_samples = {}
  s.clock_offset = nil
  -- PRD §7: hold briefly, then glide back to safe. Dropping the grant makes
  -- the engine do exactly that on its next tick.
  log('warn', 'relay disconnected — returning to safe values')
end

--- Where the output is going, for the host console and `show:preflight`. Sent as
--- null under the OSC backend: no virtual port is involved there, and claiming
--- an empty one would be a false alarm.
local function port_status()
  if MIDI_BACKEND == 'osc' then return json.null end
  local port = port_at(out_port)
  return { index = out_port, name = (port and port.name) or 'none', live = port_live(out_port) }
end

local function send_status()
  relay.send({
    t = 'status',
    status = {
      armed = s.armed,
      killed = s.killed,
      preset = cfg.preset,
      targetX = s.target_x,
      targetY = s.target_y,
      outX = s.out_x,
      outY = s.out_y,
      ccX = math.max(0, s.cc_x),
      ccY = math.max(0, s.cc_y),
      midiBackend = MIDI_BACKEND,
      midiPort = port_status(),
      lastMessageAt = s.last_msg_at or json.null,
      rejected = s.rejected,
    },
  })
end

-- ---------------------------------------------------------------------------
-- parameters, driven by the encoders
-- ---------------------------------------------------------------------------

local PRESETS = { 'filter+delay', 'filter+reverb', 'texture+space' }

local function push_intensity(pct)
  -- Squeeze each macro range toward its own midpoint. 100 % = the preset's
  -- full authorised range, 0 % = a single value (no audible movement).
  local patch = { macros = { x = {}, y = {} } }
  for _, axis in ipairs({ 'x', 'y' }) do
    local lo, hi = base[axis].min, base[axis].max
    local mid = (lo + hi) / 2
    local half = (hi - lo) / 2 * (pct / 100)
    patch.macros[axis].min = math.floor(mid - half + 0.5)
    patch.macros[axis].max = math.floor(mid + half + 0.5)
  end
  relay.send({ t = 'config', patch = patch })
end

local function add_params()
  -- First, because nothing else matters if the output goes nowhere.
  params:add({
    id = 'midi_device',
    name = 'midi out',
    type = 'option',
    options = port_labels(),
    default = first_live_port(),
    action = connect_midi,
  })
  params:add({
    id = 'preset',
    name = 'preset',
    type = 'option',
    options = PRESETS,
    default = 1,
    action = function(v)
      local name = PRESETS[v]
      if name and name ~= cfg.preset then relay.send({ t = 'config', patch = { preset = name } }) end
    end,
  })
  params:add({
    id = 'duration',
    name = 'duration',
    type = 'number',
    min = 10,
    max = 60,
    default = 30,
    action = function(v)
      if v * 1000 ~= cfg.control_ms then
        relay.send({ t = 'config', patch = { controlDurationMs = v * 1000 } })
      end
    end,
  })
  params:add({
    id = 'intensity',
    name = 'intensity',
    type = 'number',
    min = 0,
    max = 100,
    default = 100,
    action = push_intensity,
  })
end

-- ---------------------------------------------------------------------------
-- ui
-- ---------------------------------------------------------------------------

local function fmt_secs(ms)
  if not ms then return '--' end
  return string.format('%.0fs', math.max(0, ms) / 1000)
end

--- Pad geometry. Kept clear of the bottom status row: an 8 px glyph on a y=62
--- baseline covers y 56..62, so the box has to stop above that or the ARMED /
--- rejected line becomes unreadable — and that line is the one that matters
--- from a stage (PRD §12).
local PAD = { x = 2, y = 28, size = 26 }

local function draw_pad()
  local x0, y0, size = PAD.x, PAD.y, PAD.size
  screen.level(3)
  screen.rect(x0, y0, size, size)
  screen.stroke()

  -- requested position: hollow marker
  local tx = x0 + s.target_x * size
  local ty = y0 + (1 - s.target_y) * size
  screen.level(6)
  screen.circle(tx, ty, 2.5)
  screen.stroke()

  -- position actually being sent, after slew: filled marker
  local ox = x0 + s.out_x * size
  local oy = y0 + (1 - s.out_y) * size
  screen.level(15)
  screen.circle(ox, oy, 2)
  screen.fill()
end

local function draw_main()
  screen.level(15)
  screen.move(0, 7)
  screen.text('STAGEIN')
  screen.move(128, 7)
  screen.level(s.online and 15 or 3)
  screen.text_right(s.online and s.session or 'OFFLINE')

  screen.level(4)
  screen.move(0, 9)
  screen.line(128, 9)
  screen.stroke()

  screen.level(12)
  screen.move(0, 18)
  screen.text(s.session_state)
  screen.move(128, 18)
  screen.text_right(string.format('%d/%d', s.entrants, s.connected))

  screen.level(8)
  screen.move(0, 26)
  if s.session_state == 'DRAWING' then
    screen.text('drawing ' .. fmt_secs(s.countdown_ms))
  elseif s.winner then
    screen.text(s.winner .. ' ' .. fmt_secs(s.remaining_ms))
  else
    screen.text(cfg.preset)
  end

  draw_pad()

  -- Right of the pad, so nothing overlaps it.
  local text_x = PAD.x + PAD.size + 8
  screen.level(12)
  screen.move(text_x, 36)
  screen.text(string.format('%s %d:%03d', cfg.x.name, cfg.x.cc, math.max(0, s.cc_x)))
  screen.move(text_x, 46)
  screen.text(string.format('%s %d:%03d', cfg.y.name, cfg.y.cc, math.max(0, s.cc_y)))
  screen.level(4)
  screen.move(text_x, 54)
  screen.text(string.format('%ds  %d%%', math.floor(cfg.control_ms / 1000), params:get('intensity')))

  -- Arm/kill banner: the one thing that must be readable from a stage.
  screen.move(128, 62)
  if s.killed then
    screen.level(15)
    screen.text_right('KILLED')
  elseif s.armed then
    screen.level(authorised() and 15 or 8)
    screen.text_right(authorised() and 'ARMED >>' or 'ARMED')
  else
    screen.level(5)
    screen.text_right('IDLE')
  end

  if s.notice and s.notice_until and now_ms() < s.notice_until then
    -- Transient, so it takes the line: whatever it displaced comes back in a
    -- few seconds, and the operator is looking at the screen right now.
    screen.level(15)
    screen.move(0, 62)
    screen.text(s.notice:sub(1, 21))
  elseif MIDI_BACKEND ~= 'osc' and not port_live(out_port) then
    -- Nothing is behind the selected virtual port, so every CC is accepted and
    -- thrown away. Silence is otherwise indistinguishable from working.
    screen.level(15)
    screen.move(0, 62)
    screen.text('NO MIDI OUT')
  elseif s.rejected > 0 then
    screen.level(3)
    screen.move(0, 62)
    screen.text('rej ' .. s.rejected)
  end
end

local function draw_help()
  screen.level(15)
  screen.move(0, 7)
  screen.text('STAGEIN / keys')
  screen.level(4)
  screen.move(0, 9)
  screen.line(128, 9)
  screen.stroke()
  screen.level(8)
  -- Six lines: the seventh would be drawn on a y=67 baseline, off a 64 px screen.
  local lines = {
    'E1 preset   E2 duration',
    'E3 intensity',
    'K1 page   K2 open / draw',
    ARM_MODE == 'deadman' and 'K3 hold=ARM release=KILL' or 'K3 arm, 2x tap=KILL',
    'out: ' .. MIDI_BACKEND,
    'port: ' .. port_label(out_port),
  }
  for i, line in ipairs(lines) do
    screen.move(0, 19 + (i - 1) * 8)
    screen.text(line)
  end
end

function redraw()
  -- matron's screensaver swaps screen.update for a no-op after 15 idle
  -- minutes, and only a key press restores it. A stage must never meet a
  -- sleeping screen mid-take, so keep it awake whenever the device is armed
  -- or a participant holds the pad. (ping is absent in the simulator.)
  if screen.ping and (s.armed or s.grant) then screen.ping() end
  screen.clear()
  if s.page == 2 then draw_help() else draw_main() end
  screen.update()
end

-- ---------------------------------------------------------------------------
-- controls (PRD §12)
-- ---------------------------------------------------------------------------

function enc(n, d)
  if n == 1 then
    params:delta('preset', d)
  elseif n == 2 then
    params:delta('duration', d)
  elseif n == 3 then
    params:delta('intensity', d)
  end
end

function key(n, z)
  if n == 1 then
    if z == 1 then s.page = s.page == 1 and 2 or 1 end
    return
  end

  if n == 2 then
    if z ~= 1 then return end
    if s.session_state == 'OPEN' then
      relay.send({ t = 'draw', countdownMs = 5000 })
    else
      relay.send({ t = 'open' })
    end
    return
  end

  if n == 3 then
    if ARM_MODE == 'deadman' then
      -- Literal PRD reading: the device is only armed while K3 is held down.
      if z == 1 then do_arm() else do_kill('K3 release') end
      return
    end
    -- Stage-practical reading: K3 latches ARM, a double tap kills.
    if z ~= 1 then return end
    local now = now_ms()
    local double_tap = (now - s.k3_last_press) < DOUBLE_TAP_MS
    s.k3_last_press = now
    if s.killed then
      do_arm()
    elseif s.armed and double_tap then
      do_kill('K3 double tap')
    elseif s.armed then
      do_disarm()
    else
      do_arm()
    end
  end
end

-- ---------------------------------------------------------------------------
-- lifecycle
-- ---------------------------------------------------------------------------

function init()
  add_params()
  connect_midi(params:get('midi_device'))
  watch_devices()
  if relay.start then relay.start() end
  s.out_x, s.out_y = safe_position()
  s.target_x, s.target_y = s.out_x, s.out_y

  metro.init({ event = engine_tick, time = 1 / ENGINE_HZ, count = -1 }):start()
  metro.init({ event = send_status, time = 1 / STATUS_HZ, count = -1 }):start()
  -- Late-bind the global so the metro always draws the live instance, even if
  -- a leaked metro from an earlier load survived a failed cleanup.
  metro.init({ event = function() redraw() end, time = 1 / REDRAW_HZ, count = -1 }):start()

  log('info', string.format('stagein.lua ready (arm=%s, out=%s)', ARM_MODE, MIDI_BACKEND))
end

function cleanup()
  if relay.stop then relay.stop() end
  -- Never leave the rig on a participant's last value.
  local sx, sy = safe_position()
  emit(cfg.x, map_to_cc(sx, cfg.x), 'x')
  emit(cfg.y, map_to_cc(sy, cfg.y), 'y')
end

--- Exposed for the emulator's web panel; unused on real hardware.
function device_state()
  return json.encode({
    online = s.online,
    session = s.session,
    sessionState = s.session_state,
    entrants = s.entrants,
    connected = s.connected,
    winner = s.winner or json.null,
    remainingMs = s.remaining_ms or json.null,
    armed = s.armed,
    killed = s.killed,
    authorised = authorised(),
    preset = cfg.preset,
    armMode = ARM_MODE,
    midiBackend = MIDI_BACKEND,
    grantId = (s.grant and s.grant.id) or json.null,
    targetX = s.target_x,
    targetY = s.target_y,
    outX = s.out_x,
    outY = s.out_y,
    ccX = math.max(0, s.cc_x),
    ccY = math.max(0, s.cc_y),
    accepted = s.accepted,
    rejected = s.rejected,
    clockOffset = s.clock_offset or json.null,
    x = { name = cfg.x.name, cc = cfg.x.cc, min = cfg.x.min, max = cfg.x.max, safe = cfg.x.safe, channel = cfg.x.channel },
    y = { name = cfg.y.name, cc = cfg.y.cc, min = cfg.y.min, max = cfg.y.max, safe = cfg.y.safe, channel = cfg.y.channel },
    durationMs = cfg.control_ms,
    slewMs = cfg.slew_ms,
    maxRate = cfg.max_rate,
    intensity = params:get('intensity'),
  })
end
