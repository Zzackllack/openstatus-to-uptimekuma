import type { KumaInfo } from "./protocol/monitor.js";
import { KUMA_COMPATIBILITY_VERSION } from "./protocol/version.js";

/**
 * The `info` event.
 *
 * 2.5.5 sends a *reduced* info on connect (`sendInfo(socket, hideVersion=true)`)
 * and the full one after login. We send the full object on both: the frontend
 * merely assigns it, and it explicitly tolerates a missing `version`
 * (`src/mixins/socket.js:850`), so a superset is safe for every client.
 *
 * `version` claims the Kuma release we implement. That is a compatibility
 * statement, not an impersonation of the Uptime Kuma project — see README.
 */
export function buildInfo(options: {
  primaryBaseURL: string;
  serverTimezone: string;
}): KumaInfo {
  return {
    primaryBaseURL: options.primaryBaseURL,
    serverTimezone: options.serverTimezone,
    serverTimezoneOffset: new Date().getTimezoneOffset(),
    version: KUMA_COMPATIBILITY_VERSION,
    latestVersion: KUMA_COMPATIBILITY_VERSION,
    isContainer: false,
    dbType: "sqlite",
    runtime: { platform: process.platform, arch: process.arch },
  };
}

export function isValidTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Only the three types the bridge can honestly produce. `supportsConditions` is
 * per-type metadata the edit form reads; we report `false` because we never
 * expose condition editing.
 */
export function buildMonitorTypeList(): Record<string, unknown> {
  return {
    http: { supportsConditions: false, conditionVariables: [] },
    port: { supportsConditions: false, conditionVariables: [] },
    dns: { supportsConditions: false, conditionVariables: [] },
  };
}