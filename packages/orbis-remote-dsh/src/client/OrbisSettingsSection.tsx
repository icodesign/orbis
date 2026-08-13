import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  cancelPairing,
  connect,
  disconnect,
  getStatus,
  revokeDevice,
  saveConfiguration,
  startPairing,
  type OrbisStatus,
} from "./api";
import type { OrbisLocaleKey } from "./locales";

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

function stateLabel(status: OrbisStatus | undefined, t: Translate): string {
  if (!status || status.connection.state === "disconnected") return t("accessOff");
  return status.connection.state === "connected" ? t("accessReady") : t("accessStarting");
}

function pairingPhaseLabel(phase: string, t: Translate): string {
  if (phase === "awaiting-device") return t("pairingAwaitingDevice");
  if (phase === "connecting") return t("pairingConnecting");
  return t("pairingFailed");
}

export function OrbisSettingsSection({ t }: OrbisSettingsSectionInjected) {
  const [status, setStatus] = useState<OrbisStatus>();
  const [directPort, setDirectPort] = useState("47000");
  const [hostName, setHostName] = useState("");
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
        adopt(await getStatus(), syncConfiguration);
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
      await navigator.clipboard.writeText(link);
      setNotice(t("copied"));
    } catch {
      setError(t("copyFailed"));
    }
  }

  const disabled = busy !== undefined;
  const configurationDisabled = disabled || status?.pairing !== undefined;
  const configurationDirty =
    status !== undefined &&
    (hostName !== (status.configuration.hostName ?? status.configuration.suggestedHostName) ||
      directPort !== String(status.configuration.directPort));
  const operationDisabled = disabled || configurationDirty;
  const availableNetworks = useMemo(
    () => [
      ...new Set(
        (status?.configuration.autoDirectEndpoints ?? []).map((endpoint) => endpoint.kind),
      ),
    ],
    [status?.configuration.autoDirectEndpoints],
  );

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

        <div>
          <div style={{ marginBottom: 4 }}>{t("availableOn")}</div>
          {availableNetworks.length > 0 ? (
            <ul style={{ margin: 0, paddingInlineStart: 20 }}>
              {availableNetworks.map((network) => (
                <li key={network}>{t(network === "lan" ? "localNetwork" : "tailscale")}</li>
              ))}
            </ul>
          ) : (
            <div style={{ fontSize: 13, opacity: 0.72 }}>{t("noNetwork")}</div>
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
                onClick={() => void copyPairingLink()}
              >
                {t("copy")}
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
    </div>
  );
}
