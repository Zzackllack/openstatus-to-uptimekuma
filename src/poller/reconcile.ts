import type {
  NormalizedCheck,
  NormalizedMonitor,
  NormalizedRegionalResult,
  NormalizedStatus,
  NormalizedSummary,
} from "../model/monitor.js";
import type { OpenStatusBackend } from "../openstatus/types.js";
import type { BridgeServices } from "../service/bridge-services.js";
import type { Broadcaster } from "../kuma/broadcaster.js";
import type { ObservedCheckStore } from "../state/observed-checks.js";
import type { StatusStore } from "../state/status-store.js";
import type { MonitorIdMap } from "../state/monitor-id-map.js";
import type { Logger } from "../observability/logger.js";
import { isImportantBeat } from "../kuma/mapper/heartbeat.js";

export interface ReconcilerDeps {
  backend: OpenStatusBackend;
  services: BridgeServices;
  statusStore: StatusStore;
  observed: ObservedCheckStore;
  idMap: MonitorIdMap;
  broadcaster: Broadcaster;
  logger: Logger;
  statusPollIntervalSeconds: number;
  monitorListRefreshSeconds: number;
  summaryRefreshSeconds: number;
  observedRetentionDays: number;
  roomName: string;
  now?: () => Date;
}

/**
 * One central reconciliation loop.
 *
 * Why polling rather than per-socket fetching: five phones must not mean five
 * times the upstream traffic, and a monitor going down should reach every
 * connected client from a single pass. Every downstream consumer reads the same
 * derived state.
 */
export class Reconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  private lastMonitorSyncMs = 0;
  private lastSummaryMs = 0;
  private readonly summaries = new Map<string, NormalizedSummary>();

  constructor(private readonly deps: ReconcilerDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  async start(): Promise<void> {
    this.stopped = false;
    // Prime before accepting clients, so the first login has data instead of a
    // full poll interval of blankness.
    await this.tick();
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    // Jitter keeps a fleet of bridges from synchronising their API calls.
    const jitter = Math.floor(Math.random() * 1000);
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule());
    }, this.deps.statusPollIntervalSeconds * 1000 + jitter);
    this.timer.unref?.();
  }

  /** One cycle. Concurrent calls are coalesced instead of stacking up. */
  async tick(): Promise<void> {
    if (this.running) return this.inFlight ?? Promise.resolve();
    this.running = true;
    this.inFlight = this.run().finally(() => {
      this.running = false;
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<void> {
    const started = Date.now();
    try {
      await this.reconcileMonitors();
      await this.reconcileStatuses();
    } catch (error) {
      // Critically: a backend outage is NEVER translated into "every monitor is
      // down". Last-known state is kept and the failure surfaces on /healthz.
      this.deps.logger.error(
        { err: describe(error), durationMs: Date.now() - started },
        "reconcile.failed",
      );
    }
  }

  private async reconcileMonitors(): Promise<void> {
    const nowMs = this.now().getTime();
    if (this.lastMonitorSyncMs !== 0 && nowMs - this.lastMonitorSyncMs < this.deps.monitorListRefreshSeconds * 1000) {
      return;
    }

    let monitors: NormalizedMonitor[];
    try {
      const fetched = await this.deps.backend.listMonitors();
      const sync = this.deps.idMap.sync(fetched);

      monitors = fetched
        .map((monitor) => ({ ...monitor, kumaId: sync.ids.get(monitor.openStatusId) ?? 0 }))
        .filter((monitor) => monitor.kumaId !== 0);

      if (sync.created.length > 0 || sync.revived.length > 0 || sync.removed.length > 0) {
        this.deps.logger.info(
          { created: sync.created.length, revived: sync.revived.length, tombstoned: sync.removed.length },
          "monitor_id_map.changed",
        );
      }

      this.deps.services.setMonitors(monitors);
      this.deps.services.markSynced(this.now());
      this.lastMonitorSyncMs = nowMs;

      // Forget deleted monitors so their state cannot linger.
      this.deps.statusStore.forgetMissing(new Set(monitors.map((m) => m.openStatusId)));

      for (const removedId of sync.removed) {
        const state = this.deps.statusStore.get(removedId);
        if (state) this.deps.broadcaster.deleteMonitorFromList(this.deps.roomName, state.kumaId);
      }

      this.seedFromHistory(monitors);
    } catch (error) {
      // Keep serving the previous monitor set. A failed listing must not blank
      // the dashboard of every connected phone.
      this.deps.logger.error({ err: describe(error) }, "reconcile.monitors.failed");
      return;
    }

    this.pruneObservations();
  }

  /**
   * Give the status store a starting point per monitor from persisted history.
   *
   * Without this, a bridge restart would see "no previous state" for every
   * monitor and treat each one as a fresh transition — a burst of false
   * recovery notifications on every restart.
   */
  private seedFromHistory(monitors: readonly NormalizedMonitor[]): void {
    for (const monitor of monitors) {
      if (this.deps.statusStore.get(monitor.openStatusId)) continue;
      const [previous] = this.deps.observed.latest(monitor.openStatusId, 2).slice(-1);
      if (previous) this.deps.statusStore.seed(monitor.openStatusId, monitor.kumaId, previous);
    }
  }

  private async reconcileStatuses(): Promise<void> {
    const monitors = this.deps.services.listMonitors();
    if (monitors.length === 0) return;

    const regionsByMonitor = await this.deps.services.refreshRegions(monitors);

    for (const monitor of monitors) {
      const regions = regionsByMonitor.get(monitor.openStatusId);
      // Keep the previous state for a monitor we could not read this cycle.
      if (!regions) continue;

      await this.maybeRefreshSummary(monitor);

      const check = this.deps.services.buildCurrentCheck(monitor, regions, {
        fallbackLatencyMs: this.summaries.get(monitor.openStatusId)?.p50 ?? null,
      });

      if (!this.shouldRecord(monitor, check)) continue;

      const transition = this.deps.statusStore.apply(monitor, check);
      this.deps.observed.insert(check);

      if (!transition.changed) continue;

      await this.emitTransition(monitor, transition.check, transition.previous);
    }
  }

  private async emitTransition(
    monitor: NormalizedMonitor,
    check: NormalizedCheck,
    previous: NormalizedStatus,
  ): Promise<void> {
    const important = isImportantBeat(
      false,
      this.deps.broadcaster.kumaStatusOfNormalized(previous),
      this.deps.broadcaster.kumaStatusOfNormalized(check.status),
    );

    this.deps.broadcaster.heartbeat(
      this.deps.roomName,
      this.deps.broadcaster.toHeartbeat(monitor, check, important),
    );

    this.deps.logger.info(
      {
        monitorKumaId: monitor.kumaId,
        openstatusMonitorId: monitor.openStatusId,
        from: previous,
        to: check.status,
        important,
      },
      "monitor.transition",
    );

    await this.emitStatsFor(monitor);
  }

  private async emitStatsFor(monitor: NormalizedMonitor): Promise<void> {
    try {
      const checks = await this.deps.services.getHistory(monitor, 24);
      this.deps.broadcaster.stats({ monitor, checks, room: this.deps.roomName });
    } catch (error) {
      this.deps.logger.debug({ err: describe(error) }, "reconcile.stats.failed");
    }
  }

  /**
   * One observation per monitor period, not one per poll. Without this a 30 s
   * poll against a 1 h monitor would write 120 identical rows an hour and
   * inflate every uptime denominator.
   *
   * A *status change* bypasses the gate entirely: delaying an outage by up to
   * half an interval to save a database row would be a bad trade, and it is the
   * only moment anybody is actually waiting for.
   */
  private shouldRecord(monitor: NormalizedMonitor, check: NormalizedCheck): boolean {
    const last = this.deps.statusStore.get(monitor.openStatusId);
    if (!last?.lastCheckAt) return true;
    if (last.status !== check.status) return true;

    const minGapMs = Math.max(10_000, (monitor.intervalSeconds * 1000) / 2);
    return check.timestamp.getTime() - last.lastCheckAt.getTime() >= minGapMs;
  }

  private async maybeRefreshSummary(monitor: NormalizedMonitor): Promise<void> {
    const nowMs = this.now().getTime();
    const hasValue = this.summaries.has(monitor.openStatusId);
    if (hasValue && nowMs - this.lastSummaryMs < this.deps.summaryRefreshSeconds * 1000) return;

    try {
      const summary = await this.deps.backend.getMonitorSummary(monitor.openStatusId, 24);
      if (summary) this.summaries.set(monitor.openStatusId, summary);
      this.lastSummaryMs = nowMs;
    } catch (error) {
      this.deps.logger.debug({ err: describe(error) }, "reconcile.summary.failed");
    }
  }

  private pruneObservations(): void {
    const cutoff = new Date(this.now().getTime() - this.deps.observedRetentionDays * 86_400_000);
    const removed = this.deps.observed.pruneOlderThan(cutoff);
    if (removed > 0) this.deps.logger.info({ removed }, "observed_checks.pruned");
  }

  /** Feed an externally-observed transition (webhook) through the same path. */
  async applyExternalTransition(
    monitor: NormalizedMonitor,
    check: NormalizedCheck,
    previous: NormalizedStatus,
    changed: boolean,
  ): Promise<void> {
    if (!changed) return;
    await this.emitTransition(monitor, check, previous);
  }
}

export interface WebhookApplyDeps {
  backend: OpenStatusBackend;
  services: BridgeServices;
  statusStore: StatusStore;
  observed: ObservedCheckStore;
  broadcaster: Broadcaster;
  logger: Logger;
  roomName: string;
}

/**
 * Fold an OpenStatus webhook into local state.
 *
 * The webhook fires only when OpenStatus' own quorum check actually
 * transitioned, so it is the best outage signal available — but its payload is
 * thin: no regions, no status class beyond error/degraded/recovered, and
 * `monitor.id` is a *number* here while the RPC layer uses strings. So the
 * payload only decides *that* something happened and *when*; the state itself is
 * re-read from OpenStatus. Never trust the fields we cannot corroborate.
 */
export type WebhookOutcome =
  | { applied: false; reason: string }
  | { applied: true; monitor: NormalizedMonitor; check: NormalizedCheck; previous: NormalizedStatus };

export async function applyWebhook(
  payload: { monitorId: string; cronTimestamp: number; status: string; latency?: number; errorMessage?: string },
  deps: WebhookApplyDeps,
): Promise<WebhookOutcome> {
  const tracked = deps.services.getMonitorByOpenStatusId(payload.monitorId);
  if (!tracked) {
    // Not yet synced. The poller will pick the state up; nothing is lost.
    deps.logger.debug({ openstatusMonitorId: payload.monitorId }, "webhook.monitor_not_tracked_yet");
    return { applied: false, reason: "monitor not yet synced" };
  }

  let regions: NormalizedRegionalResult[] = [];
  try {
    regions = await deps.backend.getMonitorStatus(payload.monitorId);
  } catch (error) {
    deps.logger.warn({ err: describe(error) }, "webhook.regions_failed");
  }

  // Re-read the monitor itself. `tracked` may be up to MONITOR_LIST_REFRESH_
  // SECONDS stale, and under the default `openstatus` aggregation strategy its
  // `status` is what decides the outcome — using the cached copy here would make
  // the bridge reject exactly the transition the webhook exists to deliver.
  let authoritative: NormalizedMonitor = tracked;
  try {
    const fresh = await deps.backend.getMonitor(payload.monitorId);
    if (fresh) authoritative = { ...fresh, kumaId: tracked.kumaId };
  } catch (error) {
    deps.logger.warn({ err: describe(error) }, "webhook.monitor_refresh_failed");
  }

  const check = deps.services.buildCurrentCheck(authoritative, regions, {
    fallbackLatencyMs: payload.latency ?? null,
    detail: payload.errorMessage,
  });
  // `cronTimestamp` is OpenStatus' own idempotency key; StatusStore drops events
  // older than what we already applied, so retries and reordering are safe.
  const timestamped: NormalizedCheck = { ...check, timestamp: new Date(payload.cronTimestamp) };

  const transition = deps.statusStore.apply(tracked, timestamped);
  deps.observed.insert({ ...timestamped, source: "webhook" });

  if (!transition.changed) {
    deps.logger.debug({ openstatusMonitorId: payload.monitorId }, "webhook.no_state_change");
    return { applied: false, reason: "no state change" };
  }

  deps.logger.info(
    {
      openstatusMonitorId: tracked.openStatusId,
      monitorKumaId: tracked.kumaId,
      webhookStatus: payload.status,
      from: transition.previous,
      to: transition.check.status,
      cronTimestamp: payload.cronTimestamp,
    },
    "webhook.applied",
  );

  return { applied: true, monitor: tracked, check: timestamped, previous: transition.previous };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
