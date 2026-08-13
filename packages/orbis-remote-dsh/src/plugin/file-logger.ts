import { appendFile, chmod, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 32 * 1024;

export type OrbisDshLogLevel = "debug" | "error" | "info" | "warn";
export type OrbisDshLogFields = Readonly<Record<string, boolean | number | string | null>>;

export interface OrbisDshLogger {
  readonly path?: string;
  start(): Promise<void>;
  debug(event: string, fields?: OrbisDshLogFields): void;
  info(event: string, fields?: OrbisDshLogFields): void;
  warn(event: string, fields?: OrbisDshLogFields): void;
  error(event: string, fields?: OrbisDshLogFields): void;
  close(): Promise<void>;
}

export interface OrbisDshFileLoggerOptions {
  readonly maxBytes?: number;
}

export interface OrbisDshErrorLogOptions {
  /** Omit potentially payload-bearing error text from request diagnostics. */
  readonly includeMessage?: boolean;
}

export const ORBIS_DSH_NOOP_LOGGER: OrbisDshLogger = Object.freeze({
  start: async () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: async () => undefined,
});

function safeText(value: string, maximum = 4_096): string {
  return value
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(
      /((?:access[_-]?token|authorization|password|pairing[_-]?secret|private[_-]?key|secret|token)\s*[:=]\s*)[^\s,;]+/giu,
      "$1[REDACTED]",
    )
    .slice(0, maximum);
}

function safeField(key: string, value: boolean | number | string | null) {
  if (
    /(?:access[_-]?token|authorization|password|pairing[_-]?secret|private[_-]?key|secret|token)/iu.test(
      key,
    )
  ) {
    return "[REDACTED]";
  }
  return typeof value === "string" ? safeText(value) : value;
}

export function orbisDshErrorFields(
  error: unknown,
  options: OrbisDshErrorLogOptions = {},
): OrbisDshLogFields {
  if (error instanceof Error) {
    const candidate = error as Error & {
      readonly code?: unknown;
      readonly retryable?: unknown;
      readonly serverCode?: unknown;
    };
    const includeMessage = options.includeMessage ?? true;
    return {
      errorName: error.name,
      ...(includeMessage
        ? {
            errorMessage: safeText(error.message),
            ...(error.stack === undefined ? {} : { errorStack: safeText(error.stack) }),
          }
        : { errorMessageBytes: Buffer.byteLength(error.message, "utf8") }),
      ...(typeof candidate.code === "string" ? { errorCode: candidate.code } : {}),
      ...(typeof candidate.serverCode === "string"
        ? { errorServerCode: candidate.serverCode }
        : {}),
      ...(typeof candidate.retryable === "boolean" ? { errorRetryable: candidate.retryable } : {}),
    };
  }
  const message = String(error);
  return options.includeMessage === false
    ? { errorMessageBytes: Buffer.byteLength(message, "utf8") }
    : { errorMessage: safeText(message) };
}

function lineFor(
  level: OrbisDshLogLevel,
  event: string,
  fields: OrbisDshLogFields | undefined,
): string {
  const record = {
    at: new Date().toISOString(),
    component: "orbis-dsh-server",
    event: safeText(event, 256),
    level,
    ...Object.fromEntries(
      Object.entries(fields ?? {}).map(([key, value]) => [key, safeField(key, value)]),
    ),
  };
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized, "utf8") + 1 <= MAX_LINE_BYTES) return `${serialized}\n`;
  return `${JSON.stringify({
    at: record.at,
    component: record.component,
    event: record.event,
    level: record.level,
    fieldsTruncated: true,
  })}\n`;
}

/** Owner-only, bounded JSONL diagnostics for the DSH server process. */
export class OrbisDshFileLogger implements OrbisDshLogger {
  readonly path: string;

  private readonly maxBytes: number;
  private bytes = 0;
  private closed = false;
  private disabled = false;
  private started = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(path: string, options: OrbisDshFileLoggerOptions = {}) {
    const normalized = path.trim();
    if (normalized.length === 0) throw new Error("The Orbis DSH log path is invalid");
    this.path = normalized;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1_024) {
      throw new Error("The Orbis DSH log size limit is invalid");
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      const directory = dirname(this.path);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      try {
        const metadata = await stat(this.path);
        await chmod(this.path, 0o600);
        this.bytes = metadata.size;
        if (this.bytes >= this.maxBytes) await this.rotate();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } catch {
      // Diagnostics must never prevent the DSH host from starting.
      this.disabled = true;
    }
  }

  debug(event: string, fields?: OrbisDshLogFields): void {
    this.enqueue(lineFor("debug", event, fields));
  }

  info(event: string, fields?: OrbisDshLogFields): void {
    this.enqueue(lineFor("info", event, fields));
  }

  warn(event: string, fields?: OrbisDshLogFields): void {
    this.enqueue(lineFor("warn", event, fields));
  }

  error(event: string, fields?: OrbisDshLogFields): void {
    this.enqueue(lineFor("error", event, fields));
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }

  private enqueue(line: string): void {
    if (!this.started || this.disabled || this.closed) return;
    const operation = this.tail.then(async () => {
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (this.bytes > 0 && this.bytes + lineBytes > this.maxBytes) await this.rotate();
      await appendFile(this.path, line, { encoding: "utf8", mode: 0o600 });
      await chmod(this.path, 0o600);
      this.bytes += lineBytes;
    });
    this.tail = operation.catch(() => {
      // A diagnostics sink is passive and must not affect encrypted delivery.
      this.disabled = true;
    });
  }

  private async rotate(): Promise<void> {
    const backup = `${this.path}.1`;
    await unlink(backup).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    await rename(this.path, backup);
    await chmod(backup, 0o600);
    this.bytes = 0;
  }
}
