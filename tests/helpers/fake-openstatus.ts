import type {
  NormalizedMonitor,
  NormalizedRegionalResult,
  NormalizedStatus,
  NormalizedSummary,
} from "../../src/model/monitor.js";
import type { OpenStatusBackend, RawResponseLog } from "../../src/openstatus/types.js";

/**
 * Deterministic OpenStatus stand-in.
 *
 * Integration tests drive whole-state transitions through `setMonitor` and assert
 * on the Socket.IO wire output, with no network and no timers.
 */
export class FakeBackend implements OpenStatusBackend {
  readonly monitors = new Map<string, NormalizedMonitor>();
  readonly regions = new Map<string, NormalizedRegionalResult[]>();
  readonly summaries = new Map<string, NormalizedSummary>();
  readonly history = new Map<string, RawResponseLog[]>();

  healthy = true;
  /** Set to make any call throw, simulating an unreachable OpenStatus. */
  failure: Error | null = null;

  callCount = 0;
  historyCalls = 0;
  summaryCalls = 0;

  setMonitor(monitor: NormalizedMonitor): void {
    this.monitors.set(monitor.openStatusId, monitor);
    if (!this.regions.has(monitor.openStatusId)) this.regions.set(monitor.openStatusId, []);
  }

  setRegions(id: string, regions: NormalizedRegionalResult[]): void {
    this.regions.set(id, regions);
  }

  setSummary(id: string, summary: NormalizedSummary): void {
    this.summaries.set(id, summary);
  }

  setHistory(id: string, logs: RawResponseLog[]): void {
    this.history.set(id, logs);
  }

  private guard(): void {
    this.callCount += 1;
    if (this.failure) throw this.failure;
  }

  async listMonitors(): Promise<NormalizedMonitor[]> {
    this.guard();
    return [...this.monitors.values()].map((m) => ({ ...m }));
  }

  async getMonitor(id: string): Promise<NormalizedMonitor | null> {
    this.guard();
    const monitor = this.monitors.get(id);
    return monitor ? { ...monitor } : null;
  }

  async getMonitorStatus(id: string): Promise<NormalizedRegionalResult[]> {
    this.guard();
    return this.regions.get(id) ?? [];
  }

  async getMonitorSummary(id: string, _timeRangeHours: number): Promise<NormalizedSummary | null> {
    this.guard();
    this.summaryCalls += 1;
    return this.summaries.get(id) ?? null;
  }

  async getMonitorHistory(id: string, _from: Date, _to: Date, limit: number): Promise<RawResponseLog[]> {
    this.guard();
    this.historyCalls += 1;
    return (this.history.get(id) ?? []).slice(0, limit);
  }

  async setActive(id: string, active: boolean): Promise<NormalizedMonitor | null> {
    this.guard();
    const monitor = this.monitors.get(id);
    if (!monitor) return null;
    const updated = { ...monitor, active };
    this.monitors.set(id, updated);
    return { ...updated };
  }

  async trigger(): Promise<void> {
    this.guard();
  }

  async checkHealth(): Promise<boolean> {
    this.guard();
    return this.healthy;
  }
}

let sequence = 0;

export function makeMonitor(overrides: Partial<NormalizedMonitor> = {}): NormalizedMonitor {
  sequence += 1;
  return {
    openStatusId: `mon_${overrides.openStatusId ?? sequence}`,
    kumaId: 0,
    name: `Monitor ${sequence}`,
    kind: "http",
    target: { url: "https://example.com/health" },
    active: true,
    intervalSeconds: 60,
    regions: ["fly_ams", "fly_fra"],
    privateLocationIds: [],
    status: "up",
    statusAuthoritative: true,
    lastCheckAt: null,
    updatedAt: null,
    ...overrides,
  };
}

export function region(regionName: string, status: NormalizedStatus): NormalizedRegionalResult {
  return { region: regionName, status };
}