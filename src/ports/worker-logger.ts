/**
 * Minimal logging boundary for the worker. The worker must be able to explain
 * what it claimed, skipped, retried or rejected without depending on a concrete
 * logging stack, so callers inject an implementation.
 */
export interface WorkerLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

/** Drops all log output. Intended for tests and for embedded/no-op contexts. */
export const silentWorkerLogger: WorkerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function write(
  sink: (line: string) => void,
  level: string,
  message: string,
  meta: unknown,
): void {
  sink(`[worker:${level}] ${message}${meta === undefined ? '' : ` ${safeMeta(meta)}`}`);
}

function safeMeta(meta: unknown): string {
  if (typeof meta === 'string') return meta;
  try {
    return JSON.stringify(meta) ?? String(meta);
  } catch {
    return String(meta);
  }
}

/** Default logger: writes to the console. Wire a structured logger in production. */
export const consoleWorkerLogger: WorkerLogger = {
  info: (message, meta) => write((line) => console.log(line), 'info', message, meta),
  warn: (message, meta) => write((line) => console.warn(line), 'warn', message, meta),
  error: (message, meta) => write((line) => console.error(line), 'error', message, meta),
};
