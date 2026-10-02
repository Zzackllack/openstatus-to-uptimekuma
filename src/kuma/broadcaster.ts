import type { Server, Socket } from "socket.io";

import type { NormalizedCheck, NormalizedMonitor } from "../model/monitor.js";
import type { NormalizedStatus } from "../model/monitor.js";
import type { KumaHeartbeat, KumaInfo, KumaMonitor, KumaMonitorList } from "./protocol/monitor.js";
import {
  KUMA_UPTIME_PERIOD_1Y,
  KUMA_UPTIME_PERIOD_24H,
  KUMA_UPTIME_PERIOD_30D,
  type KumaStatus,
} from "./protocol/version.js";
import { toKumaHeartbeat } from "./mapper/heartbeat.js";
import { buildChartData, computeUptime } from "./mapper/chart.js";
import type { StatusMapper } from "./mapper/status.js";

export interface BroadcastDeps {
  /**
   * Lazy accessor, not the server itself.
   *
   * The Socket.IO server is constructed *with* the handlers that need this
   * broadcaster, so a plain `io` reference would be a construction cycle.
   * Resolving it through a thunk breaks that without a placeholder object that
   * throws if used too early.
   */
  io: () => Server;
  statusMapper: StatusMapper;
}

export interface MonitorStatsInput {
  monitor: NormalizedMonitor;
  checks: readonly NormalizedCheck[];
  /** Kuma ids of the connected socket, so `heartbeat` reaches only live clients. */
  room: string;
}

/**
 * All Kuma-protocol emission lives here.
 *
 * Handlers and the poller both go through this object rather than calling
 * `socket.emit` directly, so the exact wire shapes are defined in one place and
 * covered by the contract tests.
 */
export class Broadcaster {
  constructor(private readonly deps: BroadcastDeps) {}

  info(socket: Socket, info: KumaInfo): void {
    socket.emit("info", info);
  }

  loginRequired(socket: Socket): void {
    socket.emit("loginRequired");
  }

  monitorList(socket: Socket, list: KumaMonitorList): void {
    socket.emit("monitorList", list);
  }

  updateMonitorIntoList(socket: Socket, monitor: KumaMonitor): void {
    // Keyed object with exactly one entry — the same shape as `monitorList`.
    socket.emit("updateMonitorIntoList", { [String(monitor.id)]: monitor });
  }

  deleteMonitorFromList(target: Socket | string, kumaId: number): void {
    // Bare id, not an object.
    const emitter = typeof target === "string" ? this.deps.io().to(target) : target;
    emitter.emit("deleteMonitorFromList", kumaId);
  }

  /**
   * `overwrite=true` on the initial push.
   *
   * This is load-bearing: the official frontend wipes `heartbeatList` on every
   * reconnect (`src/mixins/socket.js:281-283`) and relies on the server
   * re-sending it. Without `overwrite` the client concatenates onto its own
   * (emptied) list, which happens to work, but a client that does *not* wipe
   * would grow duplicates instead.
   */
  heartbeatList(socket: Socket, kumaId: number, beats: KumaHeartbeat[], overwrite = true): void {
    socket.emit("heartbeatList", kumaId, beats, overwrite);
  }

  heartbeat(room: string, beat: KumaHeartbeat): void {
    this.deps.io().to(room).emit("heartbeat", beat);
  }

  avgPing(room: string, kumaId: number, value: number | null): void {
    // Kuma rounds to 2 decimals and sends `null` (not 0) when there is no data;
    // `Details.vue` falls back to "N/A" on null.
    this.deps.io().to(room).emit("avgPing", kumaId, value === null ? null : Number(value.toFixed(2)));
  }

  uptime24h(room: string, kumaId: number, value: number): void {
    this.deps.io().to(room).emit("uptime", kumaId, KUMA_UPTIME_PERIOD_24H, value);
  }

  uptime30d(room: string, kumaId: number, value: number): void {
    this.deps.io().to(room).emit("uptime", kumaId, KUMA_UPTIME_PERIOD_30D, value);
  }

  uptime1y(room: string, kumaId: number, value: number): void {
    this.deps.io().to(room).emit("uptime", kumaId, KUMA_UPTIME_PERIOD_1Y, value);
  }

  notificationList(socket: Socket): void {
    socket.emit("notificationList", []);
  }

  maintenanceList(socket: Socket): void {
    socket.emit("maintenanceList", {});
  }

  proxyList(socket: Socket): void {
    socket.emit("proxyList", []);
  }

  dockerHostList(socket: Socket): void {
    socket.emit("dockerHostList", []);
  }

  apiKeyList(socket: Socket): void {
    socket.emit("apiKeyList", []);
  }

  remoteBrowserList(socket: Socket): void {
    socket.emit("remoteBrowserList", []);
  }

  statusPageList(socket: Socket): void {
    socket.emit("statusPageList", []);
  }

  monitorTypeList(socket: Socket, types: Record<string, unknown>): void {
    socket.emit("monitorTypeList", types);
  }

  /** Emit the full stat trio for one monitor, exactly like `Monitor.sendStats`. */
  stats(input: MonitorStatsInput): void {
    const { monitor, checks, room } = input;
    const options = {
      kumaStatusOf: (check: NormalizedCheck) => this.kumaStatusOf(check),
      flatStatusOf: (status: KumaStatus) => this.flatStatusOf(status),
    };

    const last24h = computeUptime(checks.filter((c) => isWithinHours(c, 24)), options);
    const last30d = computeUptime(checks, options);

    this.avgPing(room, monitor.kumaId, last24h.avgPing);
    this.uptime24h(room, monitor.kumaId, last24h.uptime);
    this.uptime30d(room, monitor.kumaId, last30d.uptime);
    // OpenStatus does not retain a year of per-check history, so this is the
    // truth of what we have. Clients show 1y only on the detail page.
    this.uptime1y(room, monitor.kumaId, last30d.uptime);
  }

    /** Exposed so callers computing `important` agree on the status mapping. */
  kumaStatusOf(check: NormalizedCheck): KumaStatus {
    return this.deps.statusMapper.toKuma(check.status);
  }

  kumaStatusOfNormalized(status: NormalizedStatus): KumaStatus {
    return this.deps.statusMapper.toKuma(status);
  }

  /** Kuma's `flatStatus`, exposed for the chart/uptime helpers. */
  flatStatusOf(status: KumaStatus): "UP" | "DOWN" {
    return this.deps.statusMapper.toKumaFlat(status);
  }

  toHeartbeat(monitor: NormalizedMonitor, check: NormalizedCheck, important: boolean): KumaHeartbeat {
    return toKumaHeartbeat(check, {
      important,
      monitor,
      statusMapper: this.deps.statusMapper,
    });
  }
}

function isWithinHours(check: NormalizedCheck, hours: number): boolean {
  return Date.now() - check.timestamp.getTime() <= hours * 3_600_000;
}

export { buildChartData };