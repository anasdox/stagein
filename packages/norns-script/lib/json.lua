-- Minimal JSON encode/decode in pure Lua.
--
-- Vendored rather than pulled from luarocks so this script drops onto a real
-- Norns unchanged: matron ships no cjson.

local json = {}

json.null = setmetatable({}, { __tostring = function() return 'null' end })

-- ---------------------------------------------------------------------------
-- encode
-- ---------------------------------------------------------------------------

local escapes = {
  ['"'] = '\\"',
  ['\\'] = '\\\\',
  ['\b'] = '\\b',
  ['\f'] = '\\f',
  ['\n'] = '\\n',
  ['\r'] = '\\r',
  ['\t'] = '\\t',
}

local function escape_char(c)
  return escapes[c] or string.format('\\u%04x', string.byte(c))
end

local encode_value

local function encode_number(v)
  if v ~= v or v == math.huge or v == -math.huge then return 'null' end
  if math.type and math.type(v) == 'integer' then return string.format('%d', v) end
  -- %.14g keeps normalised 0..1 coordinates exact enough and stays compact.
  return (string.format('%.14g', v))
end

local function is_array(t)
  local count = 0
  for k in pairs(t) do
    if type(k) ~= 'number' or k % 1 ~= 0 or k < 1 then return false end
    count = count + 1
  end
  return count == #t
end

encode_value = function(v)
  local t = type(v)
  if v == json.null or v == nil then
    return 'null'
  elseif t == 'boolean' then
    return tostring(v)
  elseif t == 'number' then
    return encode_number(v)
  elseif t == 'string' then
    return '"' .. v:gsub('[%c"\\]', escape_char) .. '"'
  elseif t == 'table' then
    if is_array(v) and #v > 0 then
      local parts = {}
      for i = 1, #v do parts[i] = encode_value(v[i]) end
      return '[' .. table.concat(parts, ',') .. ']'
    end
    local parts = {}
    for k, val in pairs(v) do
      if val ~= nil then
        parts[#parts + 1] = encode_value(tostring(k)) .. ':' .. encode_value(val)
      end
    end
    return '{' .. table.concat(parts, ',') .. '}'
  end
  error('json: cannot encode ' .. t)
end

function json.encode(v)
  return encode_value(v)
end

-- ---------------------------------------------------------------------------
-- decode
-- ---------------------------------------------------------------------------

local parse_value

local function skip_ws(s, i)
  local _, j = s:find('^[ \t\r\n]*', i)
  return (j or i - 1) + 1
end

local function parse_error(s, i, msg)
  error(string.format('json: %s at byte %d near %q', msg, i, s:sub(math.max(1, i - 8), i + 8)))
end

local unescapes = {
  ['"'] = '"', ['\\'] = '\\', ['/'] = '/', b = '\b', f = '\f', n = '\n', r = '\r', t = '\t',
}

local function parse_string(s, i)
  i = i + 1 -- skip opening quote
  local out = {}
  while true do
    local c = s:sub(i, i)
    if c == '' then parse_error(s, i, 'unterminated string') end
    if c == '"' then return table.concat(out), i + 1 end
    if c == '\\' then
      local esc = s:sub(i + 1, i + 1)
      if esc == 'u' then
        local hex = s:sub(i + 2, i + 5)
        local code = tonumber(hex, 16)
        if not code then parse_error(s, i, 'bad \\u escape') end
        -- utf8.char covers the BMP; surrogate pairs are not used by the relay.
        out[#out + 1] = utf8 and utf8.char(code) or string.char(code % 256)
        i = i + 6
      elseif unescapes[esc] then
        out[#out + 1] = unescapes[esc]
        i = i + 2
      else
        parse_error(s, i, 'bad escape')
      end
    else
      local stop = s:find('["\\]', i) or (#s + 1)
      out[#out + 1] = s:sub(i, stop - 1)
      i = stop
    end
  end
end

local function parse_number(s, i)
  local text = s:match('^-?%d+%.?%d*[eE]?[-+]?%d*', i)
  if not text then parse_error(s, i, 'bad number') end
  local v = tonumber(text)
  if not v then parse_error(s, i, 'bad number') end
  return v, i + #text
end

local function parse_array(s, i)
  local out = {}
  i = skip_ws(s, i + 1)
  if s:sub(i, i) == ']' then return out, i + 1 end
  while true do
    local v
    v, i = parse_value(s, i)
    out[#out + 1] = v
    i = skip_ws(s, i)
    local c = s:sub(i, i)
    if c == ',' then
      i = skip_ws(s, i + 1)
    elseif c == ']' then
      return out, i + 1
    else
      parse_error(s, i, 'expected , or ]')
    end
  end
end

local function parse_object(s, i)
  local out = {}
  i = skip_ws(s, i + 1)
  if s:sub(i, i) == '}' then return out, i + 1 end
  while true do
    if s:sub(i, i) ~= '"' then parse_error(s, i, 'expected key') end
    local key
    key, i = parse_string(s, i)
    i = skip_ws(s, i)
    if s:sub(i, i) ~= ':' then parse_error(s, i, 'expected :') end
    i = skip_ws(s, i + 1)
    local v
    v, i = parse_value(s, i)
    out[key] = v
    i = skip_ws(s, i)
    local c = s:sub(i, i)
    if c == ',' then
      i = skip_ws(s, i + 1)
    elseif c == '}' then
      return out, i + 1
    else
      parse_error(s, i, 'expected , or }')
    end
  end
end

parse_value = function(s, i)
  i = skip_ws(s, i)
  local c = s:sub(i, i)
  if c == '{' then return parse_object(s, i) end
  if c == '[' then return parse_array(s, i) end
  if c == '"' then return parse_string(s, i) end
  if c == 't' then
    if s:sub(i, i + 3) == 'true' then return true, i + 4 end
    parse_error(s, i, 'bad literal')
  end
  if c == 'f' then
    if s:sub(i, i + 4) == 'false' then return false, i + 5 end
    parse_error(s, i, 'bad literal')
  end
  if c == 'n' then
    if s:sub(i, i + 3) == 'null' then return json.null, i + 4 end
    parse_error(s, i, 'bad literal')
  end
  return parse_number(s, i)
end

function json.decode(s)
  if type(s) ~= 'string' then error('json: expected string') end
  local v, i = parse_value(s, 1)
  i = skip_ws(s, i)
  if i <= #s then parse_error(s, i, 'trailing garbage') end
  return v
end

return json
