import {
  createOpenStatusClient,
  HTTPResponseLogRequestStatus,
  HTTPMethod,
  MonitorStatus,
  Periodicity,
  Region,
  ServingStatus,
  TimeRange,
} from "@openstatus/sdk-node";
import { Code, ConnectError } from "@connectrpc/connect";

import type { Env } from "../config/env.js";
import type {
  MonitorKind,
  NormalizedMonitor,
  NormalizedRegionalResult,
  NormalizedStatus,
  NormalizedSummary,
} from "../model/monitor.js";
import type { Logger } from "../observability/logger.js";
import type { OpenStatusBackend, RawResponseLog } from "./types.js";

/**
 * The one place that knows OpenStatus' wire format.
 *
 * Two conventions worth calling out, both verified against the SDK 0.2.0
 * descriptors:
 *  - `i64` protobuf fields arrive as **bigint**, not number.
 *  - `Region` is a **numeric** enum, so it must be stringified by name; reading
 *    it as a lowercase code would give "1" instead of "fly_ams".
 */

/** `listMonitors` caps `limit` at 100. */
const LIST_PAGE_SIZE = 100;

type MonitorMessage = {
  id: string;
  name: string;
  periodicity: Periodicity;
  active?: boolean;
  status: MonitorStatus;
  description?: string;
  timeout: bigint;
  degradedAt?: bigint;
  regions: Region[];
  privateLocationIds: string[];
  updatedAt?: bigint;
};

type HttpMessage = MonitorMessage & { url: string; method: HTTPMethod };
type TcpMessage = MonitorMessage & { uri: string };
type DnsMessage = MonitorMessage & { uri: string };

const PERIODICITY_SECONDS: Record<number, number> = {
  [Periodicity.PERIODICITY_30S]: 30,
  [Periodicity.PERIODICITY_1M]: 60,
  [Periodicity.PERIODICITY_5M]: 300,
  [Periodicity.PERIODICITY_10M]: 600,
  [Periodicity.PERIODICITY_30M]: 1800,
  [Periodicity.PERIODICITY_1H]: 3600,
};

const HTTP_METHOD_NAMES: Record<number, string> = {
  [HTTPMethod.HTTP_METHOD_GET]: "GET",
  [HTTPMethod.HTTP_METHOD_POST]: "POST",
  [HTTPMethod.HTTP_METHOD_HEAD]: "HEAD",
  [HTTPMethod.HTTP_METHOD_PUT]: "PUT",
  [HTTPMethod.HTTP_METHOD_PATCH]: "PATCH",
  [HTTPMethod.HTTP_METHOD_DELETE]: "DELETE",
  [HTTPMethod.HTTP_METHOD_TRACE]: "TRACE",
  [HTTPMethod.HTTP_METHOD_CONNECT]: "CONNECT",
  [HTTPMethod.HTTP_METHOD_OPTIONS]: "OPTIONS",
};

const MONITOR_STATUS_MAP: Record<number, NormalizedStatus> = {
  [MonitorStatus.ACTIVE]: "up",
  [MonitorStatus.DEGRADED]: "degraded",
  [MonitorStatus.ERROR]: "down",
  [MonitorStatus.UNSPECIFIED]: "unknown",
};

const LOG_STATUS_MAP: Record<number, NormalizedStatus> = {
  [HTTPResponseLogRequestStatus.HTTP_RESPONSE_LOG_REQUEST_STATUS_SUCCESS]: "up",
  [HTTPResponseLogRequestStatus.HTTP_RESPONSE_LOG_REQUEST_STATUS_ERROR]: "down",
  [HTTPResponseLogRequestStatus.HTTP_RESPONSE_LOG_REQUEST_STATUS_DEGRADED]: "degraded",
  [HTTPResponseLogRequestStatus.HTTP_RESPONSE_LOG_REQUEST_STATUS_UNSPECIFIED]: "unknown",
};

const TIME_RANGE_MAX_HOURS: Record<number, number> = {
  [TimeRange.TIME_RANGE_1D]: 24,
  [TimeRange.TIME_RANGE_7D]: 24 * 7,
  [TimeRange.TIME_RANGE_14D]: 24 * 14,
};

function regionName(region: Region): string {
  const name = Region[region];
  return typeof name === "string" && name !== "UNSPECIFIED" ? name.toLowerCase() : `region-${region}`;
}

function bigIntToNumber(value: bigint | number | undefined | null): number | undefined {
  if (value === undefined || value === null) return undefined;
  const asNumber = typeof value === "bigint" ? Number(value) : value;
  return Number.isFinite(asNumber) ? asNumber : undefined;
}

function toIsoDate(bigintOrUndefined: bigint | undefined): Date | null {
  const ms = bigIntToNumber(bigintOrUndefined);
  if (ms === undefined || ms <= 0) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalize(message: MonitorMessage, kind: MonitorKind, extra: Partial<NormalizedMonitor>): NormalizedMonitor {
  return {
    // The id map assigns the real value immediately after; the adapter never
    // invents one. See `MonitorIdMap.assign`.
    kumaId: 0,
    openStatusId: String(message.id),
    name: message.name,
    kind,
    target: {},
    active: message.active === true,
    intervalSeconds: PERIODICITY_SECONDS[message.periodicity] ?? 600,
    regions: (message.regions ?? []).map(regionName),
    privateLocationIds: [...(message.privateLocationIds ?? [])],
    status: MONITOR_STATUS_MAP[message.status] ?? "unknown",
    statusAuthoritative: true,
    lastCheckAt: null,
    updatedAt: toIsoDate(message.updatedAt),
    ...(message.description !== undefined ? { description: message.description } : {}),
    ...(bigIntToNumber(message.degradedAt) !== undefined
      ? { degradedThresholdMs: bigIntToNumber(message.degradedAt) }
      : {}),
    ...(bigIntToNumber(message.timeout) !== undefined ? { timeoutMs: bigIntToNumber(message.timeout) } : {}),
    ...extra,
  };
}

export class OpenStatusSdkBackend implements OpenStatusBackend {
  private readonly client: ReturnType<typeof createOpenStatusClient>;

  constructor(
    env: Pick<Env, "OPENSTATUS_API_URL" | "OPENSTATUS_API_KEY" | "MAX_HISTORY_HOURS">,
    private readonly logger: Logger,
  ) {
    // Explicit baseUrl so a self-hosted OpenStatus always wins over the SDK's
    // env fallback and the managed default.
    this.client = createOpenStatusClient({ baseUrl: env.OPENSTATUS_API_URL, apiKey: env.OPENSTATUS_API_KEY });
  }

  private get monitors() {
    return this.client.monitor.v1.MonitorService;
  }

  async listMonitors(): Promise<NormalizedMonitor[]> {
    const all: NormalizedMonitor[] = [];
    let offset = 0;

    for (;;) {
      const page = await this.monitors.listMonitors({ limit: LIST_PAGE_SIZE, offset });
      const batch = [
        ...page.httpMonitors.map((m) => this.fromHttp(m as HttpMessage)),
        ...page.tcpMonitors.map((m) => this.fromTcp(m as TcpMessage)),
        ...page.dnsMonitors.map((m) => this.fromDns(m as DnsMessage)),
      ];
      all.push(...batch);
      offset += LIST_PAGE_SIZE;

      if (batch.length === 0 || offset >= page.totalSize) break;
    }

    return all;
  }

  private fromHttp(message: HttpMessage): NormalizedMonitor {
    return normalize(message, "http", {
      target: { url: message.url },
      ...(HTTP_METHOD_NAMES[message.method] ? { method: HTTP_METHOD_NAMES[message.method] } : {}),
    });
  }

  private fromTcp(message: TcpMessage): NormalizedMonitor {
    return normalize(message, "tcp", { target: parseUriTarget(message.uri) });
  }

  private fromDns(message: DnsMessage): NormalizedMonitor {
    return normalize(message, "dns", {
      target: { ...parseUriTarget(message.uri), dnsName: hostnameOf(message.uri) },
    });
  }

  async getMonitor(id: string): Promise<NormalizedMonitor | null> {
    try {
      const { monitor } = await this.monitors.getMonitor({ id });
      const config = monitor?.config;
      if (!config) return null;

      switch (config.case) {
        case "http":
          return this.fromHttp(config.value);
        case "tcp":
          return this.fromTcp(config.value);
        case "dns":
          return this.fromDns(config.value);
        default: {
          // ICMP/GRPC exist in newer OpenStatus releases but are out of scope for
          // v1. Returning null makes the monitor disappear rather than lie about it.
          this.logger.warn({ openstatusMonitorId: id }, "openstatus.monitor.type_unsupported");
          return null;
        }
      }
    } catch (error) {
      if (isNotFound(error)) {
        this.logger.debug({ openstatusMonitorId: id }, "openstatus.monitor.not_found");
        return null;
      }
      // Rethrow the original error so ConnectError semantics (code, metadata)
      // survive; callers classify on `error.code`, not on the message.
      throw error;
    }
  }

  async getMonitorStatus(id: string): Promise<NormalizedRegionalResult[]> {
    const { regions } = await this.monitors.getMonitorStatus({ id });
    return regions.map((row) => ({
      region: regionName(row.region),
      status: MONITOR_STATUS_MAP[row.status] ?? "unknown",
    }));
  }

  async getMonitorSummary(id: string, timeRangeHours: number): Promise<NormalizedSummary | null> {
    const timeRange = timeRangeFor(timeRangeHours);
    try {
      const summary = await this.monitors.getMonitorSummary({ id, timeRange });
      return {
        monitorId: id,
        // OpenStatus returns "" rather than omitting lastPingAt when there is no data.
        lastPingAt: summary.lastPingAt ? new Date(summary.lastPingAt) : null,
        totalSuccessful: Number(summary.totalSuccessful),
        totalDegraded: Number(summary.totalDegraded),
        totalFailed: Number(summary.totalFailed),
        p50: nonZero(summary.p50),
        p95: nonZero(summary.p95),
        p99: nonZero(summary.p99),
        timeRangeHours: TIME_RANGE_MAX_HOURS[timeRange] ?? 24,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async getMonitorHistory(id: string, from: Date, to: Date, limit: number): Promise<RawResponseLog[]> {
    try {
      const cappedLimit = Math.min(Math.max(limit, 1), 100);
      const response = await this.monitors.listMonitorHTTPResponseLogs({
        id,
        fromTimestamp: BigInt(from.getTime()),
        toTimestamp: BigInt(to.getTime()),
        limit: cappedLimit,
      });

      return response.logs.map((log) => ({
        id: log.id ?? null,
        cronTimestamp: Number(log.cronTimestamp),
        timestamp: Number(log.timestamp),
        latencyMs: log.latency,
        statusCode: log.statusCode ?? null,
        region: regionName(log.region),
        requestStatus: logStatusName(log.requestStatus),
      }));
    } catch (error) {
      // Response logs are plan-gated and HTTP-only. Both are expected conditions,
      // not backend failures, so they degrade to "no history available" instead of
      // poisoning the poll loop.
      if (isNotFound(error) || isForbidden(error) || isTypeMismatch(error)) {
        this.logger.debug({ openstatusMonitorId: id, reason: describe(error) }, "openstatus.history.unavailable");
        return [];
      }
      throw error;
    }
  }

  async setActive(id: string, active: boolean): Promise<NormalizedMonitor | null> {
    // Partial update: only `active` is sent. Rebuilding a whole monitor payload
    // would race with edits made in the OpenStatus dashboard and could clobber
    // headers/assertions we never even read.
    const current = await this.getMonitor(id);
    if (!current) return null;

    switch (current.kind) {
      case "http":
        await this.monitors.updateHTTPMonitor({ id, monitor: { active } });
        break;
      case "tcp":
        await this.monitors.updateTCPMonitor({ id, monitor: { active } });
        break;
      case "dns":
        await this.monitors.updateDNSMonitor({ id, monitor: { active } });
        break;
    }

    return this.getMonitor(id);
  }

  async trigger(id: string): Promise<void> {
    await this.monitors.triggerMonitor({ id });
  }

  async checkHealth(): Promise<boolean> {
    try {
      const result = await this.client.health.v1.HealthService.check({});
      return result.status !== ServingStatus.NOT_SERVING;
    } catch {
      return false;
    }
  }
}

function nonZero(value: bigint | number): number | null {
  const asNumber = Number(value);
  return Number.isFinite(asNumber) && asNumber > 0 ? asNumber : null;
}

function logStatusName(status: number): string {
  for (const [key, value] of Object.entries(LOG_STATUS_MAP)) {
    if (Number(key) === status) return value;
  }
  return "unknown";
}

function timeRangeFor(hours: number): TimeRange {
  if (hours > 24 * 7) return TimeRange.TIME_RANGE_14D;
  if (hours > 24) return TimeRange.TIME_RANGE_7D;
  return TimeRange.TIME_RANGE_1D;
}

function parseUriTarget(uri: string | undefined): { hostname?: string; port?: number } {
  const hostname = hostnameOf(uri);
  const port = portOf(uri);
  return { ...(hostname !== undefined ? { hostname } : {}), ...(port !== undefined ? { port } : {}) };
}

function stripScheme(uri: string): string {
  return uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/, 1)[0] ?? "";
}

function hostnameOf(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  const host = stripScheme(uri);
  const index = host.lastIndexOf(":");
  const hostname = index > 0 ? host.slice(0, index) : host;
  return hostname.length > 0 ? hostname : undefined;
}

function portOf(uri: string | undefined): number | undefined {
  if (!uri) return undefined;
  const host = stripScheme(uri);
  const index = host.lastIndexOf(":");
  if (index <= 0) return undefined;
  const port = Number.parseInt(host.slice(index + 1), 10);
  return Number.isFinite(port) && port > 0 && port <= 65535 ? port : undefined;
}

function isConnectCode(error: unknown, code: Code): boolean {
  return error instanceof ConnectError && error.code === code;
}

function isNotFound(error: unknown): boolean {
  return isConnectCode(error, Code.NotFound);
}

/** Response logs are a paid-plan feature; without the workspace limit it 403s. */
function isForbidden(error: unknown): boolean {
  return isConnectCode(error, Code.PermissionDenied);
}

/** OpenStatus answers a non-HTTP monitor's log request with `invalid_argument`. */
function isTypeMismatch(error: unknown): boolean {
  return isConnectCode(error, Code.InvalidArgument);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}