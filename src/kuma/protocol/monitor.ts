/**
 * Kuma wire types.
 *
 * Every field here was read out of Uptime Kuma 2.5.5 source. Where a field is
 * marked "extra" it is one the bridge adds defensively; the reasoning is in
 * docs/protocol-research.md §4.
 */
import type { KumaStatus, KumaUptimePeriod } from "./version.js";

/** Exactly the three monitor types the bridge can honestly produce. */
export type KumaMonitorType = "http" | "port" | "dns";

export interface KumaMonitor {
  id: number;
  name: string;
  type: KumaMonitorType;

  /** HTTP only. */
  url: string;
  method: string;
  /** TCP + DNS only. */
  hostname: string;
  port: string;
  /** DNS only. */
  dns_resolve_type: string;
  dns_resolve_server: string;
  dns_last_result: string;

  description: string;

  /** Seconds. */
  interval: number;
  maxretries: number;
  retryInterval: number;
  resendInterval: number;
  timeout: number;

  active: boolean;

  /**
   * Always an array. `MonitorListItem.vue` calls `.length` and `.find()` on it
   * without a guard; a missing `tags` crashes the dashboard.
   */
  tags: unknown[];
  /** Always an object. `EditMonitor.vue` iterates it. */
  notificationIDList: Record<string, boolean>;
  /** Always an array. Dereferenced unguarded in `MonitorListItem.beforeMount`. */
  childrenIDs: number[];
  /** Must be null or the monitor vanishes from the root list. */
  parent: null;

  path: string[];
  pathName: string;
  weight: number;

  keyword: string;
  invertKeyword: boolean;
  accepted_statuscodes: string[];
  maxredirects: number;
  ignoreTls: boolean;
  packetSize: number;
  location: string;
  proxyId: null;
  maintenance: null;
  timeoutDown: number | null;

  // Extra (bridge-only, ignored by the official frontend). Carries provenance so
  // a human debugging the bridge can tell an OpenStatus-derived monitor apart.
  /** Number of OpenStatus probe locations backing this monitor. */
  openstatusRegions?: string[];
  openstatusPrivateLocations?: string[];
  /** "http" | "tcp" | "dns" — Kuma's own `type` already encodes this. */
  openstatusMonitorId?: string;
}

export type KumaMonitorList = Record<string, KumaMonitor>;

/**
 * One heartbeat.
 *
 * 2.5.5 is inconsistent about casing and we are not going to guess: the pushed
 * `heartbeat` event is `bean.toJSON()` (camelCase `monitorID`), while the
 * `getMonitorBeats` ack returns raw rows (snake_case `monitor_id`). We emit both
 * spellings everywhere. Extra keys are ignored by both consumers; guessing one
 * shape would break whichever client we guessed wrong about.
 */
export interface KumaHeartbeat {
  /** camelCase — used by the `heartbeat` push consumer. */
  monitorID: number;
  /** snake_case — used by the `getMonitorBeats` ack consumer. */
  monitor_id: number;

  status: KumaStatus;

  /** ISO-8601 UTC with milliseconds, e.g. "2026-10-01T21:30:00.000Z". */
  time: string;
  msg: string;

  /** ms. null when no region reported a successful latency. */
  ping: number | null;

  important: boolean;
  retries: number;
  down_count: number;

  /** Seconds the check was scheduled for. */
  duration: number;

  end_time: string | null;
  local_date_time: string | null;
  timezone: string | null;
}

/**
 * `UptimeCalculator.getDataArray()` output. Note the field names are
 * `avgPing`/`minPing`/`maxPing`, *not* the `ping`/`pingMin`/`pingMax` that older
 * write-ups claim — `src/components/PingChart.vue:295-348` reads these.
 */
export interface KumaChartPoint {
  /** Unix *seconds* of the bucket start. */
  timestamp: number;
  up: number;
  down: number;
  avgPing: number;
  minPing: number;
  maxPing: number;
  maintenance: number;
}

export interface KumaInfo {
  primaryBaseURL: string;
  serverTimezone: string;
  serverTimezoneOffset: number;
  version: string;
  latestVersion: string;
  isContainer: boolean;
  dbType: string;
  runtime: { platform: string; arch: string };
}

export interface KumaOkResponse<T = undefined> {
  ok: true;
  data?: T;
  monitor?: KumaMonitor;
  monitorList?: KumaMonitorList;
  token?: string;
}

export interface KumaErrorResponse {
  ok: false;
  msg: string;
  /** Kuma sets this when `msg` is an i18n key; `Login.vue` calls `$t(res.msg)`. */
  msgi18n?: boolean;
  tokenRequired?: boolean;
}

export type KumaResponse<T = undefined> = KumaOkResponse<T> | KumaErrorResponse;

export interface KumaLoginRequest {
  username?: string;
  password?: string;
  /** 2FA OTP in Kuma. The bridge has no 2FA; accepted and ignored. */
  token?: string;
}

export type KumaUptimePeriodKey = KumaUptimePeriod;