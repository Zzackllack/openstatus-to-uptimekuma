import type { NormalizedMonitor, NormalizedTarget } from "../../model/monitor.js";
import type { KumaMonitor, KumaMonitorType } from "../protocol/monitor.js";

/** OpenStatus periodicity strings → seconds. */
const PERIODICITY_SECONDS: Record<string, number> = {
  "30s": 30,
  "1m": 60,
  "5m": 300,
  "10m": 600,
  "30m": 1800,
  "1h": 3600,
};

export function periodicityToSeconds(periodicity: string | undefined): number {
  if (!periodicity) return 600;
  return PERIODICITY_SECONDS[periodicity] ?? 600;
}

const KIND_TO_KUMA_TYPE: Record<NormalizedMonitor["kind"], KumaMonitorType> = {
  http: "http",
  tcp: "port",
  dns: "dns",
};

/**
 * Parse OpenStatus' TCP/DNS `uri` (`tcp://host:5432`, sometimes bare `host:port`).
 * Returns null rather than guessing when it cannot make sense of the input — a
 * monitor with an unparseable target should show as target-less, not as a wrong
 * port.
 */
export function parseHostPort(uri: string | undefined): { hostname: string; port: number } | null {
  if (!uri) return null;

  const trimmed = uri.trim();
  if (trimmed.length === 0) return null;

  let rest = trimmed;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (schemeMatch) {
    rest = trimmed.slice(schemeMatch[0].length);
  }

  // Strip any path/query — Kuma's hostname/port pair never carries one.
  const withoutPath = rest.split(/[/?#]/, 1)[0] ?? "";
  const portSplit = withoutPath.lastIndexOf(":");
  if (portSplit <= 0) return null;

  const hostname = withoutPath.slice(0, portSplit);
  const port = Number.parseInt(withoutPath.slice(portSplit + 1), 10);
  if (hostname.length === 0 || !Number.isFinite(port) || port <= 0 || port > 65535) return null;

  return { hostname, port };
}

function emptyTargetFields(): Pick<KumaMonitor, "url" | "hostname" | "port" | "dns_resolve_type" | "dns_resolve_server" | "dns_last_result"> {
  return {
    url: "",
    hostname: "",
    port: "",
    dns_resolve_type: "",
    dns_resolve_server: "",
    dns_last_result: "",
  };
}

function targetFields(kind: NormalizedMonitor["kind"], target: NormalizedTarget) {
  const base = emptyTargetFields();

  if (kind === "http") {
    return { ...base, url: target.url ?? "" };
  }

  if (kind === "tcp") {
    const parsed = target.hostname && target.port
      ? { hostname: target.hostname, port: target.port }
      : parseHostPort(target.hostname);
    return { ...base, hostname: parsed?.hostname ?? target.hostname ?? "", port: parsed ? String(parsed.port) : "" };
  }

  // DNS. OpenStatus has no record type in the monitor config we can read, so we
  // emit the Kuma default rather than inventing one.
  return {
    ...base,
    hostname: target.dnsName ?? target.hostname ?? "",
    dns_resolve_type: "A",
    dns_resolve_server: "default",
  };
}

export function toKumaMonitor(monitor: NormalizedMonitor): KumaMonitor {
  return {
    id: monitor.kumaId,
    name: monitor.name,
    type: KIND_TO_KUMA_TYPE[monitor.kind],

    ...targetFields(monitor.kind, monitor.target),

    description: monitor.description ?? "",

    // Kuma's HTTP method. Only meaningful for HTTP monitors; GET is the correct
    // neutral value for the others because OpenStatus has no method concept there.
    method: monitor.method ?? "GET",

    interval: monitor.intervalSeconds,
    maxretries: 0,
    retryInterval: 0,
    resendInterval: 0,
    timeout: Math.ceil((monitor.timeoutMs ?? 45000) / 1000),

    active: monitor.active,

    tags: [],
    notificationIDList: {},
    childrenIDs: [],
    parent: null,

    path: [],
    pathName: "",
    weight: 1,

    keyword: "",
    invertKeyword: false,
    accepted_statuscodes: [],
    maxredirects: 10,
    ignoreTls: false,
    packetSize: 56,
    location: "",
    proxyId: null,
    maintenance: null,
    timeoutDown: null,

    openstatusRegions: monitor.regions,
    openstatusPrivateLocations: monitor.privateLocationIds,
    openstatusMonitorId: monitor.openStatusId,
  };
}

export function toKumaMonitorList(monitors: readonly NormalizedMonitor[]): Record<string, KumaMonitor> {
  const result: Record<string, KumaMonitor> = {};
  for (const monitor of monitors) {
    result[String(monitor.kumaId)] = toKumaMonitor(monitor);
  }
  return result;
}