import type { WebSocket } from 'ws';

import {
  Percentile,
  TokenBucket,
  applyConfigPatch,
  canTransition,
  ccToNorm,
  clamp,
  defaultConfig,
  generateStageName,
  moderateName,
  sanitizePseudo,
  type EndReason,
  type ErrorCode,
  type GrantView,
  type HostOut,
  type HostState,
  type NornsOut,
  type NornsStatus,
  type ParticipantOut,
  type ParticipantView,
  type PublicState,
  type SessionConfig,
  type SessionState,
  type StageLive,
  type StageOut,
} from '@stagein/protocol';

import type { RelayConfig } from './config';
import { LogRing, logger } from './log';
import { pickOne, randomToken, tokenEquals } from './ids';

const log = logger('session');

/** How long the ENDED screen stays up before registrations reopen. */
const ENDED_DISPLAY_MS = 3_000;
/** Countdown used when the relay redraws automatically after a no-show. */
const AUTO_REDRAW_COUNTDOWN_MS = 3_000;
/** A latency sample beyond this is clock skew, not network delay — discard it. */
const MAX_PLAUSIBLE_LATENCY_MS = 5_000;
/**
 * How often the overlay gets the pad position. Ten a second is smooth to the
 * eye and a fifth of the tick, which keeps a projector cheap: this frame is the
 * only one that fires while nothing in the session is actually changing.
 */
const LIVE_PUSH_MS = 100;

function send(ws: WebSocket | null | undefined, msg: unknown): void {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch (err) {
    log.warn('send failed', err);
  }
}

export interface Participant {
  clientId: string;
  pseudo: string;
  entered: boolean;
  joinedAt: number;
  lastSeenAt: number;
  socket: WebSocket | null;
  disconnectedAt: number | null;
  blocked: boolean;
  /** clientClock - serverClock, estimated from ping/pong. */
  clockOffsetMs: number | null;
  bestRttMs: number | null;
  pendingPing: { id: number; ts: number } | null;
  /** Rate limiter for pad samples (NFR-06). */
  bucket: TokenBucket;
  /** Highest sequence number accepted — anything lower is a replay (PRD §11). */
  lastSeq: number;
}

interface Grant {
  grantId: string;
  token: string;
  clientId: string;
  awardedAt: number;
  activationDeadline: number;
  startedAt: number | null;
  expiresAt: number | null;
  revoked: boolean;
  /** Last position forwarded, so a reconnect resumes where the finger was. */
  lastX: number;
  lastY: number;
}

export class LiveSession {
  readonly createdAt = Date.now();

  config: SessionConfig = defaultConfig();
  state: SessionState = 'CLOSED';
  /** Rotatable secret embedded in the join URL / QR code (PRD §11). */
  joinKey: string;

  private participants = new Map<string, Participant>();
  private hostSockets = new Set<WebSocket>();
  private stageSockets = new Set<WebSocket>();
  private nornsSocket: WebSocket | null = null;
  private nornsStatus: NornsStatus | null = null;
  private nornsSeenAt: number | null = null;

  private grant: Grant | null = null;
  private lastWinnerClientId: string | null = null;
  private drawEndsAt: number | null = null;
  private endedAt: number | null = null;
  private endReason: EndReason | null = null;
  private pendingRedraw = false;
  /** Registrations were open before the draw, so ENDED should return to OPEN. */
  private reopenAfterEnd = true;

  killed = false;
  /**
   * The session this relay serves at its root.
   *
   * With one session per deployment the code in the path disambiguates nothing,
   * so the join link is just the domain: short enough to read aloud, small
   * enough to make a robust QR, and stable across restarts.
   */
  primary = false;

  readonly journal = new LogRing();
  private readonly latencyNorns = new Percentile();
  private readonly latencyRelay = new Percentile();
  private eventsIn = 0;
  private eventsDropped = 0;
  private pingCounter = 0;
  private dirty = true;

  constructor(
    readonly id: string,
    readonly hostToken: string,
    readonly nornsToken: string,
    private readonly relayConfig: RelayConfig,
  ) {
    this.joinKey = randomToken(9);
    this.note('info', `session ${id} created`);
  }

  // -------------------------------------------------------------------------
  // Journal & broadcast
  // -------------------------------------------------------------------------

  private note(level: 'info' | 'warn' | 'error', message: string): void {
    const entry = this.journal.push(level, message);
    log[level](`[${this.id}] ${message}`);
    const frame: HostOut = { t: 'log', ...entry };
    for (const ws of this.hostSockets) send(ws, frame);
  }

  /** Mark state as changed; the store's tick flushes at most once per tick. */
  private touch(): void {
    this.dirty = true;
  }

  get joinUrl(): string {
    const base = this.relayConfig.publicBaseUrl;
    const path = this.primary ? '' : `/j/${this.id}`;
    const key = this.config.requireJoinKey ? `?k=${this.joinKey}` : '';
    return `${base}${path || '/'}${key}`;
  }

  /** Whether a link must carry the rotating key to be accepted. */
  get joinKeyRequired(): boolean {
    return this.config.requireJoinKey;
  }

  get stageUrl(): string {
    return `${this.relayConfig.publicBaseUrl}/stage/${this.id}`;
  }

  get hostUrl(): string {
    return `${this.relayConfig.publicBaseUrl}/host/${this.id}#t=${this.hostToken}`;
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  private connectedParticipants(): Participant[] {
    return [...this.participants.values()].filter((p) => p.socket !== null && !p.blocked);
  }

  private winner(): Participant | null {
    if (!this.grant) return null;
    return this.participants.get(this.grant.clientId) ?? null;
  }

  publicState(now = Date.now()): PublicState {
    const connected = this.connectedParticipants();
    const winner = this.winner();
    return {
      sessionId: this.id,
      state: this.state,
      entrants: connected.filter((p) => p.entered).length,
      connected: connected.length,
      // Withheld at the source, not hidden in the UI: what the public socket
      // never carries cannot end up on a projector or in a stream.
      winnerPseudo: winner ? (this.config.hideNames ? 'un·e invité·e' : winner.pseudo || 'sans nom') : null,
      countdownMs: this.state === 'DRAWING' && this.drawEndsAt ? Math.max(0, this.drawEndsAt - now) : null,
      remainingMs: this.remainingMs(now),
      nornsOnline: this.nornsSocket !== null,
      nornsArmed: this.nornsStatus?.armed ?? false,
      killed: this.killed,
      namesHidden: this.config.hideNames,
      joinKeyRequired: this.config.requireJoinKey,
      preset: this.config.preset,
      macroNames: { x: this.config.macros.x.name, y: this.config.macros.y.name },
      endReason: this.state === 'ENDED' ? this.endReason : null,
    };
  }

  private remainingMs(now: number): number | null {
    if (!this.grant) return null;
    if (this.state === 'AWARDED') return Math.max(0, this.grant.activationDeadline - now);
    if (this.state === 'ACTIVE' && this.grant.expiresAt) return Math.max(0, this.grant.expiresAt - now);
    return null;
  }

  private grantView(): GrantView | null {
    if (!this.grant) return null;
    const winner = this.participants.get(this.grant.clientId);
    return {
      grantId: this.grant.grantId,
      clientId: this.grant.clientId,
      pseudo: winner?.pseudo || 'sans nom',
      awardedAt: this.grant.awardedAt,
      activationDeadline: this.grant.activationDeadline,
      startedAt: this.grant.startedAt,
      expiresAt: this.grant.expiresAt,
      revoked: this.grant.revoked,
    };
  }

  hostState(now = Date.now()): HostState {
    const useNorns = this.latencyNorns.count > 0;
    const source = useNorns ? this.latencyNorns : this.latencyRelay;
    const participants: ParticipantView[] = [...this.participants.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({
        clientId: p.clientId,
        pseudo: p.pseudo,
        entered: p.entered,
        connected: p.socket !== null,
        joinedAt: p.joinedAt,
        isWinner: this.grant?.clientId === p.clientId,
      }));

    const winner = this.winner();
    return {
      ...this.publicState(now),
      // Hiding names protects the audience's screen, not the operator's: the
      // host cannot moderate what it cannot read.
      winnerPseudo: winner ? winner.pseudo || 'sans nom' : null,
      config: this.config,
      joinUrl: this.joinUrl,
      stageUrl: this.stageUrl,
      participants,
      grant: this.grantView(),
      norns: this.nornsSocket
        ? { ...(this.nornsStatus ?? emptyNornsStatus(this.config.preset)), online: true }
        : this.nornsStatus
          ? { ...this.nornsStatus, online: false }
          : null,
      metrics: {
        latencyP50: source.p50,
        latencyP95: source.p95,
        latencySamples: source.count,
        latencySource: this.latencyNorns.count > 0 ? 'norns' : this.latencyRelay.count > 0 ? 'relay' : null,
        eventsIn: this.eventsIn,
        eventsDropped: this.eventsDropped,
      },
    };
  }

  /** Push current state to every connected surface. Called from the tick. */
  flush(force = false): void {
    if (!this.dirty && !force) return;
    this.dirty = false;
    const now = Date.now();
    const pub = this.publicState(now);

    const participantFrame: ParticipantOut = { t: 'state', state: pub };
    for (const p of this.participants.values()) send(p.socket, participantFrame);

    const hostFrame: HostOut = { t: 'state', state: this.hostState(now) };
    for (const ws of this.hostSockets) send(ws, hostFrame);

    const stageFrame: StageOut = { t: 'state', state: pub };
    for (const ws of this.stageSockets) send(ws, stageFrame);

    const nornsFrame: NornsOut = { t: 'state', state: pub };
    send(this.nornsSocket, nornsFrame);
  }

  // -------------------------------------------------------------------------
  // State machine
  // -------------------------------------------------------------------------

  private transition(to: SessionState, why: string): boolean {
    if (this.state === to) return true;
    if (!canTransition(this.state, to)) {
      this.note('warn', `illegal transition ${this.state} -> ${to} (${why})`);
      return false;
    }
    this.note('info', `${this.state} -> ${to} (${why})`);
    this.state = to;
    this.touch();
    return true;
  }

  open(): void {
    if (this.state === 'ENDED') this.transition('OPEN', 'reopen');
    else if (this.state === 'CLOSED') this.transition('OPEN', 'host opened registrations');
    else if (this.state !== 'OPEN') this.note('warn', `cannot open from ${this.state}`);
    this.reopenAfterEnd = true;
  }

  close(): void {
    this.reopenAfterEnd = false;
    if (this.state === 'ACTIVE' || this.state === 'AWARDED') {
      this.endGrant('revoked');
    }
    if (this.state === 'OPEN' || this.state === 'DRAWING' || this.state === 'ENDED') {
      this.drawEndsAt = null;
      this.transition('CLOSED', 'host closed registrations');
    }
  }

  /** FR-05: full reset — drop the grant, clear the lottery, keep participants. */
  reset(): void {
    if (this.grant) this.endGrant('reset');
    this.grant = null;
    this.drawEndsAt = null;
    this.endedAt = null;
    this.endReason = null;
    this.pendingRedraw = false;
    this.lastWinnerClientId = null;
    for (const p of this.participants.values()) this.setEntered(p, false);
    this.state = 'CLOSED';
    this.note('info', 'session reset');
    this.touch();
  }

  /**
   * A draw that does not happen must say so. K2 on the device and the button in
   * the console both leave the state untouched on refusal, which is
   * indistinguishable from a draw that worked — a dead button on stage. The
   * journal keeps the long version; the frame carries what fits on a 128 px
   * screen.
   */
  private refuseDraw(code: ErrorCode, short: string, why: string): void {
    this.note('warn', `draw refused: ${why}`);
    const frame = { t: 'error' as const, code, message: short };
    send(this.nornsSocket, frame satisfies NornsOut);
    for (const ws of this.hostSockets) send(ws, frame satisfies HostOut);
  }

  /** FR-05/FR-06: start the countdown. The winner is picked when it elapses. */
  draw(countdownMs?: number): void {
    if (this.state === 'ENDED') this.transition('OPEN', 'reopen before draw');
    if (this.state !== 'OPEN') {
      this.refuseDraw('bad_state', `no draw from ${this.state}`, `cannot draw from ${this.state}`);
      return;
    }
    const eligible = this.eligible();
    if (eligible.length === 0) {
      const entered = this.connectedParticipants().filter((p) => p.entered).length;
      this.refuseDraw(
        'no_entrants',
        entered === 0 ? 'nobody entered' : 'nobody to draw',
        entered === 0 ? 'nobody has entered' : 'no eligible participant',
      );
      return;
    }
    // Worth a line: the operator should know the exclusion was waived rather
    // than wonder why the same person came up twice.
    if (!this.config.winnerCanRewin && eligible.some((p) => p.clientId === this.lastWinnerClientId)) {
      this.note('info', 'nobody else is entered — the previous winner is back in the draw');
    }
    const ms = clamp(countdownMs ?? 5_000, 0, 60_000);
    this.drawEndsAt = Date.now() + ms;
    this.transition('DRAWING', `countdown ${Math.round(ms / 1000)}s, ${eligible.length} eligible`);
  }

  /**
   * PRD §7: the winner is chosen among participants connected and eligible at
   * the exact moment of the draw — so eligibility is recomputed here, not when
   * the countdown started.
   */
  private eligible(): Participant[] {
    const entered = this.connectedParticipants().filter((p) => p.entered);
    if (this.config.winnerCanRewin) return entered;
    const others = entered.filter((p) => p.clientId !== this.lastWinnerClientId);
    // The rule is "do not pick the last winner *over somebody else*". Taken
    // literally it also ends the lottery whenever they are the only one left —
    // one person in the room, or one phone at a rehearsal — and the only way
    // out is a session reset. So the exclusion applies while there is somebody
    // else to pick, and steps aside when there is not.
    return others.length > 0 ? others : entered;
  }

  private award(now: number): void {
    const pool = this.eligible();
    const chosen = pickOne(pool);
    this.drawEndsAt = null;

    if (!chosen) {
      this.note('warn', 'draw produced no winner (pool emptied during countdown)');
      this.transition('AWARDED', 'empty pool');
      this.endReason = 'no_show';
      this.finishToEnded('no_show', now);
      return;
    }

    const pad = this.startPad();
    // The phone numbers its frames from zero for each grant, so the replay
    // guard must start over too — otherwise a second win by the same device
    // gets every frame silently dropped as a replay.
    chosen.lastSeq = -1;
    this.grant = {
      grantId: randomToken(6),
      token: randomToken(24),
      clientId: chosen.clientId,
      awardedAt: now,
      activationDeadline: now + this.config.activationTimeoutMs,
      startedAt: null,
      expiresAt: null,
      revoked: false,
      lastX: pad.x,
      lastY: pad.y,
    };
    this.lastWinnerClientId = chosen.clientId;
    this.transition('AWARDED', `winner ${chosen.pseudo || chosen.clientId} out of ${pool.length}`);

    send(chosen.socket, this.wonFrame(pad.x, pad.y));
  }

  /** PRD §17 open question: where the pad dot starts. */
  private startPad(): { x: number; y: number } {
    switch (this.config.padStart) {
      case 'safe':
        return {
          x: ccToNorm(this.config.macros.x.safe, this.config.macros.x),
          y: ccToNorm(this.config.macros.y.safe, this.config.macros.y),
        };
      case 'last':
        return { x: this.nornsStatus?.outX ?? 0.5, y: this.nornsStatus?.outY ?? 0.5 };
      default:
        return { x: 0.5, y: 0.5 };
    }
  }

  /** AWARDED → ACTIVE: the winner touched the pad. */
  activate(p: Participant, token: string): void {
    if (!this.grant || this.state !== 'AWARDED') {
      send(p.socket, { t: 'error', code: 'bad_state', message: 'no pending grant' } satisfies ParticipantOut);
      return;
    }
    if (p.clientId !== this.grant.clientId || !tokenEquals(token, this.grant.token)) {
      this.note('warn', `activation refused for ${p.clientId}: bad token`);
      send(p.socket, { t: 'error', code: 'not_authorised', message: 'not the winner' } satisfies ParticipantOut);
      return;
    }
    const now = Date.now();
    this.grant.startedAt = now;
    this.grant.expiresAt = now + this.config.controlDurationMs;
    this.transition('ACTIVE', `pad activated by ${p.pseudo || p.clientId}`);

    send(p.socket, {
      t: 'active',
      expiresAt: this.grant.expiresAt,
      durationMs: this.config.controlDurationMs,
      rateHz: this.config.rateHz,
    } satisfies ParticipantOut);

    send(this.nornsSocket, {
      t: 'grant',
      grantId: this.grant.grantId,
      expiresAt: this.grant.expiresAt,
      pad: { x: this.grant.lastX, y: this.grant.lastY },
    } satisfies NornsOut);
  }

  /** FR-13: tell the Norns to apply the safe behaviour, then land in ENDED. */
  private endGrant(reason: EndReason): void {
    if (!this.grant) return;
    this.grant.revoked = true;
    const winner = this.winner();
    send(winner?.socket, { t: 'ended', reason } satisfies ParticipantOut);
    send(this.nornsSocket, {
      t: 'end',
      reason,
      behavior: this.config.endBehavior,
    } satisfies NornsOut);
    this.note('info', `control ended: ${reason}`);
  }

  private finishToEnded(reason: EndReason, now: number): void {
    this.endReason = reason;
    this.endedAt = now;
    this.pendingRedraw = reason === 'no_show' && this.config.autoRedrawOnNoShow;
    if (this.state !== 'ENDED') this.transition('ENDED', reason);
  }

  revoke(): void {
    if (!this.grant || (this.state !== 'ACTIVE' && this.state !== 'AWARDED')) {
      this.note('warn', 'revoke ignored: no live grant');
      return;
    }
    this.endGrant('revoked');
    this.finishToEnded('revoked', Date.now());
  }

  /** FR-12: software emergency stop. Also propagated to the Norns immediately. */
  kill(source: 'host' | 'norns'): void {
    this.killed = true;
    send(this.nornsSocket, { t: 'kill' } satisfies NornsOut);
    if (this.grant && (this.state === 'ACTIVE' || this.state === 'AWARDED')) {
      this.endGrant('killed');
      this.finishToEnded('killed', Date.now());
    }
    this.note('warn', `KILL from ${source}`);
    this.touch();
  }

  unkill(): void {
    this.killed = false;
    this.note('info', 'kill cleared');
    this.touch();
  }

  configure(patch: Record<string, unknown>, source: 'host' | 'norns'): void {
    this.config = applyConfigPatch(this.config, patch);
    this.note('info', `config updated by ${source}`);
    send(this.nornsSocket, { t: 'config', config: this.config } satisfies NornsOut);
    this.touch();
  }

  /** PRD §11: block an abusive device. */
  block(clientId: string): void {
    const p = this.participants.get(clientId);
    if (!p) return;
    p.blocked = true;
    p.entered = false; // socket closes immediately below, so no frame to send
    send(p.socket, { t: 'error', code: 'blocked', message: 'blocked by host' } satisfies ParticipantOut);
    p.socket?.close(4003, 'blocked');
    p.socket = null;
    if (this.grant?.clientId === clientId) this.revoke();
    this.note('warn', `blocked ${clientId}`);
    this.touch();
  }

  /** PRD §11: invalidate the QR code / join link without disturbing the live set. */
  rotateJoinKey(): void {
    this.joinKey = randomToken(9);
    this.note('warn', 'join link rotated — previous QR code is dead');
    this.touch();
  }

  // -------------------------------------------------------------------------
  // Participants
  // -------------------------------------------------------------------------

  isFull(): boolean {
    return this.connectedParticipants().length >= this.relayConfig.maxParticipants;
  }

  /**
   * Attach a socket to a device identity. A returning device reuses its record,
   * which is what makes reconnection inside the window seamless (NFR-05), and
   * what enforces one lottery entry per device (PRD §7).
   */
  attachParticipant(clientId: string, pseudo: string, ws: WebSocket): Participant | null {
    const now = Date.now();
    let p = this.participants.get(clientId);

    if (p?.blocked) {
      send(ws, { t: 'error', code: 'blocked', message: 'blocked by host' } satisfies ParticipantOut);
      ws.close(4003, 'blocked');
      return null;
    }

    if (!p) {
      if (this.isFull()) {
        send(ws, { t: 'error', code: 'session_full', message: 'session full' } satisfies ParticipantOut);
        ws.close(4004, 'full');
        return null;
      }
      p = {
        clientId,
        // A device that brought no name still gets one, so the pad can be
        // claimed with a single tap and the stage always has somebody to name.
        // A name it did bring is moderated before it is ever broadcast.
        pseudo: this.vetName(pseudo),
        entered: false,
        joinedAt: now,
        lastSeenAt: now,
        socket: ws,
        disconnectedAt: null,
        blocked: false,
        clockOffsetMs: null,
        bestRttMs: null,
        pendingPing: null,
        bucket: new TokenBucket(this.burstCapacity(), this.config.rateHz * 1.5, now),
        lastSeq: -1,
      };
      this.participants.set(clientId, p);
    } else {
      // Same device came back: replace the socket, keep the lottery entry.
      if (p.socket && p.socket !== ws) p.socket.close(4000, 'replaced by newer connection');
      p.socket = ws;
      p.disconnectedAt = null;
      if (pseudo) p.pseudo = this.vetName(pseudo);
      else if (!p.pseudo) p.pseudo = this.freshStageName();
    }
    p.lastSeenAt = now;
    this.touch();

    send(ws, {
      t: 'welcome',
      clientId: p.clientId,
      pseudo: p.pseudo,
      entered: p.entered,
      state: this.publicState(now),
    } satisfies ParticipantOut);

    // A winner reconnecting inside the window gets its pad back (NFR-05).
    if (this.grant && this.grant.clientId === clientId && !this.grant.revoked) {
      if (this.state === 'AWARDED' || this.state === 'ACTIVE') {
        send(ws, this.wonFrame(this.grant.lastX, this.grant.lastY));
      }
      if (this.state === 'ACTIVE' && this.grant.expiresAt) {
        send(ws, {
          t: 'active',
          expiresAt: this.grant.expiresAt,
          durationMs: this.config.controlDurationMs,
          rateHz: this.config.rateHz,
        } satisfies ParticipantOut);
      }
    }

    return p;
  }

  /** The frame that turns a phone into the pad holder. */
  private wonFrame(padX: number, padY: number): ParticipantOut {
    const grant = this.grant!;
    return {
      t: 'won',
      grantToken: grant.token,
      grantId: grant.grantId,
      activationDeadline: grant.activationDeadline,
      durationMs: this.config.controlDurationMs,
      pad: { x: padX, y: padY },
      macroNames: { x: this.config.macros.x.name, y: this.config.macros.y.name },
    };
  }

  /**
   * A name safe to project: the requested one if it passes, an assigned stage
   * name otherwise. Used on the `hello` path, where there is no socket to
   * answer on yet.
   */
  private vetName(requested: string): string {
    if (!requested) return this.freshStageName();
    const verdict = moderateName(requested);
    if (!verdict.blocked) return requested;
    const replacement = this.freshStageName();
    this.note('warn', `name refused on join (${verdict.category}: ${verdict.reason}) — now "${replacement}"`);
    return replacement;
  }

  /** A stage name no one else in this session is already using. */
  private freshStageName(): string {
    return generateStageName([...this.participants.values()].map((p) => p.pseudo));
  }

  private burstCapacity(): number {
    return Math.max(10, Math.ceil(this.config.rateHz * 2));
  }

  detachParticipant(p: Participant, ws: WebSocket): void {
    if (p.socket !== ws) return; // already replaced by a newer connection
    p.socket = null;
    p.disconnectedAt = Date.now();
    this.touch();
  }

  /**
   * Apply a requested name.
   *
   * A blocked name is substituted with a fresh assigned one rather than
   * refused: an explicit rejection tells the author which spelling failed, and
   * they will find one that passes before the draw fires. The host is told, the
   * participant only learns the name in force.
   */
  setPseudo(p: Participant, requested: string): void {
    const cleaned = sanitizePseudo(requested, p.pseudo);
    const verdict = moderateName(cleaned);

    if (verdict.blocked) {
      const replacement = this.freshStageName();
      this.note(
        'warn',
        `name refused for ${p.clientId} (${verdict.category}: ${verdict.reason}) — now "${replacement}"`,
      );
      p.pseudo = replacement;
      send(p.socket, { t: 'pseudo', pseudo: replacement, substituted: true } satisfies ParticipantOut);
      this.touch();
      return;
    }

    if (cleaned !== p.pseudo) {
      p.pseudo = cleaned;
      send(p.socket, { t: 'pseudo', pseudo: cleaned, substituted: false } satisfies ParticipantOut);
      this.touch();
    }
  }

  /** FR-15 backstop: hide every participant name from the projected view. */
  setHideNames(hidden: boolean): void {
    if (this.config.hideNames === hidden) return;
    this.config.hideNames = hidden;
    this.note('warn', hidden ? 'participant names hidden from the public view' : 'participant names shown again');
    this.touch();
  }

  enter(p: Participant): void {
    if (this.state !== 'OPEN') {
      send(p.socket, { t: 'error', code: 'bad_state', message: 'lottery is not open' } satisfies ParticipantOut);
      // Confirm the truth anyway: a phone that thinks it is entered would
      // otherwise sit on a waiting screen that will never come true.
      send(p.socket, { t: 'entry', entered: p.entered } satisfies ParticipantOut);
      return;
    }
    this.setEntered(p, true);
  }

  leave(p: Participant): void {
    this.setEntered(p, false);
  }

  /**
   * Single place the entry flag changes, so the owner is always told.
   *
   * The relay is the authority on who is in the lottery, and it can change that
   * without the participant acting — a host reset, or a draw they were excluded
   * from. Any path that mutates this silently produces a phone showing a
   * promise the relay will not keep.
   */
  private setEntered(p: Participant, entered: boolean): void {
    if (p.entered === entered) return;
    p.entered = entered;
    send(p.socket, { t: 'entry', entered } satisfies ParticipantOut);
    this.touch();
  }

  /** Record a ping/pong round trip and refine the phone's clock offset. */
  notePong(p: Participant, id: number, clientTs: number, now: number): void {
    p.lastSeenAt = now;
    const pending = p.pendingPing;
    if (!pending || pending.id !== id) return;
    p.pendingPing = null;
    const rtt = now - pending.ts;
    if (rtt < 0 || rtt > 10_000) return;
    // Keep the offset from the fastest round trip seen: least contaminated.
    if (p.bestRttMs === null || rtt <= p.bestRttMs) {
      p.bestRttMs = rtt;
      p.clockOffsetMs = clientTs - (pending.ts + rtt / 2);
    }
  }

  /**
   * FR-09 / §9.1: validate a pad sample and publish it to the Norns channel.
   *
   * Rejected: unauthorised sender, wrong or expired token, revoked grant,
   * replayed or out-of-order sequence, over-rate traffic, active kill.
   */
  handleXy(
    p: Participant,
    msg: { grantToken: string; x: number; y: number; seq: number; ts: number },
    now: number,
  ): void {
    p.lastSeenAt = now;
    this.eventsIn++;

    const grant = this.grant;
    if (!grant || this.state !== 'ACTIVE' || grant.revoked) {
      this.eventsDropped++;
      send(p.socket, { t: 'error', code: 'not_authorised', message: 'no active grant' } satisfies ParticipantOut);
      return;
    }
    if (p.clientId !== grant.clientId || !tokenEquals(msg.grantToken, grant.token)) {
      this.eventsDropped++;
      send(p.socket, { t: 'error', code: 'not_authorised', message: 'not the winner' } satisfies ParticipantOut);
      return;
    }
    if (grant.expiresAt !== null && now > grant.expiresAt) {
      this.eventsDropped++;
      send(p.socket, { t: 'error', code: 'expired', message: 'control window over' } satisfies ParticipantOut);
      return;
    }
    if (this.killed) {
      this.eventsDropped++;
      return;
    }
    // Replay / reordering guard (PRD §11).
    if (msg.seq <= p.lastSeq) {
      this.eventsDropped++;
      return;
    }
    if (!p.bucket.take(now)) {
      this.eventsDropped++;
      send(p.socket, { t: 'error', code: 'rate_limited', message: 'slow down' } satisfies ParticipantOut);
      return;
    }

    p.lastSeq = msg.seq;
    grant.lastX = msg.x;
    grant.lastY = msg.y;

    // Convert the phone's clock into server time so latency is measurable.
    const originTs = p.clockOffsetMs === null ? now : msg.ts - p.clockOffsetMs;
    const latency = now - originTs;
    if (latency >= 0 && latency < MAX_PLAUSIBLE_LATENCY_MS) this.latencyRelay.push(latency);

    send(this.nornsSocket, {
      t: 'xy',
      grantId: grant.grantId,
      seq: msg.seq,
      x: msg.x,
      y: msg.y,
      originTs,
      relayTs: now,
    } satisfies NornsOut);
  }

  // -------------------------------------------------------------------------
  // Host & stage & Norns sockets
  // -------------------------------------------------------------------------

  attachHost(ws: WebSocket): void {
    this.hostSockets.add(ws);
    send(ws, { t: 'welcome', state: this.hostState() } satisfies HostOut);
    for (const entry of this.journal.recent()) send(ws, { t: 'log', ...entry } satisfies HostOut);
  }

  detachHost(ws: WebSocket): void {
    this.hostSockets.delete(ws);
  }

  attachStage(ws: WebSocket): void {
    this.stageSockets.add(ws);
    send(ws, { t: 'state', state: this.publicState() } satisfies StageOut);
  }

  detachStage(ws: WebSocket): void {
    this.stageSockets.delete(ws);
  }

  attachNorns(ws: WebSocket, firmware?: string): void {
    if (this.nornsSocket && this.nornsSocket !== ws) {
      this.nornsSocket.close(4000, 'replaced by newer Norns connection');
    }
    this.nornsSocket = ws;
    this.nornsSeenAt = Date.now();
    this.note('info', `Norns connected${firmware ? ` (${firmware})` : ''}`);
    send(ws, {
      t: 'welcome',
      sessionId: this.id,
      config: this.config,
      state: this.publicState(),
    } satisfies NornsOut);
    if (this.killed) send(ws, { t: 'kill' } satisfies NornsOut);
    // Re-arm a grant that survived a Norns restart mid-performance.
    if (this.state === 'ACTIVE' && this.grant?.expiresAt) {
      send(ws, {
        t: 'grant',
        grantId: this.grant.grantId,
        expiresAt: this.grant.expiresAt,
        pad: { x: this.grant.lastX, y: this.grant.lastY },
      } satisfies NornsOut);
    }
    this.touch();
  }

  detachNorns(ws: WebSocket): void {
    if (this.nornsSocket !== ws) return;
    this.nornsSocket = null;
    this.note('warn', 'Norns disconnected');
    this.touch();
  }

  updateNornsStatus(status: Omit<NornsStatus, 'online'>, now: number): void {
    const previous = this.nornsStatus;
    this.nornsStatus = { ...status, online: true };
    this.nornsSeenAt = now;
    // Only wake the UI when something visible actually moved.
    if (
      !previous ||
      previous.armed !== status.armed ||
      previous.killed !== status.killed ||
      previous.ccX !== status.ccX ||
      previous.ccY !== status.ccY ||
      previous.rejected !== status.rejected
    ) {
      this.touch();
    }
  }

  noteNornsLatency(ms: number): void {
    if (ms >= 0 && ms < MAX_PLAUSIBLE_LATENCY_MS) this.latencyNorns.push(ms);
  }

  hasNorns(): boolean {
    return this.nornsSocket !== null;
  }

  // -------------------------------------------------------------------------
  // Tick — the only place time-based transitions happen
  // -------------------------------------------------------------------------

  tick(now: number): void {
    // 1. Presence: expire silent and long-gone participants (FR-04).
    for (const [clientId, p] of this.participants) {
      if (p.socket) {
        if (now - p.lastSeenAt > this.relayConfig.idleTimeoutMs) {
          this.note('warn', `participant ${clientId} timed out`);
          p.socket.close(4008, 'idle');
          p.socket = null;
          p.disconnectedAt = now;
          this.touch();
        }
      } else if (p.disconnectedAt !== null && now - p.disconnectedAt > this.relayConfig.reconnectWindowMs) {
        this.participants.delete(clientId);
        this.touch();
      }
    }

    // 2. Countdown → winner (FR-06).
    if (this.state === 'DRAWING' && this.drawEndsAt !== null && now >= this.drawEndsAt) {
      this.award(now);
    }

    // 3. Grant lifecycle (FR-08, FR-13).
    if (this.grant && !this.grant.revoked) {
      if (this.state === 'AWARDED' && now >= this.grant.activationDeadline) {
        this.note('warn', 'winner never touched the pad');
        this.endGrant('no_show');
        this.finishToEnded('no_show', now);
      } else if (this.state === 'ACTIVE' && this.grant.expiresAt !== null && now >= this.grant.expiresAt) {
        this.endGrant('expired');
        this.finishToEnded('expired', now);
      } else if (this.state === 'ACTIVE') {
        const winner = this.winner();
        const gone = !winner || (winner.disconnectedAt !== null && now - winner.disconnectedAt > this.config.disconnectGraceMs);
        if (gone) {
          this.note('warn', 'winner disconnected past the grace window');
          this.endGrant('disconnected');
          this.finishToEnded('disconnected', now);
        }
      }
    }

    // 4. ENDED → OPEN (or CLOSED), with the optional automatic redraw (§16).
    if (this.state === 'ENDED' && this.endedAt !== null && now - this.endedAt >= ENDED_DISPLAY_MS) {
      this.grant = null;
      this.endedAt = null;
      if (this.reopenAfterEnd) {
        this.transition('OPEN', 'registrations reopened');
        if (this.pendingRedraw) {
          this.pendingRedraw = false;
          this.note('info', 'automatic redraw after no-show');
          this.draw(AUTO_REDRAW_COUNTDOWN_MS);
        }
      } else {
        this.transition('CLOSED', 'session closed after control window');
      }
    }

    // 5. Norns considered offline if silent for too long.
    if (this.nornsSocket && this.nornsSeenAt !== null && now - this.nornsSeenAt > 10_000) {
      this.note('warn', 'Norns silent for 10 s');
      this.nornsSeenAt = now;
    }

    // 6. Heartbeats, which also drive clock-offset estimation.
    this.heartbeat(now);

    // 7. The overlay's moving numbers, to stage sockets only.
    this.pushLive(now);
  }

  /**
   * The pad position and its counters, for `/stage/<id>/main`. Sent on its own
   * clock rather than through `flush`, so a gesture never marks the session
   * dirty and never reaches a participant socket.
   */
  private pushLive(now: number): void {
    if (this.stageSockets.size === 0) return;
    if (now - this.lastLive < LIVE_PUSH_MS) return;
    this.lastLive = now;

    const playing = this.state === 'ACTIVE' && this.grant !== null && !this.grant.revoked;
    const source = this.latencyNorns.count > 0 ? this.latencyNorns : this.latencyRelay;
    const live: StageLive = {
      x: playing ? this.grant!.lastX : null,
      y: playing ? this.grant!.lastY : null,
      // Only while the device is actually connected: `nornsStatus` is kept
      // after a disconnect so the host can still read the last known state, and
      // reporting that here would publish a position nothing is holding.
      outX: this.nornsSocket ? (this.nornsStatus?.outX ?? null) : null,
      outY: this.nornsSocket ? (this.nornsStatus?.outY ?? null) : null,
      latencyP50: source.p50,
      latencyP95: source.p95,
      latencySource: this.latencyNorns.count > 0 ? 'norns' : this.latencyRelay.count > 0 ? 'relay' : null,
      eventsIn: this.eventsIn,
      eventsDropped: this.eventsDropped,
    };
    const frame: StageOut = { t: 'live', live };
    for (const ws of this.stageSockets) send(ws, frame);
  }

  private lastLive = 0;
  private lastHeartbeat = 0;

  private heartbeat(now: number): void {
    if (now - this.lastHeartbeat < this.relayConfig.heartbeatMs) return;
    this.lastHeartbeat = now;
    for (const p of this.participants.values()) {
      if (!p.socket) continue;
      const id = ++this.pingCounter;
      p.pendingPing = { id, ts: now };
      send(p.socket, { t: 'ping', id, ts: now } satisfies ParticipantOut);
    }
    const id = ++this.pingCounter;
    for (const ws of this.hostSockets) send(ws, { t: 'ping', id, ts: now } satisfies HostOut);
    for (const ws of this.stageSockets) send(ws, { t: 'ping', id, ts: now } satisfies StageOut);
    send(this.nornsSocket, { t: 'ping', id, ts: now } satisfies NornsOut);
  }

  /** Called when the process shuts down: fail safe, not silent (§16). */
  shutdown(): void {
    if (this.grant && !this.grant.revoked) this.endGrant('revoked');
    for (const p of this.participants.values()) p.socket?.close(1001, 'relay shutting down');
    for (const ws of this.hostSockets) ws.close(1001, 'relay shutting down');
    for (const ws of this.stageSockets) ws.close(1001, 'relay shutting down');
    this.nornsSocket?.close(1001, 'relay shutting down');
  }
}

function emptyNornsStatus(preset: string): NornsStatus {
  return {
    online: true,
    armed: false,
    killed: false,
    preset,
    targetX: 0.5,
    targetY: 0.5,
    outX: 0.5,
    outY: 0.5,
    ccX: 0,
    ccY: 0,
    midiBackend: 'unknown',
    // The device has not reported a status yet, so nothing is known about where
    // its output goes. Not the same as knowing the port is empty.
    midiPort: null,
    lastMessageAt: null,
    rejected: 0,
  };
}
