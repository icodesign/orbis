import { execFileSync } from "node:child_process";
import { networkInterfaces, release, type NetworkInterfaceInfo } from "node:os";

export interface OrbisDshDiscoveredAddress {
  readonly kind: "lan" | "tailnet";
  readonly address: string;
}

export interface OrbisDshNetworkEnvironment {
  readonly hostMachine: "linux" | "macos" | "windows" | "unknown";
  readonly isWsl: boolean;
  readonly networkingMode:
    | "bridged"
    | "mirrored"
    | "nat"
    | "native"
    | "unknown"
    | "virtioproxy"
    | "wsl1";
  readonly wslDistribution?: string;
}

export type OrbisDshDirectNetworkIssue = "wsl-lan-unreachable";

function ipv4Parts(address: string): readonly [number, number, number, number] | undefined {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return undefined;
  }
  return parts as [number, number, number, number];
}

function isLanAddress(address: string): boolean {
  const parts = ipv4Parts(address);
  if (parts === undefined) return false;
  const [first, second] = parts;
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isTailnetAddress(address: string): boolean {
  const parts = ipv4Parts(address);
  return parts !== undefined && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function detectWslNetworkingMode(): OrbisDshNetworkEnvironment["networkingMode"] {
  try {
    const output = execFileSync("wslinfo", ["--networking-mode", "-n"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    });
    const mode = output.trim().toLowerCase();
    return ["bridged", "mirrored", "nat", "virtioproxy", "wsl1"].includes(mode)
      ? (mode as OrbisDshNetworkEnvironment["networkingMode"])
      : "unknown";
  } catch {
    return "unknown";
  }
}

export function detectOrbisDshNetworkEnvironment(): OrbisDshNetworkEnvironment {
  const isWsl =
    process.platform === "linux" &&
    (process.env.WSL_DISTRO_NAME !== undefined ||
      process.env.WSL_INTEROP !== undefined ||
      release().toLowerCase().includes("microsoft"));
  const hostMachine = isWsl
    ? "windows"
    : process.platform === "darwin"
      ? "macos"
      : process.platform === "win32"
        ? "windows"
        : process.platform === "linux"
          ? "linux"
          : "unknown";
  return {
    hostMachine,
    isWsl,
    networkingMode: isWsl ? detectWslNetworkingMode() : "native",
    ...(isWsl && process.env.WSL_DISTRO_NAME !== undefined
      ? { wslDistribution: process.env.WSL_DISTRO_NAME }
      : {}),
  };
}

const currentNetworkEnvironment = detectOrbisDshNetworkEnvironment();

function canAdvertiseWslLanAddress(environment: OrbisDshNetworkEnvironment): boolean {
  if (!environment.isWsl) return true;
  return ["bridged", "mirrored", "wsl1"].includes(environment.networkingMode);
}

export function orbisDshDirectNetworkIssue(
  environment: OrbisDshNetworkEnvironment = currentNetworkEnvironment,
): OrbisDshDirectNetworkIssue | undefined {
  return environment.isWsl && !canAdvertiseWslLanAddress(environment)
    ? "wsl-lan-unreachable"
    : undefined;
}

/**
 * Discovers only private IPv4 routes that are both safe to advertise over
 * plain WebSockets and reachable from another device. WSL 2 NAT/unknown LAN
 * addresses belong to its private VM switch, so only Tailnet routes survive
 * there. Mirrored, bridged, and WSL 1 networking expose their LAN addresses.
 */
export function discoverOrbisDirectAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[] | undefined> = networkInterfaces(),
  environment: OrbisDshNetworkEnvironment = currentNetworkEnvironment,
): readonly OrbisDshDiscoveredAddress[] {
  const discovered = new Map<string, OrbisDshDiscoveredAddress>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (String(entry.family) !== "IPv4" || entry.internal) continue;
      const kind = isTailnetAddress(entry.address)
        ? "tailnet"
        : isLanAddress(entry.address) && canAdvertiseWslLanAddress(environment)
          ? "lan"
          : undefined;
      if (kind === undefined) continue;
      discovered.set(`${kind}:${entry.address}`, { kind, address: entry.address });
    }
  }
  return [...discovered.values()].sort((left, right) => {
    const kindOrder = left.kind === right.kind ? 0 : left.kind === "lan" ? -1 : 1;
    return kindOrder || left.address.localeCompare(right.address);
  });
}
