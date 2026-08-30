import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, resolve } from "node:path";

const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;

export type OrbisDshRawEventRecordingState = "failed" | "idle" | "recording" | "stopped";

export interface OrbisDshRawEventRecordingStatus {
  readonly bytes: number;
  readonly error?: string;
  readonly eventCount: number;
  readonly exportAvailable: boolean;
  readonly recordingId?: string;
  readonly startedAt?: string;
  readonly state: OrbisDshRawEventRecordingState;
  readonly stoppedAt?: string;
}

export interface OrbisDshRawEventExportMetadata {
  readonly bytes: number;
  readonly filename: string;
  readonly path: string;
}

export interface OrbisDshRawEventRecorderOptions {
  /** Inject a stable ID generator for deterministic tests. */
  readonly createId?: () => string;
  /** Inject a stable wall clock for deterministic tests. */
  readonly now?: () => Date;
}

type RecordingHeader = {
  readonly format: "orbis-dsh-raw-events";
  readonly kind: "header";
  readonly recordingId: string;
  readonly startedAt: string;
  readonly version: 1;
};

type RecordingFooter = {
  readonly bytes: number;
  readonly error?: string;
  readonly eventCount: number;
  readonly kind: "footer";
  readonly recordingId: string;
  readonly status: "failed" | "stopped";
  readonly stoppedAt: string;
};

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}

function assertRecordingId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new Error("The Orbis DSH recording ID is invalid");
  }
  return value;
}

function lineFor(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("The Orbis DSH recording value is not JSON-serializable");
  }
  return `${serialized}\n`;
}

function completedFooterLine(
  footer: Omit<RecordingFooter, "bytes">,
  contentBytes: number,
): { readonly bytes: number; readonly line: string } {
  let bytes = contentBytes;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const line = lineFor({ ...footer, bytes });
    const nextBytes = contentBytes + Buffer.byteLength(line, "utf8");
    if (nextBytes === bytes) return { bytes, line };
    bytes = nextBytes;
  }
  throw new Error("The Orbis DSH recorder could not finalize its byte count");
}

async function writeAll(file: FileHandle, value: string): Promise<void> {
  const bytes = Buffer.from(value, "utf8");
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await file.write(bytes, offset, bytes.byteLength - offset, null);
    if (result.bytesWritten <= 0) {
      throw new Error("The Orbis DSH recorder could not make progress writing its file");
    }
    offset += result.bytesWritten;
  }
}

/**
 * Development-only owner-readable JSONL capture for the DSH native event
 * stream. This class deliberately has no projection or redaction boundary:
 * the `event` member is serialized synchronously at capture time so later
 * mutation of a DSH event cannot alter the recording.
 */
export class OrbisDshRawEventRecorder {
  readonly directory: string;

  private readonly createId: () => string;
  private readonly now: () => Date;
  private acceptingCaptures = false;
  private bytes = 0;
  private error?: string;
  private eventCount = 0;
  private exportAvailable = false;
  private file?: FileHandle;
  private activePath?: string;
  private latestExportPath?: string;
  private recordingId?: string;
  private startedAt?: string;
  private state: OrbisDshRawEventRecordingState = "idle";
  private stoppedAt?: string;
  private stopOperation?: Promise<OrbisDshRawEventRecordingStatus>;
  private pendingLines: string[] = [];
  private drainScheduled = false;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(directory: string, options: OrbisDshRawEventRecorderOptions = {}) {
    const normalized = directory.trim();
    if (normalized.length === 0) throw new Error("The Orbis DSH recording directory is invalid");
    this.directory = resolve(normalized);
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<OrbisDshRawEventRecordingStatus> {
    if (this.state === "recording") {
      throw new Error("The Orbis DSH recorder already has an active recording");
    }
    if (this.stopOperation !== undefined) await this.stopOperation;
    if (this.file !== undefined) await this.stop();

    let recordingId: string | undefined;
    let startedAt: string | undefined;
    let path: string | undefined;
    let file: FileHandle | undefined;
    try {
      recordingId = assertRecordingId(this.createId());
      startedAt = this.timestamp();
      path = resolve(this.directory, `${recordingId}.jsonl`);
      await mkdir(this.directory, { mode: OWNER_ONLY_DIRECTORY_MODE, recursive: true });
      await chmod(this.directory, OWNER_ONLY_DIRECTORY_MODE);
      file = await open(path, "wx", OWNER_ONLY_FILE_MODE);
      await chmod(path, OWNER_ONLY_FILE_MODE);
      const header: RecordingHeader = {
        format: "orbis-dsh-raw-events",
        kind: "header",
        recordingId,
        startedAt,
        version: 1,
      };
      const headerLine = lineFor(header);
      await writeAll(file, headerLine);
      await file.sync();
      this.file = file;
      this.recordingId = recordingId;
      this.activePath = path;
      this.startedAt = startedAt;
      this.stoppedAt = undefined;
      this.error = undefined;
      this.eventCount = 0;
      this.bytes = Buffer.byteLength(headerLine, "utf8");
      this.exportAvailable = false;
      this.state = "recording";
      this.acceptingCaptures = true;
      this.pendingLines = [];
      this.drainScheduled = false;
      this.writeTail = Promise.resolve();
      return this.status();
    } catch (error) {
      await file?.close().catch(() => undefined);
      this.file = undefined;
      this.recordingId = recordingId;
      this.activePath = path;
      this.startedAt = startedAt;
      this.eventCount = 0;
      this.bytes = 0;
      this.exportAvailable = false;
      this.acceptingCaptures = false;
      this.fail(error);
      return this.status();
    }
  }

  /** Capture a native event without projecting, cloning, or redacting it. */
  capture(nativeSessionId: string, event: unknown): void {
    if (!this.acceptingCaptures || this.state !== "recording") return;
    const recordingId = this.recordingId;
    if (recordingId === undefined || this.file === undefined) {
      this.fail(new Error("The Orbis DSH recorder is missing its active file"));
      return;
    }

    let line: string;
    try {
      // Serialize before queueing. The caller may mutate `event` immediately
      // after this synchronous method returns.
      const eventPayload = lineFor(event).trimEnd();
      const capturedAt = this.timestamp();
      const wrapperPrefix = lineFor({
        kind: "event",
        recordingId,
        nativeSessionId,
        sequence: this.eventCount + 1,
        capturedAt,
      }).trimEnd();
      line = `${wrapperPrefix.slice(0, -1)},"event":${eventPayload}}\n`;
      // Validate the assembled line as JSON while still in the capture call.
      JSON.parse(line);
    } catch (error) {
      this.fail(error);
      return;
    }

    this.eventCount += 1;
    this.bytes += Buffer.byteLength(line, "utf8");
    this.enqueue(line);
  }

  async stop(): Promise<OrbisDshRawEventRecordingStatus> {
    if (this.stopOperation !== undefined) return this.stopOperation;
    if (this.state !== "recording" && this.file === undefined) return this.status();

    this.acceptingCaptures = false;
    const operation = this.finish();
    this.stopOperation = operation;
    try {
      return await operation;
    } finally {
      this.stopOperation = undefined;
    }
  }

  async dispose(): Promise<void> {
    await this.stop();
    await this.flushPendingWrites();
    const file = this.file;
    this.file = undefined;
    if (file === undefined) return;
    try {
      await file.close();
    } catch (error) {
      this.fail(error);
    }
  }

  status(): OrbisDshRawEventRecordingStatus {
    return {
      bytes: this.bytes,
      ...(this.error === undefined ? {} : { error: this.error }),
      eventCount: this.eventCount,
      exportAvailable: this.exportAvailable,
      ...(this.recordingId === undefined ? {} : { recordingId: this.recordingId }),
      ...(this.startedAt === undefined ? {} : { startedAt: this.startedAt }),
      state: this.state,
      ...(this.stoppedAt === undefined ? {} : { stoppedAt: this.stoppedAt }),
    };
  }

  async latestExport(): Promise<OrbisDshRawEventExportMetadata | undefined> {
    if (!this.exportAvailable || this.latestExportPath === undefined) return undefined;
    try {
      const metadata = await stat(this.latestExportPath);
      await chmod(this.latestExportPath, OWNER_ONLY_FILE_MODE);
      return {
        bytes: metadata.size,
        filename: basename(this.latestExportPath),
        path: this.latestExportPath,
      };
    } catch (error) {
      this.fail(error);
      return undefined;
    }
  }

  private async finish(): Promise<OrbisDshRawEventRecordingStatus> {
    const file = this.file;
    const recordingId = this.recordingId;
    if (file === undefined || recordingId === undefined) return this.status();

    await this.flushPendingWrites();
    const stoppedAt = this.stoppedAt ?? this.safeTimestamp();
    this.stoppedAt = stoppedAt;
    const footer: Omit<RecordingFooter, "bytes"> = {
      ...(this.error === undefined ? {} : { error: this.error }),
      eventCount: this.eventCount,
      kind: "footer",
      recordingId,
      status: this.state === "failed" ? "failed" : "stopped",
      stoppedAt,
    };
    try {
      const completedFooter = completedFooterLine(footer, this.bytes);
      await writeAll(file, completedFooter.line);
      this.bytes = completedFooter.bytes;
      await file.sync();
      if (this.activePath === undefined) {
        throw new Error("The Orbis DSH recorder is missing its active path");
      }
      await chmod(this.activePath, OWNER_ONLY_FILE_MODE);
      if (this.state !== "failed") {
        this.state = "stopped";
        this.exportAvailable = true;
        this.latestExportPath = this.activePath;
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.file = undefined;
      try {
        await file.close();
      } catch (error) {
        this.fail(error);
      }
    }
    return this.status();
  }

  private enqueue(line: string): void {
    this.pendingLines.push(line);
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => this.schedulePendingWrite());
  }

  private schedulePendingWrite(): void {
    this.drainScheduled = false;
    if (this.pendingLines.length === 0) return;
    const batch = this.pendingLines.join("");
    this.pendingLines = [];
    const operation = this.writeTail.then(async () => {
      if (this.state === "failed") return;
      const file = this.file;
      if (file === undefined) throw new Error("The Orbis DSH recorder file is closed");
      await writeAll(file, batch);
    });
    this.writeTail = operation.catch((error) => {
      this.fail(error);
    });
  }

  private async flushPendingWrites(): Promise<void> {
    this.schedulePendingWrite();
    await this.writeTail;
  }

  private fail(error: unknown): void {
    this.state = "failed";
    this.acceptingCaptures = false;
    this.exportAvailable = false;
    this.error ??= errorText(error);
    this.stoppedAt ??= this.safeTimestamp();
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error("The Orbis DSH recorder clock returned an invalid date");
    }
    return value.toISOString();
  }

  private safeTimestamp(): string {
    try {
      return this.timestamp();
    } catch {
      return new Date().toISOString();
    }
  }
}
