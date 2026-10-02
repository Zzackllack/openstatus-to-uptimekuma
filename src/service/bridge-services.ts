import type { NormalizedCheck, NormalizedMonitor, NormalizedStatus } from "../model/monitor.js";
import type { OpenStatusBackend } from "../openstatus/types.js";
import type { LatencyStrategy, StatusAggregator } from "../kuma/aggregate/regional.js";
import { aggregateLatency } from "../kuma/aggregate/regional.js";
import { buildStatusMessage } from "../kuma/mapper/heartbeat.js";
import type { Env } from "../config/env.js";
import type { Logger } from "../observability/logger.js";
import type { ObservedCheckStore } from "../state/observed-checks.js";
import type { MonitorIdMap } from "../state/monitor-id-map.js";
import { assignKumaIds } from "../state/monitor-id-map.js";
import { TtlCache, mapWithConcurrency } from "../state/cache.js";
import type { StatusStore } from "../state/status-store.js";
import type { StatusMapper } from "../kuma/mapper/status.js";
import { groupResponseLogs } from "../openstatus/history.js";

export interface BridgeServicesDeps {
  backend: OpenStatusBackend;
  idMap: MonitorIdMap;
  observed: ObservedCheckStore;
  statusStore: StatusStore;
  aggregator: StatusAggregator;
  statusMapper: StatusMapper;
  latencyStrategy: LatencyStrategy;
  historySource: "auto" | "openstatus" | "local";
  env: Pick<Env, "MAX_HISTORY_HOURS" | "HEARTBEAT_CACHE_TTL_SECONDS" | "MAX_OPENSTATUS_CONCURRENCY" | "STALE_AFTER_SECONDS">;
  logger: Logger;
  /** Injected so tests can drive time. */
  now?: () => Date;
}

/**
 * Read-side orchestration: everything a Socket.IO handler needs to answer a
 * client question, and nothing about Socket.IO itself.
 *
 * Keeping this separate from the handler layer is what makes the handlers thin
 * and the whole protocol surface testable without a socket.
 */
export class BridgeServices {
  /** Exposed so mutation handlers can route writes through the same adapter. */
  readonly backend: OpenStatusBackend;

  private monitors: NormalizedMonitor[] = [];
  private lastSyncAt: Date | null = null;
  private readonly historyCache: TtlCache<NormalizedCheck[]>;

  constructor(private readonly deps: BridgeServicesDeps) {
    this.backend = deps.backend;
    this.historyCache = new TtlCache(deps.env.HEARTBEAT_CACHE_TTL_SECONDS * 1000);
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  listMonitors(): readonly NormalizedMonitor[] {
    return this.monitors;
  }

  getMonitorByKumaId(kumaId: number): NormalizedMonitor | null {
    return this.monitors.find((m) => m.kumaId === kumaId) ?? null;
  }

  getMonitorByOpenStatusId(openStatusId: string): NormalizedMonitor | null {
    return this.monitors.find((m) => m.openStatusId === openStatusId) ?? null;
  }

  getLastSyncAt(): Date | null {
    return this.lastSyncAt;
  }

  isStale(): boolean {
    const last = this.statusStoreFreshest();
    if (!last) return false;
    return this.now().getTime() - last.getTime() > this.deps.env.STALE_AFTER_SECONDS * 1000;
  }

  private statusStoreFreshest(): Date | null {
    const states = this.deps.statusStore.snapshot();
    if (states.length === 0) return this.lastSyncAt;
    let newest: Date | null = null;
    for (const state of states) {
      if (state.lastSuccessfulRefreshAt && (!newest || state.lastSuccessfulRefreshAt > newest)) {
        newest = state.lastSuccessfulRefreshAt;
      }
    }
    return newest ?? this.lastSyncAt;
  }

  /** Replace the monitor set. Called only by the reconciler. */
  setMonitors(monitors: readonly NormalizedMonitor[]): void {
    this.monitors = [...monitors];
    this.historyCache.deletePrefix("");
  }

  markSynced(at: Date): void {
    this.lastSyncAt = at;
  }

  /**
   * Build the current check for a monitor from its per-region rows.
   *
   * Latency: median of the *successful* regions. When OpenStatus gives us no
   * per-region latency (TCP/DNS have no response logs), the caller may fall back
   * to the summary's p50 — but we never label that as a measurement.
   */
  buildCurrentCheck(
    monitor: NormalizedMonitor,
    regions: readonly { region: string; status: NormalizedStatus }[],
    options: { fallbackLatencyMs?: number | null; detail?: string } = {},
  ): NormalizedCheck {
    const status = this.deps.aggregator.aggregate(monitor, regions);
    const successfulLatencies = regions
      .filter((r) => r.status === "up")
      .map((r) => latencyFromRegion(monitor, r.region, regions));

    const measured = successfulLatencies.filter((v): v is number => v !== null);
    const latencyMs =
      measured.length > 0
        ? aggregateLatency(measured, this.deps.latencyStrategy)
        : (options.fallbackLatencyMs ?? null);

    return {
      monitorId: monitor.openStatusId,
      // The bridge observed this just now. Fabricating a "fresh" timestamp for
      // old data is exactly the lie §49/§50 of the spec forbids.
      timestamp: this.now(),
      status,
      latencyMs,
      message: buildStatusMessage(status, regions, {
        detail: options.detail,
        degradedThresholdMs: monitor.degradedThresholdMs,
      }),
      regions: [...regions],
      source: "bridge-poll",
    };
  }

  /**
   * History for a monitor over a period.
   *
   * Two sources, chosen per monitor and per config:
   *  - OpenStatus response logs: real, deep, HTTP only.
   *  - The bridge's observation log: shallower, but covers TCP and DNS.
   *
   * Both are real observations. Neither is extrapolated backwards, and if a
   * client asks for more than OpenStatus retains, it gets the subset that exists.
   */
  async getHistory(monitor: NormalizedMonitor, periodHours: number): Promise<NormalizedCheck[]> {
    const hours = Math.min(Math.max(periodHours, 1), this.deps.env.MAX_HISTORY_HOURS);
    const to = this.now();
    const from = new Date(to.getTime() - hours * 3_600_000);
    const cacheKey = `${monitor.openStatusId}:${hours}`;

    return this.historyCache.resolve(cacheKey, async () => {
      const options = {
        latencyStrategy: this.deps.latencyStrategy,
        intervalSeconds: monitor.intervalSeconds,
      };

      if (this.useOpenStatusHistory(monitor)) {
        const limit = Math.min(Math.max(hours * 12, 100), 100);
        const logs = await this.deps.backend.getMonitorHistory(monitor.openStatusId, from, to, limit);
        if (logs.length > 0) {
          return groupResponseLogs(monitor, logs, options);
        }
        if (this.deps.historySource === "openstatus") return [];
      }

      return this.deps.observed.list(monitor.openStatusId, from, to, hours * 12);
    });
  }

  private useOpenStatusHistory(monitor: NormalizedMonitor): boolean {
    if (this.deps.historySource === "local") return false;
    // Only HTTP monitors have response logs; asking for others would just burn
    // an upstream call to receive a validation error.
    return monitor.kind === "http";
  }

  /** Most recent observed checks, newest first, for the initial heartbeatList. */
  recentChecks(monitor: NormalizedMonitor, count: number): NormalizedCheck[] {
    const checks = this.deps.observed.latest(monitor.openStatusId, count);
    if (checks.length > 0) return checks;
    const state = this.deps.statusStore.get(monitor.openStatusId);
    if (!state || !state.lastCheckAt) return [];
    return [
      {
        monitorId: monitor.openStatusId,
        timestamp: state.lastCheckAt,
        status: state.status,
        latencyMs: state.representativeLatencyMs,
        message: buildStatusMessage(state.status, []),
        regions: [],
        source: "bridge-poll",
      },
    ];
  }

  /** Refresh all monitors from OpenStatus and return the new state. */
  async refreshMonitors(): Promise<NormalizedMonitor[]> {
    const fetched = await this.deps.backend.listMonitors();
    const { ids } = this.deps.idMap.sync(fetched);
    return assignKumaIds(fetched, ids);
  }

  async refreshRegions(monitors: readonly NormalizedMonitor[]): Promise<Map<string, { region: string; status: NormalizedStatus }[]>> {
    const results = await mapWithConcurrency(
      monitors,
      this.deps.env.MAX_OPENSTATUS_CONCURRENCY,
      async (monitor) => {
        try {
          return [monitor.openStatusId, await this.deps.backend.getMonitorStatus(monitor.openStatusId)] as const;
        } catch (error) {
          // One bad monitor must not abort the whole cycle. The caller keeps the
          // previous state for it, which is the documented behaviour for
          // "backend could not tell us".
          this.deps.logger.warn(
            { openstatusMonitorId: monitor.openStatusId, err: describe(error) },
            "openstatus.status.failed",
          );
          return [monitor.openStatusId, null] as const;
        }
      },
    );

    const map = new Map<string, { region: string; status: NormalizedStatus }[]>();
    for (const [id, regions] of results) {
      if (regions !== null) map.set(id, regions);
    }
    return map;
  }
}

/**
 * Per-region latency lives in the response log, not in `getMonitorStatus`. The
 * reconciler stashes the newest measured value per region so `buildCurrentCheck`
 * can aggregate without re-querying history.
 */
const regionLatency = new WeakMap<NormalizedMonitor, Map<string, number>>();

export function rememberRegionLatencies(monitor: NormalizedMonitor, latencies: Map<string, number>): void {
  regionLatency.set(monitor, latencies);
}

function latencyFromRegion(
  monitor: NormalizedMonitor,
  region: string,
  regions: readonly { region: string; status: NormalizedStatus }[],
): number | null {
  void regions;
  const stored = regionLatency.get(monitor);
  const value = stored?.get(region);
  return value === undefined ? null : value;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}