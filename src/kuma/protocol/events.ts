/**
 * Ack payload types for client → server events, plus the server → client event
 * map used to type `ServerToClientEvents`.
 */
import type { KumaInfo } from "./monitor.js";
import type {
  KumaChartPoint,
  KumaHeartbeat,
  KumaLoginRequest,
  KumaMonitor,
  KumaMonitorList,
  KumaResponse,
} from "./monitor.js";
import type { KumaUptimePeriod } from "./version.js";

export type Ack<T = undefined> = (response: KumaResponse<T>) => void;

export interface ServerToClientEvents {
  info: (info: KumaInfo) => void;
  loginRequired: () => void;

  monitorList: (monitors: KumaMonitorList) => void;
  updateMonitorIntoList: (monitors: KumaMonitorList) => void;
  /** Bare id, *not* an object. */
  deleteMonitorFromList: (monitorID: number) => void;

  heartbeatList: (monitorID: number, beats: KumaHeartbeat[], overwrite: boolean) => void;
  heartbeat: (beat: KumaHeartbeat) => void;

  avgPing: (monitorID: number, avgPing: number | null) => void;
  uptime: (monitorID: number, period: KumaUptimePeriod, uptime: number) => void;

  notificationList: (notifications: unknown[]) => void;
  maintenanceList: (maintenances: Record<string, unknown>) => void;
  proxyList: (proxies: unknown[]) => void;
  dockerHostList: (hosts: unknown[]) => void;
  apiKeyList: (keys: unknown[]) => void;
  remoteBrowserList: (browsers: unknown[]) => void;
  statusPageList: (pages: unknown[]) => void;
  monitorTypeList: (types: Record<string, unknown>) => void;
}

/**
 * Only the events the bridge actually handles are typed. Everything else is
 * rejected by the catch-all "unsupported event" handler, which is deliberate:
 * we would rather surface an unknown event in the logs than silently swallow a
 * user's tap.
 */
export interface ClientToServerEvents {
  login: (data: KumaLoginRequest, callback: Ack<undefined> & { (r: { ok: true; token: string }): void }) => void;
  loginByToken: (token: string, callback: Ack) => void;
  logout: (callback: Ack) => void;

  getMonitor: (monitorID: number, callback: Ack<KumaMonitor>) => void;
  getMonitorList: (callback: Ack<KumaMonitorList>) => void;
  getMonitorBeats: (monitorID: number, periodHours: number, callback: Ack<KumaHeartbeat[]>) => void;
  getMonitorChartData: (monitorID: number, periodHours: number, callback: Ack<KumaChartPoint[]>) => void;

  pauseMonitor: (monitorID: number, callback: Ack) => void;
  resumeMonitor: (monitorID: number, callback: Ack) => void;

  getSettings: (callback: Ack<Record<string, unknown>>) => void;
  getTags: (callback: Ack<unknown[]>) => void;
  clearEvents: (monitorID: number, callback: Ack) => void;
}

export type KumaMonitorCallback = (monitor: KumaMonitor | undefined) => void;