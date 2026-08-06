import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LuaFactory, type LuaEngine } from 'wasmoon';

/**
 * The emulated hardware.
 *
 * A real Lua 5.4 interpreter runs `lua/stagein.lua` — the same script that
 * would sit in `~/dust/code/stagein` on a real Norns. This class plays the part
 * matron plays on the device: it provides the raw I/O primitives, loads the
 * script, and drives it from a timer.
 */

/**
 * Mounted into the interpreter's filesystem; `boot.lua` pulls them in via
 * require(). `engine.lua` and `json.lua` are loaded straight out of the
 * deployable package — the simulator runs the very bytes that ship to the
 * device, so a passing rehearsal says something about the hardware.
 */
const SCRIPT_FILES = ['engine.lua', 'json.lua'] as const;
/** Emulator-only: the fake matron runtime and its entry point. */
const HARNESS_FILES = ['norns_shim.lua', 'boot.lua'] as const;

export interface ScreenOp {
  op: 'line' | 'rect' | 'circle' | 'text';
  level: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  r?: number;
  s?: string;
  size?: number;
  align?: 'left' | 'right' | 'center';
  fill?: boolean;
  width?: number;
  pts?: Array<[number, number]>;
}

export interface ScreenFrame {
  w: number;
  h: number;
  ops: ScreenOp[];
}

export interface HostBindings {
  log(level: string, message: string): void;
  screen(frame: ScreenFrame): void;
  midiCc(channel: number, cc: number, value: number): void;
  osc(address: string, value: number): void;
  wsSend(payload: string): void;
}

type LuaFn = (...args: unknown[]) => unknown;

export class LuaNorns {
  private lua: LuaEngine | null = null;
  private tick: LuaFn | null = null;
  private onMessage: LuaFn | null = null;
  private onOpen: LuaFn | null = null;
  private onClose: LuaFn | null = null;
  private encFn: LuaFn | null = null;
  private keyFn: LuaFn | null = null;
  private stateFn: LuaFn | null = null;
  private cleanupFn: LuaFn | null = null;
  private timer: NodeJS.Timeout | null = null;
  /**
   * Once the interpreter state is closed, any call into it aborts the process.
   * Sockets and timers unwind asynchronously, so every entry point below has to
   * tolerate arriving late rather than rely on shutdown ordering.
   */
  private closed = false;

  constructor(
    private readonly bindings: HostBindings,
    private readonly options: {
      armMode: string;
      midiBackend: string;
      tickMs: number;
      /** Deployable script package (`packages/norns-script/lib`). */
      scriptDir?: string;
      /** Emulator harness (`packages/norns-sim/lua`). */
      harnessDir?: string;
    },
  ) {}

  async boot(): Promise<void> {
    const scriptDir = this.options.scriptDir ?? join(__dirname, '..', '..', 'norns-script', 'lib');
    const harnessDir = this.options.harnessDir ?? join(__dirname, '..', 'lua');
    const factory = new LuaFactory();

    for (const [dir, files] of [
      [scriptDir, SCRIPT_FILES],
      [harnessDir, HARNESS_FILES],
    ] as const) {
      for (const name of files) {
        await factory.mountFile(name, readFileSync(join(dir, name), 'utf8'));
      }
    }

    const lua = await factory.createEngine();
    this.lua = lua;

    // --- injected hardware primitives -------------------------------------
    lua.global.set('_host_now', () => Date.now());
    lua.global.set('_host_log', (level: string, message: string) => {
      this.bindings.log(String(level), String(message));
    });
    lua.global.set('_host_screen', (payload: string) => {
      try {
        this.bindings.screen(JSON.parse(payload) as ScreenFrame);
      } catch (err) {
        this.bindings.log('error', `bad screen frame: ${String(err)}`);
      }
    });
    lua.global.set('_host_midi_cc', (channel: number, cc: number, value: number) => {
      this.bindings.midiCc(Number(channel), Number(cc), Number(value));
    });
    lua.global.set('_host_osc', (address: string, value: number) => {
      this.bindings.osc(String(address), Number(value));
    });
    lua.global.set('_host_ws_send', (payload: string) => {
      this.bindings.wsSend(String(payload));
    });

    // --- device configuration the script reads at load time ---------------
    lua.global.set('_host_arm_mode', this.options.armMode);
    lua.global.set('_host_midi_backend', this.options.midiBackend);

    await lua.doString("package.path = '/?.lua;./?.lua;' .. package.path");
    await lua.doFile('boot.lua');

    this.tick = lua.global.get('_norns_tick') as LuaFn;
    this.onMessage = lua.global.get('_norns_relay_message') as LuaFn;
    this.onOpen = lua.global.get('_norns_relay_open') as LuaFn;
    this.onClose = lua.global.get('_norns_relay_close') as LuaFn;
    this.encFn = lua.global.get('_norns_enc') as LuaFn;
    this.keyFn = lua.global.get('_norns_key') as LuaFn;
    this.stateFn = lua.global.get('_norns_device_state') as LuaFn;
    this.cleanupFn = lua.global.get('_norns_cleanup') as LuaFn;

    const boot = lua.global.get('_norns_boot') as LuaFn;
    boot();

    // Drive metros and clock coroutines. Faster than the script's own 60 Hz
    // engine so the kill switch is never waiting on the host.
    this.timer = setInterval(() => {
      if (this.closed) return;
      try {
        this.tick?.(Date.now());
      } catch (err) {
        this.bindings.log('error', `tick failed: ${String(err)}`);
      }
    }, this.options.tickMs);
  }

  relayMessage(payload: string): void {
    if (this.closed) return;
    this.onMessage?.(payload);
  }

  relayOpen(): void {
    if (this.closed) return;
    this.onOpen?.();
  }

  relayClose(): void {
    if (this.closed) return;
    this.onClose?.();
  }

  enc(n: number, delta: number): void {
    if (this.closed) return;
    this.encFn?.(n, delta);
  }

  key(n: number, z: number): void {
    if (this.closed) return;
    this.keyFn?.(n, z);
  }

  /** Snapshot of the script's own state, for the emulator panel. */
  deviceState(): Record<string, unknown> {
    if (this.closed) return {};
    try {
      const raw = this.stateFn?.();
      return typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  shutdown(): void {
    if (this.closed) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this.cleanupFn?.();
    } catch {
      /* best effort: we are exiting anyway */
    }
    // Set before closing: the tick timer is gone, but a socket or panel
    // callback may still be queued behind us.
    this.closed = true;
    this.lua?.global.close();
    this.lua = null;
  }
}
