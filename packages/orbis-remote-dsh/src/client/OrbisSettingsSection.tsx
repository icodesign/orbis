import { Button, IconCheckOutline16 } from "@deepseek-ai/dsh-client-ui-primitives";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  cancelPairing,
  cancelRawDshEventReplay,
  connect,
  disconnect,
  getRawDshEventRecordingStatus,
  getRawDshEventReplayStatus,
  getStatus,
  ORBIS_DIAGNOSTICS_EXPORT_URL,
  RAW_DSH_EVENT_RECORDING_EXPORT_URL,
  revokeDevice,
  saveConfiguration,
  startPairing,
  startRawDshEventRecording,
  startRawDshEventReplay,
  stopRawDshEventRecording,
  type OrbisStatus,
  type RawDshEventRecordingStatus,
  type RawDshEventReplayStatus,
} from "./api";
import type { OrbisLocaleKey } from "./locales";
import { ORBIS_PLUGIN_VERSION, ORBIS_PROTOCOL_VERSION } from "./metadata";

type Translate = (key: OrbisLocaleKey, params?: Record<string, unknown>) => string;

export interface OrbisSettingsSectionInjected {
  readonly t: Translate;
}

const sectionStyle = {
  display: "grid",
  gap: 24,
  maxWidth: 680,
  padding: "8px 0 32px",
};

const cardStyle = {
  border: "1px solid var(--dsh-border, rgba(127, 127, 127, .28))",
  borderRadius: 12,
  padding: 16,
  display: "grid",
  gap: 12,
};

const inputStyle = {
  width: "100%",
  boxSizing: "border-box" as const,
  borderRadius: 8,
  border: "1px solid var(--dsh-border, rgba(127, 127, 127, .35))",
  background: "transparent",
  color: "inherit",
  padding: "8px 10px",
};

function hostMachineLabel(status: OrbisStatus, t: Translate): string {
  const host = status.hostEnvironment;
  const machine = t(
    host.hostMachine === "macos"
      ? "hostMacos"
      : host.hostMachine === "windows"
        ? "hostWindows"
        : host.hostMachine === "linux"
          ? "hostLinux"
          : "hostUnknown",
  );
  if (!host.isWsl) return machine;
  const runtime = host.wslDistribution
    ? t("wslDistribution", { distribution: host.wslDistribution })
    : t("wsl");
  return `${machine} · ${runtime}`;
}

function networkModeLabel(status: OrbisStatus, t: Translate): string | undefined {
  if (!status.hostEnvironment.isWsl) return undefined;
  const mode = status.hostEnvironment.networkingMode;
  return t(
    mode === "bridged"
      ? "networkModeBridged"
      : mode === "mirrored"
        ? "networkModeMirrored"
        : mode === "nat"
          ? "networkModeNat"
          : mode === "virtioproxy"
            ? "networkModeVirtioProxy"
            : mode === "wsl1"
              ? "networkModeWsl1"
              : "networkModeUnknown",
  );
}

function stateLabel(status: OrbisStatus | undefined, t: Translate): string {
  if (!status || status.connection.state === "disconnected") return t("accessOff");
  return status.connection.state === "connected" ? t("accessReady") : t("accessStarting");
}

function pairingPhaseLabel(phase: string, t: Translate): string {
  if (phase === "awaiting-device") return t("pairingAwaitingDevice");
  if (phase === "connecting") return t("pairingConnecting");
  return t("pairingFailed");
}

function recordingStateLabel(state: RawDshEventRecordingStatus["state"], t: Translate): string {
  if (state === "recording") return t("recordingActive");
  if (state === "stopped") return t("recordingStopped");
  if (state === "failed") return t("recordingFailed");
  return t("recordingIdle");
}

function replayStateLabel(state: RawDshEventReplayStatus["state"], t: Translate): string {
  if (state === "preparing") return t("replayPreparing");
  if (state === "waiting") return t("replayWaiting");
  if (state === "replaying") return t("replayActive");
  if (state === "completed") return t("replayCompleted");
  if (state === "cancelled") return t("replayCancelled");
  if (state === "failed") return t("replayFailed");
  return t("replayIdle");
}

function replayActive(state: RawDshEventReplayStatus["state"] | undefined): boolean {
  return state === "preparing" || state === "waiting" || state === "replaying";
}

function byteCount(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, notation: "compact" }).format(
    value,
  );
}

export function OrbisSettingsSection({ t }: OrbisSettingsSectionInjected) {
  const [status, setStatus] = useState<OrbisStatus>();
  const [directPort, setDirectPort] = useState("47000");
  const [hostName, setHostName] = useState("");
  const [recording, setRecording] = useState<RawDshEventRecordingStatus>();
  const [replay, setReplay] = useState<RawDshEventReplayStatus>();
  const [replayFile, setReplayFile] = useState<File>();
  const replayFileInput = useRef<HTMLInputElement>(null);
  const copyFeedbackTimer = useRef<number>();
  const [copiedPairingLink, setCopiedPairingLink] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  const adopt = useCallback((next: OrbisStatus, syncConfiguration = true): void => {
    setStatus(next);
    if (!syncConfiguration) return;
    setDirectPort(String(next.configuration.directPort));
    setHostName(next.configuration.hostName ?? next.configuration.suggestedHostName);
  }, []);

  const refresh = useCallback(
    async (syncConfiguration = false): Promise<void> => {
      try {
        setError(undefined);
        const [nextStatus, nextRecording, nextReplay] = await Promise.all([
          getStatus(),
          getRawDshEventRecordingStatus(),
          getRawDshEventReplayStatus(),
        ]);
        adopt(nextStatus, syncConfiguration);
        setRecording(nextRecording);
        setReplay(nextReplay);
      } catch {
        setError(t("loadFailed"));
      }
    },
    [adopt, t],
  );

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(
    () => () => {
      if (copyFeedbackTimer.current !== undefined) {
        window.clearTimeout(copyFeedbackTimer.current);
      }
    },
    [],
  );

  async function run(
    label: string,
    action: () => Promise<OrbisStatus>,
    failureMessage = t("operationFailed"),
  ): Promise<void> {
    try {
      setBusy(label);
      setError(undefined);
      setNotice(undefined);
      adopt(await action());
    } catch {
      setError(failureMessage);
    } finally {
      setBusy(undefined);
    }
  }

  async function copyPairingLink(): Promise<void> {
    const link = status?.pairing?.invitation;
    if (!link) return;
    try {
      setError(undefined);
      await navigator.clipboard.writeText(link);
      setCopiedPairingLink(link);
      if (copyFeedbackTimer.current !== undefined) {
        window.clearTimeout(copyFeedbackTimer.current);
      }
      copyFeedbackTimer.current = window.setTimeout(() => {
        setCopiedPairingLink((current) => (current === link ? undefined : current));
        copyFeedbackTimer.current = undefined;
      }, 2_000);
    } catch {
      setCopiedPairingLink(undefined);
      setError(t("copyFailed"));
    }
  }

  async function runRecording(
    label: string,
    action: () => Promise<RawDshEventRecordingStatus>,
  ): Promise<void> {
    try {
      setBusy(label);
      setError(undefined);
      setNotice(undefined);
      setRecording(await action());
    } catch {
      setError(t("recordingActionFailed"));
    } finally {
      setBusy(undefined);
    }
  }

  async function runReplay(
    label: string,
    action: () => Promise<RawDshEventReplayStatus>,
  ): Promise<void> {
    try {
      setBusy(label);
      setError(undefined);
      setNotice(undefined);
      const next = await action();
      setReplay(next);
      if (next.state === "waiting") setNotice(t("replayWaitingNotice"));
    } catch {
      setError(t("replayActionFailed"));
    } finally {
      setBusy(undefined);
    }
  }

  const disabled = busy !== undefined;
  const configurationDisabled = disabled || status?.pairing !== undefined;
  const configurationDirty =
    status !== undefined &&
    (hostName !== (status.configuration.hostName ?? status.configuration.suggestedHostName) ||
      directPort !== String(status.configuration.directPort));
  const operationDisabled = disabled || configurationDirty;
  const pairingLinkCopied =
    status?.pairing?.invitation !== undefined && copiedPairingLink === status.pairing.invitation;
  const availableNetworks = useMemo(
    () => [
      ...new Set(
        (status?.configuration.autoDirectEndpoints ?? []).map((endpoint) => endpoint.kind),
      ),
    ],
    [status?.configuration.autoDirectEndpoints],
  );
  const networkStatus = useMemo(() => {
    if (status === undefined) return undefined;
    const routes = availableNetworks.map((network) =>
      t(network === "lan" ? "localNetwork" : "tailscale"),
    );
    return [
      networkModeLabel(status, t),
      routes.length > 0 ? routes.join(" + ") : t("noAvailableRoute"),
    ]
      .filter((part): part is string => part !== undefined)
      .join(" · ");
  }, [availableNetworks, status, t]);

  return (
    <div style={sectionStyle}>
      <div>
        <h2 style={{ margin: "0 0 8px" }}>{t("title")}</h2>
        <p style={{ margin: 0, opacity: 0.76 }}>{t("intro")}</p>
      </div>

      {error && (
        <div role="alert" style={{ color: "var(--dsh-danger, #dc2626)" }}>
          {error}
        </div>
      )}
      {notice && <div role="status">{notice}</div>}
      {configurationDirty && <div role="status">{t("saveConfigurationFirst")}</div>}

      <section style={cardStyle}>
        <div>
          <h3 style={{ margin: "0 0 4px" }}>{t("setup")}</h3>
          <div style={{ fontSize: 13, opacity: 0.72 }}>{t("setupHint")}</div>
        </div>

        <label>
          <div style={{ marginBottom: 4 }}>{t("computerName")}</div>
          <input
            style={inputStyle}
            value={hostName}
            onChange={(event) => setHostName(event.target.value)}
            disabled={configurationDisabled}
          />
        </label>

        <div style={{ display: "grid", gap: 8 }}>
          {status === undefined ? (
            <div style={{ fontSize: 13, opacity: 0.72 }}>{t("busy")}</div>
          ) : (
            <dl style={{ display: "grid", gap: 8, margin: 0 }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(112px, 0.4fr) minmax(0, 1fr)",
                  gap: 12,
                }}
              >
                <dt style={{ opacity: 0.72 }}>{t("hostMachine")}</dt>
                <dd style={{ margin: 0 }}>{hostMachineLabel(status, t)}</dd>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(112px, 0.4fr) minmax(0, 1fr)",
                  gap: 12,
                }}
              >
                <dt style={{ opacity: 0.72 }}>{t("networkStatus")}</dt>
                <dd style={{ margin: 0 }}>{networkStatus}</dd>
              </div>
            </dl>
          )}
          {status?.configuration.networkIssue === "wsl-lan-unreachable" && (
            <div role="alert" style={{ fontSize: 13, color: "var(--dsh-danger, #dc2626)" }}>
              {t("wslNetworkHint", { port: status.configuration.directPort })}
            </div>
          )}
          {status?.hostEnvironment.isWsl && (
            <a
              href={t("wslSetupGuideUrl")}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 13 }}
            >
              {t("wslSetupGuide")}
            </a>
          )}
          <div style={{ fontSize: 13, opacity: 0.72, marginTop: 6 }}>{t("networkHint")}</div>
        </div>

        <details>
          <summary style={{ cursor: "pointer" }}>{t("advanced")}</summary>
          <label style={{ display: "grid", gap: 4, marginTop: 12 }}>
            <span>{t("connectionPort")}</span>
            <input
              style={inputStyle}
              inputMode="numeric"
              value={directPort}
              onChange={(event) => setDirectPort(event.target.value)}
              disabled={configurationDisabled}
            />
          </label>
          <div style={{ fontSize: 13, opacity: 0.72, marginTop: 6 }}>{t("portHint")}</div>
        </details>

        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={configurationDisabled}
            onClick={() => {
              const port = Number(directPort);
              if (hostName.trim().length === 0) {
                setError(t("nameRequired"));
                return;
              }
              if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
                setError(t("portInvalid"));
                return;
              }
              void run(
                "save",
                () => saveConfiguration({ directPort: port, hostName }),
                t("saveFailed"),
              );
            }}
          >
            {busy === "save" ? t("busy") : t("save")}
          </Button>
        </div>
      </section>

      <section style={cardStyle}>
        <div>
          <h3 style={{ margin: "0 0 4px" }}>{t("remoteAccess")}</h3>
          <div>{stateLabel(status, t)}</div>
        </div>
        {status?.connection.error && (
          <div style={{ fontSize: 13, color: "var(--dsh-danger, #dc2626)" }}>
            {t("accessProblem")}
          </div>
        )}
        <div style={{ fontSize: 13, opacity: 0.72 }}>{t("remoteAccessHint")}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              operationDisabled ||
              !status?.configuration.ready ||
              status.connection.state === "connected"
            }
            onClick={() => void run("connect", connect, t("accessFailed"))}
          >
            {busy === "connect" ? t("busy") : t("turnOn")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={operationDisabled || status?.connection.state === "disconnected"}
            onClick={() => void run("disconnect", disconnect, t("accessFailed"))}
          >
            {busy === "disconnect" ? t("busy") : t("turnOff")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={operationDisabled}
            onClick={() => void refresh()}
          >
            {t("refresh")}
          </Button>
        </div>
      </section>

      <section style={cardStyle}>
        <div>
          <h3 style={{ margin: "0 0 4px" }}>{t("pairing")}</h3>
          <div style={{ fontSize: 13, opacity: 0.72 }}>{t("pairingIntro")}</div>
        </div>
        {!status?.pairing && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={operationDisabled || !status?.configuration.ready}
            onClick={() => void run("pair", startPairing, t("pairingActionFailed"))}
          >
            {busy === "pair" ? t("busy") : t("beginPairing")}
          </Button>
        )}
        {status?.pairing && (
          <>
            <div style={{ fontSize: 13 }}>
              {t("pairingPhase", { phase: pairingPhaseLabel(status.pairing.phase, t) })}
            </div>
            <div style={{ fontSize: 13 }}>
              {t("expiresAt", { time: new Date(status.pairing.expiresAt).toLocaleString() })}
            </div>
            {status.pairing.error && (
              <div role="alert" style={{ color: "var(--dsh-danger, #dc2626)" }}>
                {status.pairing.error}
              </div>
            )}
            {status.pairing.phase !== "failed" && (
              <div
                style={{ background: "white", borderRadius: 10, padding: 12, width: "fit-content" }}
              >
                <QRCodeSVG value={status.pairing.invitation} size={188} level="M" includeMargin />
              </div>
            )}
            <p style={{ margin: 0, fontSize: 13, opacity: 0.78 }}>{t("pairingHint")}</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={operationDisabled}
                icon={pairingLinkCopied ? <IconCheckOutline16 /> : undefined}
                onClick={() => void copyPairingLink()}
              >
                {t(pairingLinkCopied ? "copied" : "copy")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={operationDisabled}
                onClick={() => void run("cancel-pairing", cancelPairing, t("pairingActionFailed"))}
              >
                {busy === "cancel-pairing" ? t("busy") : t("cancelPairing")}
              </Button>
            </div>
          </>
        )}
      </section>

      <section style={cardStyle}>
        <h3 style={{ margin: 0 }}>{t("devices")}</h3>
        {status?.devices.length === 0 && <div style={{ opacity: 0.72 }}>{t("noDevices")}</div>}
        {status?.devices.map((device) => (
          <div
            key={device.keyId}
            style={{
              display: "flex",
              gap: 12,
              alignItems: "center",
              justifyContent: "space-between",
              borderTop: "1px solid var(--dsh-border, rgba(127, 127, 127, .2))",
              paddingTop: 12,
            }}
          >
            <div style={{ minWidth: 0, display: "grid", gap: 3 }}>
              <div style={{ overflowWrap: "anywhere" }}>
                {device.deviceName ?? t("unknownDevice")}
              </div>
              <div style={{ fontSize: 12, opacity: 0.72 }}>
                <span
                  style={{
                    color: device.connected
                      ? "var(--dsh-success, #16a34a)"
                      : "var(--dsh-muted-foreground, currentColor)",
                  }}
                >
                  ● {device.connected ? t("online") : t("offline")}
                </span>
                {device.lastConnectedAt && (
                  <>
                    {" · "}
                    {t("lastSeen", {
                      time: new Date(device.lastConnectedAt).toLocaleString(),
                    })}
                  </>
                )}
                {device.error && (
                  <div role="alert" style={{ color: "var(--dsh-danger, #dc2626)" }}>
                    {t("deviceConnectionProblem")}
                  </div>
                )}
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={operationDisabled}
              onClick={() => {
                if (window.confirm(t("removeConfirm")))
                  void run(
                    "remove-" + device.keyId,
                    () => revokeDevice(device.keyId),
                    t("removeFailed"),
                  );
              }}
            >
              {busy === "remove-" + device.keyId ? t("busy") : t("remove")}
            </Button>
          </div>
        ))}
      </section>

      <section style={cardStyle}>
        <div>
          <h3 style={{ margin: "0 0 4px" }}>{t("diagnosticsTitle")}</h3>
          <div style={{ fontSize: 13, opacity: 0.72 }}>{t("diagnosticsIntro")}</div>
        </div>
        <div
          role="note"
          style={{
            border: "1px solid var(--dsh-border, rgba(127, 127, 127, .28))",
            borderRadius: 8,
            padding: 10,
            fontSize: 13,
          }}
        >
          {t("diagnosticsWarning")}
        </div>
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => window.location.assign(ORBIS_DIAGNOSTICS_EXPORT_URL)}
          >
            {t("diagnosticsExport")}
          </Button>
        </div>
      </section>

      {recording !== undefined && (
        <section style={cardStyle}>
          <div>
            <h3 style={{ margin: "0 0 4px" }}>{t("recordingTitle")}</h3>
            <div style={{ fontSize: 13, opacity: 0.72 }}>{t("recordingIntro")}</div>
          </div>
          <div
            role="note"
            style={{
              border: "1px solid var(--dsh-warning, #d97706)",
              borderRadius: 8,
              padding: 10,
              fontSize: 13,
            }}
          >
            {t("recordingWarning")}
          </div>
          <dl style={{ display: "grid", gap: 6, margin: 0, fontSize: 13 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
              <dt style={{ opacity: 0.72 }}>{t("recordingState")}</dt>
              <dd style={{ margin: 0 }}>{recordingStateLabel(recording.state, t)}</dd>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
              <dt style={{ opacity: 0.72 }}>{t("recordingEvents")}</dt>
              <dd style={{ margin: 0 }}>{recording.eventCount}</dd>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
              <dt style={{ opacity: 0.72 }}>{t("recordingBytes")}</dt>
              <dd style={{ margin: 0 }}>{byteCount(recording.bytes)}</dd>
            </div>
          </dl>
          {recording.error && (
            <div role="alert" style={{ color: "var(--dsh-danger, #dc2626)", fontSize: 13 }}>
              {recording.error}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || recording.state === "recording" || replayActive(replay?.state)}
              onClick={() => void runRecording("recording-start", startRawDshEventRecording)}
            >
              {busy === "recording-start" ? t("busy") : t("recordingStart")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || recording.state !== "recording"}
              onClick={() => void runRecording("recording-stop", stopRawDshEventRecording)}
            >
              {busy === "recording-stop" ? t("busy") : t("recordingStop")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || !recording.exportAvailable}
              onClick={() => window.location.assign(RAW_DSH_EVENT_RECORDING_EXPORT_URL)}
            >
              {t("recordingExport")}
            </Button>
          </div>

          {replay !== undefined && (
            <div
              style={{
                borderTop: "1px solid var(--dsh-border, rgba(127, 127, 127, .2))",
                display: "grid",
                gap: 10,
                paddingTop: 12,
              }}
            >
              <div>
                <h4 style={{ margin: "0 0 4px" }}>{t("replayTitle")}</h4>
                <div style={{ fontSize: 13, opacity: 0.72 }}>{t("replayIntro")}</div>
              </div>
              <input
                ref={replayFileInput}
                type="file"
                accept=".jsonl,application/x-ndjson"
                style={{ display: "none" }}
                onChange={(event) => setReplayFile(event.target.files?.[0])}
              />
              {replayFile && (
                <div style={{ fontSize: 13 }}>
                  {t("replaySelected", { filename: replayFile.name })}
                </div>
              )}
              <dl style={{ display: "grid", gap: 6, margin: 0, fontSize: 13 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
                  <dt style={{ opacity: 0.72 }}>{t("replayState")}</dt>
                  <dd style={{ margin: 0 }}>{replayStateLabel(replay.state, t)}</dd>
                </div>
                {replay.eventCount > 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
                    <dt style={{ opacity: 0.72 }}>{t("replayProgress")}</dt>
                    <dd style={{ margin: 0 }}>
                      {replay.replayedEventCount} / {replay.eventCount}
                    </dd>
                  </div>
                )}
                {replay.sessionId && (
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
                    <dt style={{ opacity: 0.72 }}>{t("replaySession")}</dt>
                    <dd style={{ margin: 0, overflowWrap: "anywhere", textAlign: "right" }}>
                      {replay.sessionId}
                    </dd>
                  </div>
                )}
              </dl>
              {replay.error && (
                <div role="alert" style={{ color: "var(--dsh-danger, #dc2626)", fontSize: 13 }}>
                  {replay.error}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled || replayActive(replay.state)}
                  onClick={() => replayFileInput.current?.click()}
                >
                  {t("replayChoose")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={
                    disabled ||
                    replayFile === undefined ||
                    recording.state === "recording" ||
                    replayActive(replay.state)
                  }
                  onClick={() => {
                    if (replayFile !== undefined) {
                      void runReplay("replay-start", () => startRawDshEventReplay(replayFile));
                    }
                  }}
                >
                  {busy === "replay-start" ? t("busy") : t("replayStart")}
                </Button>
                {replayActive(replay.state) && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() => void runReplay("replay-cancel", cancelRawDshEventReplay)}
                  >
                    {busy === "replay-cancel" ? t("busy") : t("replayCancel")}
                  </Button>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      <section style={cardStyle}>
        <h3 style={{ margin: 0 }}>{t("about")}</h3>
        <dl style={{ display: "grid", gap: 8, margin: 0, fontSize: 13 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
            <dt style={{ opacity: 0.72 }}>{t("pluginVersion")}</dt>
            <dd style={{ margin: 0 }}>{ORBIS_PLUGIN_VERSION}</dd>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
            <dt style={{ opacity: 0.72 }}>{t("protocolVersion")}</dt>
            <dd style={{ margin: 0 }}>{ORBIS_PROTOCOL_VERSION}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
