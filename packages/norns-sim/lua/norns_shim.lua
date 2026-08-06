-- Emulation of the slice of the Norns (matron) runtime that stagein.lua uses.
--
-- On real hardware matron provides all of this and this file is never loaded;
-- boot.lua only pulls it in when it detects the emulator host. Keeping the
-- emulation here — rather than inside stagein.lua — is what lets the same
-- script run in both places.
--
-- The host (Node) injects a handful of raw I/O primitives as globals:
--   _host_now()                    monotonic-ish milliseconds
--   _host_log(level, message)
--   _host_screen(json)             a finished display list, one per redraw
--   _host_midi_cc(channel, cc, value)
--   _host_osc(address, value)
--   _host_ws_send(json)            frame for the relay

local json = require('json')

local shim = {}

-- ---------------------------------------------------------------------------
-- util
-- ---------------------------------------------------------------------------

util = {}

function util.clamp(v, lo, hi)
  if v < lo then return lo elseif v > hi then return hi else return v end
end

function util.round(v, quant)
  quant = quant or 1
  return math.floor(v / quant + 0.5) * quant
end

function util.linlin(slo, shi, dlo, dhi, v)
  if shi == slo then return dlo end
  v = util.clamp(v, math.min(slo, shi), math.max(slo, shi))
  return dlo + (dhi - dlo) * (v - slo) / (shi - slo)
end

function util.time()
  return _host_now() / 1000
end

-- ---------------------------------------------------------------------------
-- screen (128 x 64, 16 brightness levels)
-- ---------------------------------------------------------------------------

screen = {}

local WIDTH, HEIGHT = 128, 64

local sc = {
  ops = {},
  level = 15,
  x = 0,
  y = 0,
  font_size = 8,
  line_width = 1,
  path = nil,
  pending = nil, -- a rect/circle awaiting stroke() or fill()
}

function screen.clear()
  sc.ops = {}
  sc.path = nil
  sc.pending = nil
  sc.level = 15
end

function screen.level(l)
  sc.level = util.clamp(math.floor(l), 0, 15)
end

function screen.line_width(w)
  sc.line_width = w
end

function screen.font_size(n)
  sc.font_size = n
end

function screen.font_face(_) end
function screen.aa(_) end
function screen.close() end

function screen.move(x, y)
  sc.x, sc.y = x, y
  sc.path = nil
end

function screen.move_rel(dx, dy)
  sc.x, sc.y = sc.x + dx, sc.y + dy
end

function screen.line(x, y)
  if not sc.path then sc.path = { { sc.x, sc.y } } end
  sc.path[#sc.path + 1] = { x, y }
  sc.x, sc.y = x, y
end

function screen.line_rel(dx, dy)
  screen.line(sc.x + dx, sc.y + dy)
end

function screen.rect(x, y, w, h)
  sc.pending = { op = 'rect', x = x, y = y, w = w, h = h }
end

function screen.circle(x, y, r)
  sc.pending = { op = 'circle', x = x, y = y, r = r }
end

function screen.pixel(x, y)
  sc.pending = { op = 'rect', x = x, y = y, w = 1, h = 1 }
end

local function flush(fill)
  if sc.pending then
    sc.pending.level = sc.level
    sc.pending.fill = fill
    sc.pending.width = sc.line_width
    sc.ops[#sc.ops + 1] = sc.pending
    sc.pending = nil
  end
  if sc.path then
    sc.ops[#sc.ops + 1] = {
      op = 'line',
      level = sc.level,
      width = sc.line_width,
      pts = sc.path,
    }
    sc.path = nil
  end
end

function screen.stroke() flush(false) end
function screen.fill() flush(true) end

local function draw_text(s, align)
  sc.ops[#sc.ops + 1] = {
    op = 'text',
    level = sc.level,
    x = sc.x,
    y = sc.y,
    size = sc.font_size,
    align = align,
    s = tostring(s),
  }
end

function screen.text(s) draw_text(s, 'left') end
function screen.text_right(s) draw_text(s, 'right') end
function screen.text_center(s) draw_text(s, 'center') end

-- Rough advance width, enough for layout decisions inside the script.
function screen.text_extents(s)
  return #tostring(s) * (sc.font_size * 0.52), sc.font_size
end

function screen.update()
  _host_screen(json.encode({ w = WIDTH, h = HEIGHT, ops = sc.ops }))
end

shim.screen_size = { WIDTH, HEIGHT }

-- ---------------------------------------------------------------------------
-- metro — driven by the host tick rather than by real timers
-- ---------------------------------------------------------------------------

local metros = {}

metro = {}

function metro.init(args)
  local m = {
    event = args.event,
    time = args.time or 1,
    count = args.count or -1,
    fired = 0,
    running = false,
    next_at = 0,
  }
  function m:start(time)
    if time then self.time = time end
    self.fired = 0
    self.running = true
    self.next_at = _host_now() + self.time * 1000
  end
  function m:stop() self.running = false end
  metros[#metros + 1] = m
  return m
end

-- ---------------------------------------------------------------------------
-- clock — coroutine scheduler, also host-tick driven
-- ---------------------------------------------------------------------------

local coros = {}

clock = {}

function clock.run(fn, ...)
  local co = coroutine.create(fn)
  local entry = { co = co, wake_at = 0 }
  coros[#coros + 1] = entry
  local ok, err = coroutine.resume(co, ...)
  if not ok then _host_log('error', 'clock coroutine: ' .. tostring(err)) end
  return entry
end

function clock.sleep(seconds)
  coroutine.yield(seconds)
end

function clock.cancel(entry)
  for i, e in ipairs(coros) do
    if e == entry then table.remove(coros, i) return end
  end
end

--- Advance every metro and coroutine. Called by the host on its own interval.
function shim.tick(now)
  for _, m in ipairs(metros) do
    if m.running then
      -- Catch up rather than drift, but never fire more than a few times in a
      -- row: a long host stall must not turn into a burst of MIDI.
      local guard = 0
      while m.running and now >= m.next_at and guard < 4 do
        m.next_at = m.next_at + m.time * 1000
        m.fired = m.fired + 1
        guard = guard + 1
        local ok, err = pcall(m.event, m.fired)
        if not ok then _host_log('error', 'metro: ' .. tostring(err)) end
        if m.count > 0 and m.fired >= m.count then m.running = false end
      end
      if guard >= 4 then m.next_at = now + m.time * 1000 end
    end
  end

  for i = #coros, 1, -1 do
    local e = coros[i]
    if coroutine.status(e.co) == 'dead' then
      table.remove(coros, i)
    elseif now >= e.wake_at then
      local ok, res = coroutine.resume(e.co)
      if not ok then
        _host_log('error', 'clock: ' .. tostring(res))
        table.remove(coros, i)
      elseif type(res) == 'number' then
        e.wake_at = now + res * 1000
      end
    end
  end
end

-- ---------------------------------------------------------------------------
-- params — enough of the norns parameter set for E1/E2/E3 to be meaningful
-- ---------------------------------------------------------------------------

local param_list = {}
local param_order = {}

params = {}

function params:add(args)
  local p = {
    id = args.id,
    name = args.name or args.id,
    type = args.type or 'number',
    min = args.min or 0,
    max = args.max or 1,
    default = args.default,
    action = args.action,
    options = args.options,
    value = nil,
  }
  if p.type == 'option' then
    p.min, p.max = 1, #(p.options or { '' })
  end
  if p.default == nil then p.default = p.min end
  p.value = p.default
  param_list[p.id] = p
  param_order[#param_order + 1] = p.id
  return p
end

function params:add_separator(_) end

function params:get(id)
  local p = param_list[id]
  return p and p.value or 0
end

function params:set(id, v, silent)
  local p = param_list[id]
  if not p then return end
  v = util.clamp(v, p.min, p.max)
  if p.type == 'option' or p.type == 'integer' then v = math.floor(v + 0.5) end
  p.value = v
  if p.action and not silent then
    local ok, err = pcall(p.action, v)
    if not ok then _host_log('error', 'param action ' .. id .. ': ' .. tostring(err)) end
  end
end

function params:delta(id, d)
  local p = param_list[id]
  if not p then return end
  local step = (p.type == 'option' or p.type == 'integer') and 1 or (p.max - p.min) / 100
  params:set(id, p.value + d * step)
end

function params:string(id)
  local p = param_list[id]
  if not p then return '' end
  if p.type == 'option' then return (p.options or {})[p.value] or '?' end
  return tostring(util.round(p.value, 0.01))
end

function params:bang()
  for _, id in ipairs(param_order) do
    local p = param_list[id]
    if p.action then pcall(p.action, p.value) end
  end
end

-- ---------------------------------------------------------------------------
-- midi / osc
-- ---------------------------------------------------------------------------

midi = {}

function midi.connect(n)
  local device = { port = n or 1, name = 'stagein-out' }
  function device:cc(cc, val, ch)
    _host_midi_cc(ch or 1, cc, val)
  end
  function device:note_on() end
  function device:note_off() end
  return device
end

osc = {}

function osc.send(_, path, args)
  _host_osc(path, (args and args[1]) or 0)
end

-- ---------------------------------------------------------------------------
-- relay socket — the one thing a real Norns needs a companion lib for
-- ---------------------------------------------------------------------------

relay = {}

function relay.send(tbl)
  _host_ws_send(json.encode(tbl))
end

-- ---------------------------------------------------------------------------
-- misc globals matron defines
-- ---------------------------------------------------------------------------

norns = norns or {}
norns.state = { name = 'stagein' }

function print_log(...)
  local parts = {}
  for i, v in ipairs({ ... }) do parts[i] = tostring(v) end
  _host_log('info', table.concat(parts, ' '))
end

return shim
