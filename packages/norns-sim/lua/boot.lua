-- Emulator entry point.
--
-- On real hardware matron does this job: it provides the runtime, loads the
-- script, and calls init/enc/key/redraw. Here the Node host does the same
-- through the small `_norns_*` surface defined below.

local json = require('json')

-- Only load the hardware emulation when running under the emulator host.
local shim = _host_now and require('norns_shim') or nil

require('engine')

function _norns_boot()
  init()
end

function _norns_tick(now)
  if shim then shim.tick(now) end
end

function _norns_relay_message(text)
  local ok, decoded = pcall(json.decode, text)
  if not ok then
    _host_log('error', 'malformed frame from relay: ' .. tostring(decoded))
    return
  end
  local handled, err = pcall(relay_message, decoded)
  if not handled then _host_log('error', 'relay_message: ' .. tostring(err)) end
end

function _norns_relay_open()
  pcall(relay_open)
end

function _norns_relay_close()
  pcall(relay_close)
end

function _norns_enc(n, d)
  local ok, err = pcall(enc, n, d)
  if not ok then _host_log('error', 'enc: ' .. tostring(err)) end
end

function _norns_key(n, z)
  local ok, err = pcall(key, n, z)
  if not ok then _host_log('error', 'key: ' .. tostring(err)) end
end

function _norns_device_state()
  local ok, result = pcall(device_state)
  if ok then return result end
  return '{}'
end

function _norns_cleanup()
  pcall(cleanup)
end
