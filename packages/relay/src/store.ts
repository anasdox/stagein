import type { RelayConfig } from './config';
import { logger } from './log';
import { randomToken, sessionCode } from './ids';
import { LiveSession } from './session';

const log = logger('store');

/** Drives every session's clock. 50 ms keeps countdowns and expiry crisp. */
const TICK_MS = 50;
/** Sessions with nobody attached are collected after this long. */
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

export class SessionStore {
  private sessions = new Map<string, LiveSession>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly config: RelayConfig) {}

  create(preferredId?: string, hostToken?: string, nornsToken?: string): LiveSession {
    let id = (preferredId ?? sessionCode()).toUpperCase();
    while (!preferredId && this.sessions.has(id)) id = sessionCode();
    if (this.sessions.has(id)) throw new Error(`session ${id} already exists`);

    const session = new LiveSession(
      id,
      hostToken ?? randomToken(24),
      nornsToken ?? randomToken(24),
      this.config,
    );
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): LiveSession | undefined {
    return this.sessions.get(id.toUpperCase());
  }

  /**
   * The session served at the root, when there is one.
   *
   * Lets a participant reach the lottery by typing the bare domain, which is
   * what a QR on a wall or a name said into a microphone can realistically
   * carry.
   */
  primary(): LiveSession | undefined {
    const id = this.config.bootstrap?.sessionId;
    return id ? this.sessions.get(id) : undefined;
  }

  list(): LiveSession[] {
    return [...this.sessions.values()];
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    log.info(`tick started (${TICK_MS} ms)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      try {
        session.tick(now);
        session.flush();
      } catch (err) {
        log.error(`tick failed for ${id}`, err);
      }
      if (
        this.config.bootstrap?.sessionId !== id &&
        now - session.createdAt > SESSION_TTL_MS &&
        session.publicState(now).connected === 0 &&
        !session.hasNorns()
      ) {
        log.info(`collecting idle session ${id}`);
        this.sessions.delete(id);
      }
    }
  }

  shutdown(): void {
    this.stop();
    for (const session of this.sessions.values()) session.shutdown();
  }
}
