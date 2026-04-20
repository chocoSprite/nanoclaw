/**
 * Structured JSON logger — emits pino-compatible lines so the output can be
 * parsed by the dashboard `/logs` stream and made human-readable via
 * `pino-pretty` (see `npm run tail`).
 *
 * Schema per line (one JSON object, terminated by newline):
 *   { "level": 30, "time": 1745..., "pid": 12345, "msg": "...", "...extras": ... }
 *
 * Level numeric values match pino:
 *   debug 20 · info 30 · warn 40 · error 50 · fatal 60
 *
 * warn and above go to stderr so launchd's StandardErrorPath keeps its split.
 */
const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

const threshold =
  LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

function serializeErr(err: unknown): Record<string, unknown> | string {
  if (err instanceof Error) {
    const base: Record<string, unknown> = {
      type: err.constructor.name,
      message: err.message,
      stack: err.stack,
    };
    // Walk err.cause chain — pino-pretty renders this natively.
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined) {
      base.cause = serializeErr(cause);
    }
    return base;
  }
  if (err === null || err === undefined) return String(err);
  if (typeof err === 'object') return err as Record<string, unknown>;
  return String(err);
}

function replacer(_key: string, value: unknown): unknown {
  // Avoid circular JSON explosions; best-effort only.
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function emit(
  level: Level,
  dataOrMsg: Record<string, unknown> | string,
  msg?: string,
): void {
  if (LEVELS[level] < threshold) return;

  const record: Record<string, unknown> = {
    level: LEVELS[level],
    time: Date.now(),
    pid: process.pid,
  };

  if (typeof dataOrMsg === 'string') {
    record.msg = dataOrMsg;
  } else {
    for (const [k, v] of Object.entries(dataOrMsg)) {
      record[k] = k === 'err' ? serializeErr(v) : v;
    }
    if (msg !== undefined) record.msg = msg;
  }

  const line = JSON.stringify(record, replacer) + '\n';
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(line);
}

export const logger = {
  debug: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    emit('debug', dataOrMsg, msg),
  info: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    emit('info', dataOrMsg, msg),
  warn: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    emit('warn', dataOrMsg, msg),
  error: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    emit('error', dataOrMsg, msg),
  fatal: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    emit('fatal', dataOrMsg, msg),
};

// Route uncaught errors through logger so they get structured timestamps.
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
