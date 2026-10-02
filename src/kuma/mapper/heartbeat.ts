import type { NormalizedCheck, NormalizedMonitor, NormalizedRegionalResult, NormalizedStatus } from "../../model/monitor.js";
import type { KumaHeartbeat } from "../protocol/monitor.js";
import {
  KUMA_STATUS_DOWN,
  KUMA_STATUS_MAINTENANCE,
  KUMA_STATUS_PENDING,
  KUMA_STATUS_UP,
  type KumaStatus,
} from "../protocol/version.js";
import type { StatusMapper } from "./status.js";

const statusCodes = {
  UP: KUMA_STATUS_UP,
  DOWN: KUMA_STATUS_DOWN,
  PENDING: KUMA_STATUS_PENDING,
  MAINTENANCE: KUMA_STATUS_MAINTENANCE,
};

/**
 * Human-readable reason for a synthesized status.
 *
 * Kuma clients show `msg` verbatim in toasts, in the heartbeat bar tooltip and
 * in the monitor detail timeline, so this is the one place a user will actually
 * read. It therefore always names the OpenStatus reason and, where regions are
 * involved, the healthy-count. We deliberately do not try to imitate Kuma's own
 * strings ("OK", "200 - OK") because they would hide the multi-region truth.
 */
export function buildStatusMessage(
  status: NormalizedStatus,
  regions: readonly NormalizedRegionalResult[],
  details?: { detail?: string; degradedThresholdMs?: number },
): string {
  const total = regions.length;
  const healthy = regions.filter((r) => r.status === "up").length;
  const degraded = regions.filter((r) => r.status === "degraded").length;

  const regionSummary =
    total > 0 ? ` · ${healthy}/${total} locations healthy` : "";

  switch (status) {
    case "up":
      return details?.detail ? `OK · ${details.detail}${regionSummary}` : `OK${regionSummary}`;
    case "degraded": {
      const threshold =
        details?.degradedThresholdMs !== undefined
          ? ` (threshold ${details.degradedThresholdMs} ms)`
          : "";
      const degradedPart = degraded > 0 ? `, ${degraded} degraded` : "";
      return `Degraded — latency above configured threshold${threshold}${degradedPart}${regionSummary}`;
    }
    case "down": {
      const detail = details?.detail ? `: ${details.detail}` : "";
      const degradedPart = degraded > 0 ? ` · ${degraded} degraded` : "";
      return `Connection failed${detail}${regionSummary}${degradedPart}`;
    }
    case "maintenance":
      return "Under maintenance";
    case "unknown":
      return total > 0 ? "No data" : "No check data available yet";
  }
}

export interface HeartbeatOptions {
  /**
   * Reproduces `Monitor.isImportantBeat` (server/model/monitor.js:1391). Anything
   * involving PENDING is *not* important except PENDING → DOWN. That is why a
   * degraded monitor (mapped to PENDING by default) does not raise a toast — it
   * is Kuma's own behaviour for pending, and faking importance here would mean
   * `important` no longer means anything.
   */
  important: boolean;
  monitor: NormalizedMonitor;
  statusMapper: StatusMapper;
  retries?: number;
  downCount?: number;
}

export function toKumaHeartbeat(check: NormalizedCheck, options: HeartbeatOptions): KumaHeartbeat {
  const status = options.statusMapper.toKuma(check.status);
  return {
    monitorID: options.monitor.kumaId,
    monitor_id: options.monitor.kumaId,
    status,
    time: check.timestamp.toISOString(),
    msg: check.message,
    ping: check.latencyMs,
    important: options.important,
    retries: options.retries ?? 0,
    down_count: options.downCount ?? 0,
    duration: options.monitor.intervalSeconds,
    end_time: check.timestamp.toISOString(),
    local_date_time: null,
    timezone: null,
  };
}

/**
 * Reproduces `Monitor.isImportantBeat`. Exported (and unit tested) rather than
 * inlined because getting it wrong changes which transitions notify.
 */
export function isImportantBeat(
  isFirstBeat: boolean,
  previousStatus: KumaStatus | undefined,
  currentStatus: KumaStatus,
): boolean {
  if (isFirstBeat) return true;
  if (previousStatus === undefined) return true;

  const { UP, DOWN, PENDING, MAINTENANCE } = statusCodes;

  return (
    (previousStatus === DOWN && currentStatus === MAINTENANCE) ||
    (previousStatus === UP && currentStatus === MAINTENANCE) ||
    (previousStatus === MAINTENANCE && currentStatus === DOWN) ||
    (previousStatus === MAINTENANCE && currentStatus === UP) ||
    (previousStatus === UP && currentStatus === DOWN) ||
    (previousStatus === DOWN && currentStatus === UP) ||
    (previousStatus === PENDING && currentStatus === DOWN)
  );
}
