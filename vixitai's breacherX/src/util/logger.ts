/** Minimal leveled logger writing to stderr (keeps stdout clean for machine output). */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

let currentLevel: LogLevel =
  (process.env.BREACHERX_LOG_LEVEL as LogLevel | undefined) ?? "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function emit(level: LogLevel, label: string, args: unknown[]): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[currentLevel]) return;
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.error(`[${ts}] ${label}`, ...args);
}

export const log = {
  debug: (...args: unknown[]) => emit("debug", "DEBUG", args),
  info: (...args: unknown[]) => emit("info", "INFO ", args),
  warn: (...args: unknown[]) => emit("warn", "WARN ", args),
  error: (...args: unknown[]) => emit("error", "ERROR", args),
};
