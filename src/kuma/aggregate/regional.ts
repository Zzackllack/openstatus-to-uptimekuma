import type {
  NormalizedMonitor,
  NormalizedRegionalResult,
  NormalizedStatus,
} from "../../model/monitor.js";

export type AggregationStrategy =
  /** Trust OpenStatus' own quorum-gated `monitor.status`. The default. */
  | "openstatus"
  /** Any region down → down. */
  | "worst"
  /** ≥50 % of regions down → down. Reproduces OpenStatus' quorum locally. */
  | "majority"
  /** Every region must be up. */
  | "all"
  /** At least one region must be up. */
  | "any";

export interface StatusAggregator {
  aggregate(monitor: NormalizedMonitor, regions: readonly NormalizedRegionalResult[]): NormalizedStatus;
}

/**
 * Degraded ranks below up and above down: a degraded region must not drag the
 * monitor down, but it must not hide a real failure either.
 */
function worstOf(statuses: NormalizedStatus[]): NormalizedStatus {
  if (statuses.includes("down")) return "down";
  if (statuses.includes("degraded")) return "degraded";
  if (statuses.includes("up")) return "up";
  if (statuses.includes("maintenance")) return "maintenance";
  return "unknown";
}

/**
 * Mirrors OpenStatus' `quorumMetSql`: `affected * 2 >= total`.
 *
 * The subtle half is what happens when quorum is *not* met: the isolated failing
 * regions are discarded rather than folded into a `worstOf`, because that is the
 * whole point of the quorum. One sick region out of three must not read as an
 * outage.
 */
function quorumOf(statuses: NormalizedStatus[], failing: NormalizedStatus): NormalizedStatus {
  if (statuses.length === 0) return "unknown";

  const affected = statuses.filter((s) => s === failing).length;
  if (affected * 2 >= statuses.length) return failing;

  const remaining = statuses.filter((s) => s !== failing);
  if (remaining.length === 0) return failing;
  if (remaining.includes("degraded")) return "degraded";
  if (remaining.includes("up")) return "up";
  return "unknown";
}

export function createStatusAggregator(strategy: AggregationStrategy): StatusAggregator {
  return {
    aggregate(monitor: NormalizedMonitor, regions: readonly NormalizedRegionalResult[]): NormalizedStatus {
      if (!monitor.active) return "unknown";

      const statuses = regions.map((r) => r.status);

      // Nothing to aggregate from: fall back to whatever OpenStatus said.
      if (statuses.length === 0) {
        return monitor.status === "unknown" ? "unknown" : monitor.status;
      }

      switch (strategy) {
        case "openstatus":
          // OpenStatus already applied its 50 % quorum server-side. Recomputing
          // here would be strictly worse: `getMonitorStatus` omits private
          // locations entirely, so a local quorum would use the wrong denominator.
          return monitor.status !== "unknown" ? monitor.status : quorumOf(statuses, "down");
        case "worst":
          return worstOf(statuses);
        case "majority":
          return quorumOf(statuses, "down");
        case "all":
          return statuses.every((s) => s === "up") ? "up" : worstOf(statuses);
        case "any":
          return statuses.some((s) => s === "up") ? "up" : worstOf(statuses);
      }
    },
  };
}

/**
 * Latency aggregation across regions of a single logical check.
 * Median by default: it is resistant to one geographically distant probe and
 * does not punish globally distributed monitoring the way max or mean would.
 */
export type LatencyStrategy = "median" | "mean" | "min" | "max" | "p50";

export function aggregateLatency(values: readonly number[], strategy: LatencyStrategy): number | null {
  const clean = values.filter((v) => Number.isFinite(v) && v >= 0);
  if (clean.length === 0) return null;

  const sorted = [...clean].sort((a, b) => a - b);

  switch (strategy) {
    case "min":
      return sorted[0] ?? null;
    case "max":
      return sorted[sorted.length - 1] ?? null;
    case "mean":
      return Math.round(clean.reduce((sum, v) => sum + v, 0) / clean.length);
    case "p50":
    case "median": {
      const mid = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 1) return sorted[mid] ?? null;
      const low = sorted[mid - 1];
      const high = sorted[mid];
      if (low === undefined || high === undefined) return null;
      return Math.round((low + high) / 2);
    }
  }
}