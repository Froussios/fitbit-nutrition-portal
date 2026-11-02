/**
 * In-memory debug log for the proof of concept.
 *
 * Everything goes to the browser console and to a ring buffer that the Debug
 * log panel shows and copies. Never pass access tokens or other credentials:
 * callers log request metadata and response bodies only.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  readonly time: Date;
  readonly level: LogLevel;
  readonly source: string;
  readonly message: string;
  readonly data?: unknown;
}

const MAX_ENTRIES = 300;
const entries: LogEntry[] = [];
const listeners = new Set<() => void>();

export function log(level: LogLevel, source: string, message: string, data?: unknown): void {
  const entry: LogEntry = data === undefined ? { time: new Date(), level, source, message } : { time: new Date(), level, source, message, data };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  const line = `[${source}] ${message}`;
  if (data === undefined) console[level](line);
  else console[level](line, data);
  for (const l of listeners) l();
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export function logger(source: string): Logger {
  return {
    debug: (m, d) => log("debug", source, m, d),
    info: (m, d) => log("info", source, m, d),
    warn: (m, d) => log("warn", source, m, d),
    error: (m, d) => log("error", source, m, d),
  };
}

export function logEntries(): readonly LogEntry[] {
  return entries;
}

export function clearLog(): void {
  entries.length = 0;
  for (const l of listeners) l();
}

export function onLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Turns errors (including our HealthApiError fields) into plain data that survives JSON. */
export function describeError(e: unknown): unknown {
  if (e instanceof Error) {
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e)) extra[k] = v;
    return { name: e.name, message: e.message, ...extra, stack: e.stack?.split("\n").slice(0, 6).join("\n") };
  }
  return e;
}

/** Shortens long strings (response bodies) for the log. */
export function truncate(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text;
}

function formatData(data: unknown): string {
  if (data === undefined) return "";
  if (typeof data === "string") return `\n    ${data.replace(/\n/g, "\n    ")}`;
  try {
    return `\n    ${JSON.stringify(data, null, 2).replace(/\n/g, "\n    ")}`;
  } catch {
    return `\n    ${String(data)}`;
  }
}

export function formatEntry(e: LogEntry): string {
  return `${e.time.toISOString()} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${e.message}${formatData(e.data)}`;
}

/** The whole log as text, with an environment header, ready to paste into an issue. */
export function formatLog(environment: Record<string, string>): string {
  const header = Object.entries(environment).map(([k, v]) => `${k}: ${v}`);
  return [...header, "", ...entries.map(formatEntry)].join("\n");
}

/** Records uncaught errors and unhandled promise rejections. */
export function installGlobalErrorHandlers(): void {
  const l = logger("window");
  window.addEventListener("error", (ev) => {
    l.error(`Uncaught error: ${ev.message}`, { source: ev.filename, line: ev.lineno, column: ev.colno, error: describeError(ev.error) });
  });
  window.addEventListener("unhandledrejection", (ev) => {
    l.error("Unhandled promise rejection", describeError(ev.reason));
  });
}
