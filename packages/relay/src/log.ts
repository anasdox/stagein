export type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = ORDER.info;

export function setLevel(level: Level): void {
  threshold = ORDER[level] ?? ORDER.info;
}

function emit(level: Level, scope: string, message: string, extra?: unknown): void {
  if (ORDER[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  if (extra === undefined) console.log(line);
  else console.log(line, extra);
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => emit('debug', scope, m, e),
    info: (m: string, e?: unknown) => emit('info', scope, m, e),
    warn: (m: string, e?: unknown) => emit('warn', scope, m, e),
    error: (m: string, e?: unknown) => emit('error', scope, m, e),
  };
}

export interface LogEntry {
  at: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

/** Per-session technical journal shown in the host UI (PRD §9, role "opérateur"). */
export class LogRing {
  private entries: LogEntry[] = [];
  constructor(private readonly capacity = 200) {}

  push(level: LogEntry['level'], message: string): LogEntry {
    const entry: LogEntry = { at: Date.now(), level, message };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.shift();
    return entry;
  }

  recent(n = 60): LogEntry[] {
    return this.entries.slice(-n);
  }
}
