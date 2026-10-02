import type {
  NormalizedCheck,
  NormalizedMonitor,
  NormalizedRegionalResult,
  NormalizedStatus,
} from "../model/monitor.js";
import type { RawResponseLog } from "../openstatus/types.js";
import type { LatencyStrategy } from "../kuma/aggregate/regional.js";
import { aggregateLatency, createStatusAggregator } from "../kuma/aggregate/regional.js";
import { buildStatusMessage } from "../kuma/mapper/heartbeat.js";

/**
 * Collapse per-region response-log rows into one check per logical scheduled run.
 *
 * OpenStatus records one log row *per region per check*. A naive pass-through
 * would make a 4-region monitor's heartbeat bar four times denser than the
 * monitor actually checks — visually wrong, and it would silently quadruple
 * every uptime denominator.
 *
 * Grouping strategy, in order of preference:
 *  1. `cronTimestamp` — OpenStatus documents it as the scheduled bucket, so it is
 *     an exact logical-run key when present.
 *  2. Periodicity bucketing with a ±10 % tolerance for clock drift.
 */
export interface GroupOptions {
  latencyStrategy: LatencyStrategy;
  intervalSeconds: number;
  /**
   * How to collapse the regions of one historical run.
   *
   * Deliberately NOT the live `openstatus` strategy: `monitor.status` describes
   * *now*, so using it to judge a check from three hours ago would rewrite
   * history to match the present — an outage would disappear the moment the
   * monitor recovered. The default reproduces OpenStatus' own 50 % quorum over
   * the regions of that specific run, which is the same rule OpenStatus applied
   * when it wrote those rows.
   */
  historyStrategy?: "majority" | "worst" | "all" | "any";
}

export function groupResponseLogs(
  monitor: NormalizedMonitor,
  logs: readonly RawResponseLog[],
  options: GroupOptions,
): NormalizedCheck[] {
  if (logs.length === 0) return [];

  const aggregator = createStatusAggregator(options.historyStrategy ?? "majority");

  const runs = clusterIntoRuns(logs, toleranceMsFor(monitor));
  const checks: NormalizedCheck[] = [];

  for (const run of runs) {
    const regions: NormalizedRegionalResult[] = run.logs.map((log) => ({
      region: log.region,
      status: logStatusToNormalized(log.requestStatus),
    }));

    // Only successful regions contribute latency; averaging a timeout in would
    // report a huge "fast" response.
    const latencies = run.logs
      .filter((log) => logStatusToNormalized(log.requestStatus) === "up")
      .map((log) => log.latencyMs);

    const status = aggregator.aggregate(monitor, regions);
    checks.push({
      monitorId: monitor.openStatusId,
      timestamp: new Date(run.cronTimestamp),
      status,
      latencyMs: aggregateLatency(latencies, options.latencyStrategy),
      message: buildStatusMessage(status, regions, { degradedThresholdMs: monitor.degradedThresholdMs }),
      regions,
      source: "openstatus-log",
    });
  }

  return checks.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

function toleranceMsFor(monitor: NormalizedMonitor): number {
  return Math.max(5000, (monitor.intervalSeconds * 1000) / 10);
}

interface Run {
  cronTimestamp: number;
  logs: RawResponseLog[];
}

/**
 * Collapse per-region rows into one run per logical scheduled check.
 *
 * OpenStatus stamps every row of a run with the same `cronTimestamp` (the
 * scheduled slot), so grouping by that exact value is the correct primary key —
 * no bucketing heuristics involved. The clustering pass then merges runs whose
 * stamps differ by less than a tenth of the monitor's period, which covers the
 * case where a region's row was stamped a few hundred milliseconds off.
 *
 * The previous implementation bucketed on the period boundary and probed
 * neighbouring buckets; that silently merged a run into the *previous* one when
 * the stamp landed near a boundary, halving the apparent check count.
 */
function clusterIntoRuns(logs: readonly RawResponseLog[], toleranceMs: number): Run[] {
  const byStamp = new Map<number, RawResponseLog[]>();
  for (const log of logs) {
    const bucket = byStamp.get(log.cronTimestamp);
    if (bucket) bucket.push(log);
    else byStamp.set(log.cronTimestamp, [log]);
  }

  const stamps = [...byStamp.keys()].sort((a, b) => a - b);
  const runs: Run[] = [];

  for (const stamp of stamps) {
    const current = runs[runs.length - 1];
    if (current && stamp - current.cronTimestamp <= toleranceMs) {
      current.logs.push(...(byStamp.get(stamp) ?? []));
      continue;
    }
    runs.push({ cronTimestamp: stamp, logs: [...(byStamp.get(stamp) ?? [])] });
  }

  return runs;
}

export function logStatusToNormalized(status: string): NormalizedStatus {
  switch (status) {
    case "up":
      return "up";
    case "degraded":
      return "degraded";
    case "down":
      return "down";
    default:
      return "unknown";
  }
}

/**
 * Mark transitions so the client can distinguish a real state change from noise.
 * Runs over an already time-ordered list.
 */
export function markImportantChecks(
  checks: readonly NormalizedCheck[],
  isImportant: (isFirst: boolean, previous: NormalizedCheck | undefined, current: NormalizedCheck) => boolean,
): boolean[] {
  return checks.map((check, index) => isImportant(index === 0, checks[index - 1], check));
}