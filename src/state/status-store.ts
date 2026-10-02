import type {
  NormalizedCheck,
  NormalizedMonitor,
  NormalizedStatus,
} from "../model/monitor.js";

export interface MonitorRuntimeState {
  openStatusId: string;
  kumaId: number;

  status: NormalizedStatus;
  representativeLatencyMs: number | null;
  lastCheckAt: Date | null;
  lastChangedAt: Date | null;
  lastSuccessfulRefreshAt: Date | null;
  /** Unix ms of the newest OpenStatus event folded in. Guards against stale writes. */
  lastEventAtMs: number;
}

export interface Transition {
  monitor: NormalizedMonitor;
  check: NormalizedCheck;
  previous: NormalizedStatus;
  changed: boolean;
}

/**
 * Authoritative runtime state for the bridge.
 *
 * Two invariants this type exists to enforce:
 *  1. A transition is only a transition if the *status* changed. Latency noise
 *     must never raise a notification.
 *  2. Stale inputs cannot overwrite fresh state — webhooks and polls race, and
 *     the loser must be dropped rather than rewinding a monitor to a state the
 *     user already saw recover.
 */
export class StatusStore {
  private readonly states = new Map<string, MonitorRuntimeState>();

  apply(monitor: NormalizedMonitor, check: NormalizedCheck): Transition {
    const key = monitor.openStatusId;
    const eventMs = check.timestamp.getTime();
    const existing = this.states.get(key);

    if (existing && eventMs < existing.lastEventAtMs) {
      // Out-of-order delivery (webhook retry, slow poll). Idempotent by
      // construction: the newer state wins and nothing is emitted.
      return {
        monitor,
        check: { ...check, timestamp: new Date(existing.lastEventAtMs) },
        previous: existing.status,
        changed: false,
      };
    }

    const previous = existing?.status;
    const changed = previous !== undefined && previous !== check.status;

    const next: MonitorRuntimeState = {
      openStatusId: monitor.openStatusId,
      kumaId: monitor.kumaId,
      status: check.status,
      representativeLatencyMs: check.latencyMs,
      lastCheckAt: check.timestamp,
      lastChangedAt: changed ? check.timestamp : (existing?.lastChangedAt ?? null),
      lastSuccessfulRefreshAt: new Date(),
      lastEventAtMs: eventMs,
    };
    this.states.set(key, next);

    return { monitor, check, previous: previous ?? check.status, changed };
  }

  get(openStatusId: string): MonitorRuntimeState | undefined {
    return this.states.get(openStatusId);
  }

  snapshot(): MonitorRuntimeState[] {
    return [...this.states.values()];
  }

  /** Ids that were live at the last sync but are no longer present. */
  forgetMissing(liveIds: ReadonlySet<string>): MonitorRuntimeState[] {
    const forgotten: MonitorRuntimeState[] = [];
    for (const [key, state] of this.states) {
      if (!liveIds.has(key)) {
        forgotten.push(state);
        this.states.delete(key);
      }
    }
    return forgotten;
  }

  /**
   * Seed from persisted history so a restart does not make every monitor look
   * like it just recovered (which would fire a burst of false notifications).
   */
  seed(openStatusId: string, kumaId: number, check: NormalizedCheck): void {
    if (this.states.has(openStatusId)) return;
    this.states.set(openStatusId, {
      openStatusId,
      kumaId,
      status: check.status,
      representativeLatencyMs: check.latencyMs,
      lastCheckAt: check.timestamp,
      lastChangedAt: check.timestamp,
      lastSuccessfulRefreshAt: null,
      lastEventAtMs: check.timestamp.getTime(),
    });
  }
}