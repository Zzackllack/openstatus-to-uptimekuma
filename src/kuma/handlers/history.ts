import type { Socket } from "socket.io";

import type { NormalizedCheck } from "../../model/monitor.js";
import type { BridgeServices } from "../../service/bridge-services.js";
import type { Broadcaster } from "../broadcaster.js";
import { buildChartData } from "../mapper/chart.js";
import { isImportantBeat } from "../mapper/heartbeat.js";
import { failure, ok, resolveMonitor, type RequireAuth } from "./monitor.js";

type Ack = (response: unknown) => void;

/**
 * Kuma caps chart buckets at 720 hourly points and the history table at whatever
 * the user configured. We cap at 720h regardless, because OpenStatus' response
 * log retention is 14 days and asking for more can only ever return less.
 */
const MAX_PERIOD_HOURS = 720;

export function registerHistoryHandlers(
  socket: Socket,
  services: BridgeServices,
  broadcaster: Broadcaster,
  requireAuth: RequireAuth,
): void {
  socket.on("getMonitorBeats", (rawId: unknown, rawPeriod: unknown, callback?: Ack) => {
    if (!requireAuth(callback)) return;

    const result = resolveMonitor(services, rawId);
    if ("error" in result) {
      callback?.(result.error);
      return;
    }

    const periodHours = parsePeriod(rawPeriod);
    if (periodHours === null) {
      // Kuma throws "Invalid period." for a null period; match that.
      callback?.(failure("Invalid period."));
      return;
    }

    void (async () => {
      try {
        const checks = await services.getHistory(result.monitor, periodHours);
        const chronological = checks.slice().sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        const beats = chronological.map((check, index) => {
          const previous = chronological[index - 1];
          return broadcaster.toHeartbeat(
            result.monitor,
            check,
            isImportantBeat(index === 0, previous ? broadcaster.kumaStatusOf(previous) : undefined, broadcaster.kumaStatusOf(check)),
          );
        });

        // No fabrication: if OpenStatus retains less than the requested period,
        // the client gets the subset that exists.
        callback?.(ok(beats));
      } catch (error) {
        callback?.(failure(describe(error)));
      }
    })();
  });

  socket.on("getMonitorChartData", (rawId: unknown, rawPeriod: unknown, callback?: Ack) => {
    if (!requireAuth(callback)) return;

    const result = resolveMonitor(services, rawId);
    if ("error" in result) {
      callback?.(result.error);
      return;
    }

    const periodHours = parsePeriod(rawPeriod);
    if (periodHours === null) {
      callback?.(failure("Invalid period."));
      return;
    }

    void (async () => {
      try {
        const checks = await services.getHistory(result.monitor, periodHours);
        const data = buildChartData(checks, periodHours, {
          kumaStatusOf: (check: NormalizedCheck) => broadcaster.kumaStatusOf(check),
          flatStatusOf: (status) => broadcaster.flatStatusOf(status),
        });
        callback?.(ok(data));
      } catch (error) {
        callback?.(failure(describe(error)));
      }
    })();
  });
}

function parsePeriod(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const period = typeof raw === "number" ? raw : Number.parseInt(typeof raw === "string" ? raw : "", 10);
  if (!Number.isFinite(period) || period <= 0) return null;
  return Math.min(period, MAX_PERIOD_HOURS);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}