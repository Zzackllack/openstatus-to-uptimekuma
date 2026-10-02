/**
 * Uptime Kuma protocol constants, verified against tag 2.5.5.
 *
 * Source of truth: `src/util.ts:32-35` in louislam/uptime-kuma@2.5.5.
 * Do not "improve" these names — clients compare against the raw numbers.
 */

export const KUMA_COMPATIBILITY_VERSION = "2.5.5";

/** The Kuma release whose behaviour this bridge was written against. */
export const KUMA_TARGET_RELEASE = "2.5.5";

export const KUMA_STATUS_DOWN = 0;
export const KUMA_STATUS_UP = 1;
export const KUMA_STATUS_PENDING = 2;
export const KUMA_STATUS_MAINTENANCE = 3;

export type KumaStatus =
  | typeof KUMA_STATUS_DOWN
  | typeof KUMA_STATUS_UP
  | typeof KUMA_STATUS_PENDING
  | typeof KUMA_STATUS_MAINTENANCE;

/**
 * `uptime` event period keys. These are *not* "24h"/"30d" — 2.5.5 emits the
 * number 24, the number 720 and the string "1y"
 * (`server/model/monitor.js:1331-1339`, read in `src/components/Uptime.vue:33`).
 */
export const KUMA_UPTIME_PERIOD_24H = 24;
export const KUMA_UPTIME_PERIOD_30D = 720;
export const KUMA_UPTIME_PERIOD_1Y = "1y";

export type KumaUptimePeriod =
  | typeof KUMA_UPTIME_PERIOD_24H
  | typeof KUMA_UPTIME_PERIOD_30D
  | typeof KUMA_UPTIME_PERIOD_1Y;

/** `server/client.js` sends at most 100 recent beats per monitor on login. */
export const KUMA_INITIAL_HEARTBEAT_LIMIT = 100;

/** The frontend caps its in-memory list at this many beats per monitor. */
export const KUMA_CLIENT_HEARTBEAT_CAP = 150;

/** Default socket.io path. Clients hardcode it (`io(url)` with no options). */
export const KUMA_SOCKET_PATH = "/socket.io/";