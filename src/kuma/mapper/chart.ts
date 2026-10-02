import type { NormalizedCheck } from "../../model/monitor.js";
import type { KumaChartPoint } from "../protocol/monitor.js";
import type { KumaStatus } from "../protocol/version.js";

export interface BucketSpec {
  /** Bucket width in milliseconds. */
  sizeMs: number;
  /** Bucket alignment: "minute" | "hour" | "day", as in Kuma. */
  kind: "minute" | "hour" | "day";
}

/**
 * Reproduces `chart-socket-handler.js`'s bucket choice exactly. The client
 * (`PingChart.vue`) assumes dense data for short periods and sparse for long
 * ones, and drawing 5000 points on a phone is a bad idea anyway.
 */
export function bucketSpecForPeriod(periodHours: number): BucketSpec {
  if (periodHours <= 24) return { sizeMs: 60_000, kind: "minute" };
  if (periodHours <= 720) return { sizeMs: 3_600_000, kind: "hour" };
  return { sizeMs: 86_400_000, kind: "day" };
}

function floorTo(date: Date, spec: BucketSpec): number {
  const ms = date.getTime();
  if (spec.kind === "minute") return Math.floor(ms / 60_000) * 60_000;
  if (spec.kind === "hour") return Math.floor(ms / 3_600_000) * 3_600_000;
  // Kuma uses UTC days for daily buckets (`getDailyKey` → `date.utc().startOf("day")`)
  // precisely so a user changing timezone does not shift the statistics.
  return Math.floor(ms / 86_400_000) * 86_400_000;
}

interface Accumulator {
  timestamp: number;
  up: number;
  down: number;
  maintenance: number;
  pingSum: number;
  pingCount: number;
  minPing: number;
  maxPing: number;
}

/**
 * Bucket normalized checks into Kuma chart points.
 *
 * `countAs` decides the UP/DOWN split and must use Kuma's `flatStatus` rules
 * (MAINTENANCE counts as up, PENDING counts as down) — supplied by the caller
 * so this function stays a pure data-shape transformation.
 */
export function buildChartData(
  checks: readonly NormalizedCheck[],
  periodHours: number,
  options: {
    kumaStatusOf: (check: NormalizedCheck) => KumaStatus;
    flatStatusOf: (kumaStatus: KumaStatus) => "UP" | "DOWN";
  },
): KumaChartPoint[] {
  const spec = bucketSpecForPeriod(periodHours);
  const buckets = new Map<number, Accumulator>();

  for (const check of checks) {
    const key = floorTo(check.timestamp, spec);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        timestamp: key,
        up: 0,
        down: 0,
        maintenance: 0,
        pingSum: 0,
        pingCount: 0,
        minPing: Number.POSITIVE_INFINITY,
        maxPing: 0,
      };
      buckets.set(key, bucket);
    }

    const kumaStatus = options.kumaStatusOf(check);
    const flat = options.flatStatusOf(kumaStatus);

    if (flat === "UP") {
      bucket.up += 1;
      if (kumaStatus === 3) bucket.maintenance += 1;
      // Kuma only records ping for UP beats (`uptime-calculator.js` update()).
      if (check.latencyMs !== null) {
        bucket.pingSum += check.latencyMs;
        bucket.pingCount += 1;
        bucket.minPing = Math.min(bucket.minPing, check.latencyMs);
        bucket.maxPing = Math.max(bucket.maxPing, check.latencyMs);
      }
    } else {
      bucket.down += 1;
    }
  }

  return [...buckets.values()]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((bucket) => ({
      // Kuma's `timestamp` is unix *seconds*, not millis.
      timestamp: Math.floor(bucket.timestamp / 1000),
      up: bucket.up,
      down: bucket.down,
      maintenance: bucket.maintenance,
      avgPing: bucket.pingCount > 0 ? Math.round((bucket.pingSum / bucket.pingCount) * 100) / 100 : 0,
      minPing: bucket.pingCount > 0 ? bucket.minPing : 0,
      maxPing: bucket.pingCount > 0 ? bucket.maxPing : 0,
    }));
}

export interface UptimeStats {
  /** Fraction 0..1, exactly what `uptime` carries. */
  uptime: number;
  /** Mean over UP beats, or null when there were none. */
  avgPing: number | null;
}

/**
 * Reproduces `UptimeCalculator.getData()`:
 *   uptime  = up / (up + down)
 *   avgPing = Σ(bucket.avgPing * bucket.up) / totalUp
 *
 * The subtlety is that MAINTENANCE counts as UP and PENDING counts as DOWN —
 * see `StatusMapper.toKumaFlat`. With our default degraded→pending mapping that
 * means degraded time is charged as downtime, which is a real divergence from
 * OpenStatus and is documented rather than hidden.
 */
export function computeUptime(
  checks: readonly NormalizedCheck[],
  options: {
    kumaStatusOf: (check: NormalizedCheck) => KumaStatus;
    flatStatusOf: (kumaStatus: KumaStatus) => "UP" | "DOWN";
  },
): UptimeStats {
  let up = 0;
  let down = 0;
  let pingSum = 0;
  let pingCount = 0;

  for (const check of checks) {
    const flat = options.flatStatusOf(options.kumaStatusOf(check));
    if (flat === "UP") {
      up += 1;
      if (check.latencyMs !== null) {
        pingSum += check.latencyMs;
        pingCount += 1;
      }
    } else {
      down += 1;
    }
  }

  return {
    uptime: up + down === 0 ? 0 : up / (up + down),
    avgPing: pingCount === 0 ? null : pingSum / pingCount,
  };
}