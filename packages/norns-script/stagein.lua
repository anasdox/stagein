-- StageIn — Join the performance. Shape the moment.
--
-- norns entry point. Deployed to ~/dust/code/stagein/ and loaded by matron,
-- which then calls init / redraw / enc / key / cleanup.
--
-- This file only wires the pieces together. Every musical decision lives in
-- lib/engine.lua, which is the same file the simulator runs — so what a
-- rehearsal proves is what the device executes.
--
--   E1  preset          K1  page / help
--   E2  control length  K2  open registrations, then fire the draw
--   E3  macro intensity K3  ARM  (double-tap = KILL)
--
-- Setup, once per device:
--   1. mise run norns:deploy NORNS=we@norns.local
--   2. edit ~/dust/data/stagein/config.json with the relay URL and the token
--      the host console shows
--   3. reload the script

-- The engine reads json through this global; matron has no require() path into
-- the script directory, so the loader resolves it.
_stagein_json = include('stagein/lib/json')

-- Defines the global `relay` table and hooks matron's OSC input. Must come
-- before the engine, which calls relay.send() as soon as it is armed.
include('stagein/lib/relay_osc')

-- Defines init / redraw / enc / key / cleanup and relay_message / relay_open /
-- relay_close. Byte-identical to the simulator's copy.
include('stagein/lib/engine')
