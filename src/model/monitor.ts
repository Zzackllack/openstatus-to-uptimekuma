/**
 * Normalized domain model.
 *
 * Nothing in `src/model/` may import from `src/kuma/` or `src/openstatus/`. That
 * separation is the whole point of the bridge: protocol churn stays in the Kuma
 * adapter, API churn stays in the OpenStatus adapter, and the middle stays put.
 */

export type MonitorKind = "http" | "tcp" | "dns";

export const MONITOR_KINDS: readonly MonitorKind[] = ["http", "tcp", "dns"];

/**
 * Deliberately finer-grained than Kuma's four states. `degraded` and `unknown`
 * must survive all the way to the mappers, because collapsing them here would
 * force us to invent a Kuma status far away from the place where we can document
 * why.
 */
export type NormalizedStatus = "up" | "down" | "degraded" | "maintenance" | "unknown";

export interface NormalizedTarget {
  /** HTTP monitors only. */
  url?: string;
  /** TCP + DNS monitors. */
  hostname?: string;
  /** TCP monitors only. */
  port?: number;
  /** DNS monitors: the resolver name, kept separate from `hostname` semantics. */
  dnsName?: string;
}

export interface NormalizedMonitor {
  /** OpenStatus id, as a string even though the API exposes it inconsistently. */
  openStatusId: string;
  /** Stable synthetic numeric id handed to Kuma clients. Assigned by the id map. */
  kumaId: number;

  name: string;
  kind: MonitorKind;

  target: NormalizedTarget;
  active: boolean;

  /** Seconds. Kuma's `interval` field. */
  intervalSeconds: number;

  regions: string[];
  privateLocationIds: string[];

  description?: string;
  /** OpenStatus `degradedAfter`, in ms. */
  degradedThresholdMs?: number;
  /** OpenStatus `timeout`, in ms. */
  timeoutMs?: number;
  method?: string;

  /**
   * OpenStatus' authoritative, quorum-gated monitor-wide status.
   * `null` when OpenStatus has not classified the monitor yet.
   */
  status: NormalizedStatus;
  /** True when `status` came from OpenStatus rather than from local aggregation. */
  statusAuthoritative: boolean;

  /** Unix ms of the newest check we know about, or null. */
  lastCheckAt: Date | null;
  /** Unix ms OpenStatus last touched the monitor record, or null. */
  updatedAt: Date | null;
}

export interface NormalizedRegionalResult {
  region: string;
  status: NormalizedStatus;
}

/**
 * One logical check of one monitor, already collapsed across regions.
 *
 * `source` records where the underlying observation came from, because the
 * bridge genuinely has two history sources and pretending otherwise would make
 * the retention story a lie.
 */
export type CheckSource = "openstatus-log" | "bridge-poll" | "webhook";

export interface NormalizedCheck {
  monitorId: string;
  /** Unix ms. The bucket/scheduled time, not the completion time. */
  timestamp: Date;
  status: NormalizedStatus;
  /** Representative latency in ms, or null when no successful region reported one. */
  latencyMs: number | null;
  message: string;
  regions: NormalizedRegionalResult[];
  source: CheckSource;
}

export interface NormalizedSummary {
  monitorId: string;
  /** Unix ms of the newest check, or null when OpenStatus returned an empty string. */
  lastPingAt: Date | null;
  totalSuccessful: number;
  totalDegraded: number;
  totalFailed: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  timeRangeHours: number;
}

export function isDegradableStatus(status: NormalizedStatus): boolean {
  return status === "up" || status === "down" || status === "degraded";
}