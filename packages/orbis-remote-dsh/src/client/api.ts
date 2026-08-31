export interface OrbisDevice {
  readonly keyId: string;
  readonly publicKey: string;
  readonly deviceId: string;
  readonly deviceName?: string;
  readonly version: string;
  readonly scopeMode: "all" | "custom";
  readonly scopes: readonly string[];
  readonly pairedAt: string;
  readonly lastConnectedAt?: string;
  readonly connected: boolean;
  readonly error?: string;
}

export interface OrbisStatus {
  readonly configuration: {
    readonly hostId: string;
    readonly directPort: number;
    readonly hostName?: string;
    readonly suggestedHostName: string;
    readonly autoDirectEndpoints: readonly {
      readonly kind: "lan" | "tailnet";
      readonly url: string;
      readonly expiresAt?: string;
    }[];
    readonly endpoints: readonly {
      readonly kind: "lan" | "tailnet";
      readonly url: string;
      readonly expiresAt?: string;
    }[];
    readonly endpointRevision: number;
    readonly ready: boolean;
  };
  readonly connection: {
    readonly state: "connected" | "connecting" | "disconnected";
    readonly error?: string;
  };
  readonly pairing?: {
    readonly pairingId: string;
    readonly transport: "lan" | "tailnet";
    readonly expiresAt: string;
    readonly phase: "awaiting-device" | "connecting" | "failed";
    readonly invitation: string;
    readonly error?: string;
  };
  readonly devices: readonly OrbisDevice[];
}

export interface RawDshEventRecordingStatus {
  readonly bytes: number;
  readonly error?: string;
  readonly eventCount: number;
  readonly exportAvailable: boolean;
  readonly recordingId?: string;
  readonly startedAt?: string;
  readonly state: "failed" | "idle" | "recording" | "stopped";
  readonly stoppedAt?: string;
}

export interface RawDshEventReplayStatus {
  readonly completedAt?: string;
  readonly error?: string;
  readonly eventCount: number;
  readonly filename?: string;
  readonly replayedEventCount: number;
  readonly replayId?: string;
  readonly sessionId?: string;
  readonly startedAt?: string;
  readonly state:
    | "cancelled"
    | "completed"
    | "failed"
    | "idle"
    | "preparing"
    | "replaying"
    | "waiting";
}

function requestHeaders(init?: RequestInit): Headers {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return headers;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: requestHeaders(init),
    cache: "no-store",
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Orbis returned an invalid response");
  }
  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : "The Orbis operation failed";
    throw new Error(message);
  }
  return payload as T;
}

async function optionalRequest<T>(path: string): Promise<T | undefined> {
  const response = await fetch(path, { cache: "no-store" });
  if (response.status === 404) return undefined;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Orbis returned an invalid response");
  }
  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : "The Orbis operation failed";
    throw new Error(message);
  }
  return payload as T;
}

export function getStatus(): Promise<OrbisStatus> {
  return request<OrbisStatus>("/orbis/status");
}

export function saveConfiguration(input: {
  readonly directPort: number;
  readonly hostName: string;
}): Promise<OrbisStatus> {
  return request("/orbis/config", { method: "PUT", body: JSON.stringify(input) });
}

export function connect(): Promise<OrbisStatus> {
  return request("/orbis/connect", { method: "POST" });
}

export function disconnect(): Promise<OrbisStatus> {
  return request("/orbis/disconnect", { method: "POST" });
}

export function startPairing(): Promise<OrbisStatus> {
  return request("/orbis/pairings", { method: "POST" });
}

export function cancelPairing(): Promise<OrbisStatus> {
  return request("/orbis/pairings", { method: "DELETE" });
}

export function revokeDevice(keyId: string): Promise<OrbisStatus> {
  return request("/orbis/devices/" + encodeURIComponent(keyId), { method: "DELETE" });
}

export function getRawDshEventRecordingStatus(): Promise<RawDshEventRecordingStatus | undefined> {
  return optionalRequest("/orbis/recording");
}

export function startRawDshEventRecording(): Promise<RawDshEventRecordingStatus> {
  return request("/orbis/recording", { method: "POST" });
}

export function stopRawDshEventRecording(): Promise<RawDshEventRecordingStatus> {
  return request("/orbis/recording", { method: "DELETE" });
}

export const RAW_DSH_EVENT_RECORDING_EXPORT_URL = "/orbis/recording/export";

export function getRawDshEventReplayStatus(): Promise<RawDshEventReplayStatus | undefined> {
  return optionalRequest("/orbis/replay");
}

export function startRawDshEventReplay(file: File): Promise<RawDshEventReplayStatus> {
  return request("/orbis/replay", {
    body: file,
    headers: {
      "content-type": "application/x-ndjson",
      "x-orbis-replay-filename": encodeURIComponent(file.name),
    },
    method: "POST",
  });
}

export function cancelRawDshEventReplay(): Promise<RawDshEventReplayStatus> {
  return request("/orbis/replay", { method: "DELETE" });
}

export const ORBIS_DIAGNOSTICS_EXPORT_URL = "/orbis/diagnostics/export";
