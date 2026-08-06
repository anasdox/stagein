-- StageIn relay transport for real Norns hardware.
--
-- matron ships no WebSocket client, so the outbound connection lives in a small
-- companion process (PRD §18) and this file bridges it to the script over local
-- OSC. The simulator installs its own `relay` table instead, which is why
-- lib/engine.lua mentions neither transport.
--
--   engine  --osc /stagein/out-->  bridge  --wss-->  relay
--   engine  <--osc /stagein/in--   bridge  <--wss--  relay
--                                  bridge  --osc /stagein/{up,down}--> engine

local json = _stagein_json

local DATA_DIR = _path.data .. 'stagein/'
local CODE_DIR = _path.code .. 'stagein/'
local CONFIG_PATH = DATA_DIR .. 'config.json'
local LOG_PATH = DATA_DIR .. 'bridge.log'
local PID_PATH = DATA_DIR .. 'bridge.pid'

--- Where the bridge listens for frames heading out to the relay. The bridge
--- learns matron's own port from the config file.
local BRIDGE_OSC_PORT = 10112

local CONFIG_TEMPLATE = [[{
  "relay_ws_url": "ws://192.168.1.42:8080/ws/norns",
  "session": "DEMO01",
  "norns_token": "paste-the-norns-token-from-the-host-console",
  "matron_osc_port": 10111,
  "bridge_osc_port": 10112
}
]]

relay = {}

local bridge_dest = { '127.0.0.1', BRIDGE_OSC_PORT }

--- Send a protocol frame to the relay, via the bridge.
function relay.send(tbl)
  osc.send(bridge_dest, '/stagein/out', { json.encode(tbl) })
end

-- ---------------------------------------------------------------------------
-- inbound
-- ---------------------------------------------------------------------------

-- matron calls a single global for every OSC packet. Chain rather than replace,
-- so loading StageIn cannot silently break another script's OSC handling.
local previous_osc_event = osc.event

osc.event = function(path, args, from)
  if path == '/stagein/in' then
    local payload = args and args[1]
    if type(payload) ~= 'string' then return end
    local ok, decoded = pcall(json.decode, payload)
    if not ok then
      print('stagein: malformed frame from bridge: ' .. tostring(decoded))
      return
    end
    if relay_message then
      local handled, err = pcall(relay_message, decoded)
      if not handled then print('stagein: relay_message failed: ' .. tostring(err)) end
    end
    return
  end
  if path == '/stagein/up' then
    if relay_open then pcall(relay_open) end
    return
  end
  if path == '/stagein/down' then
    if relay_close then pcall(relay_close) end
    return
  end
  if previous_osc_event then previous_osc_event(path, args, from) end
end

-- ---------------------------------------------------------------------------
-- companion process lifecycle
-- ---------------------------------------------------------------------------

local function file_exists(path)
  local f = io.open(path, 'r')
  if not f then return false end
  f:close()
  return true
end

--- Returns true when the operator has supplied a real config. On a fresh device
--- it writes a template and says so, rather than failing silently on stage.
local function ensure_config()
  os.execute('mkdir -p "' .. DATA_DIR .. '"')
  if file_exists(CONFIG_PATH) then return true end
  local f = io.open(CONFIG_PATH, 'w')
  if not f then
    print('stagein: cannot write ' .. CONFIG_PATH)
    return false
  end
  f:write(CONFIG_TEMPLATE)
  f:close()
  print('stagein: wrote a config template to ' .. CONFIG_PATH)
  print('stagein: fill in relay_ws_url and norns_token, then reload the script')
  return false
end

--- Start the bridge, replacing any earlier instance.
function relay.start()
  if not ensure_config() then return end
  relay.stop()

  -- setsid detaches it from matron, so reloading the script cannot leave a
  -- half-dead child holding the UDP port.
  local cmd = string.format(
    'setsid python3 "%sbridge/stagein_bridge.py" --config "%s" >> "%s" 2>&1 & echo $! > "%s"',
    CODE_DIR,
    CONFIG_PATH,
    LOG_PATH,
    PID_PATH
  )
  os.execute(cmd)
  print('stagein: bridge starting, log at ' .. LOG_PATH)
end

--- Stop the bridge. Called from cleanup(), so leaving the script releases the
--- connection instead of leaving a process talking to the relay.
function relay.stop()
  local f = io.open(PID_PATH, 'r')
  if f then
    local pid = f:read('*l')
    f:close()
    if pid and pid:match('^%d+$') then os.execute('kill ' .. pid .. ' 2>/dev/null') end
    os.remove(PID_PATH)
  end
  -- Belt and braces: a bridge left over from a crash would still hold the port.
  os.execute('pkill -f stagein_bridge.py 2>/dev/null')
end

return relay
