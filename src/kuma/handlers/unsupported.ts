import type { Socket } from "socket.io";
import type { Logger } from "pino";

import type { RequireAuth } from "./monitor.js";

type Ack = (response: unknown) => void;

export const UNSUPPORTED_MESSAGE = "Not supported by OpenStatus compatibility bridge";

/**
 * Events the bridge knowingly does not implement.
 *
 * Listed explicitly rather than handled by a catch-all so that (a) the log line
 * says *which* event a client tried, and (b) a new Kuma release adding events
 * shows up as an explicit unknown rather than a silent no-op.
 */
const UNSUPPORTED_EVENTS = [
  // Monitor authoring
  "add",
  "editMonitor",
  "deleteMonitor",
  "checkDomain",
  "getGameList",
  "getPM2ProcessList",
  // Notifications
  "addNotification",
  "deleteNotification",
  "testNotification",
  "getWebpushVapidPublicKey",
  "checkApprise",
  // Maintenance
  "addMaintenance",
  "editMaintenance",
  "deleteMaintenance",
  "pauseMaintenance",
  "resumeMaintenance",
  "getMaintenanceList",
  "getMaintenance",
  "addMonitorMaintenance",
  "removeMonitorMaintenance",
  "addMaintenanceStatusPage",
  "removeMaintenanceStatusPage",
  "getMonitorMaintenance",
  "getMaintenanceStatusPage",
  // 2FA
  "prepare2FA",
  "save2FA",
  "disable2FA",
  "verifyToken",
  "twoFAStatus",
  // API keys / settings / data
  "getAPIKeyList",
  "addAPIKey",
  "deleteAPIKey",
  "disableAPIKey",
  "enableAPIKey",
  "changePassword",
  "setSettings",
  "getDatabaseSize",
  "shrinkDatabase",
  "clearStatistics",
  "clearHeartbeats",
  "uploadBackup",
  // Infrastructure
  "addDockerHost",
  "testDockerHost",
  "deleteDockerHost",
  "addProxy",
  "deleteProxy",
  "addRemoteBrowser",
  "testRemoteBrowser",
  "deleteRemoteBrowser",
  // Status pages / incidents
  "addStatusPage",
  "deleteStatusPage",
  "getStatusPage",
  "saveStatusPage",
  "postIncident",
  "editIncident",
  "deleteIncident",
  "resolveIncident",
  "unpinIncident",
  "getIncidentHistory",
  // Misc
  "needSetup",
  "setup",
  "initServerTimezone",
  "testChrome",
  "getPushExample",
] as const;

/** Events implemented elsewhere; used only to keep the catch-all log quiet. */
const HANDLED_EVENTS = new Set<string>([
  "login",
  "loginByToken",
  "logout",
  "getMonitor",
  "getMonitorList",
  "getMonitorBeats",
  "getMonitorChartData",
  "pauseMonitor",
  "resumeMonitor",
  "clearEvents",
  "getSettings",
  "getTags",
  ...UNSUPPORTED_EVENTS,
]);

export function registerUnsupportedHandlers(
  socket: Socket,
  logger: Logger,
  logProtocol: boolean,
  requireAuth: RequireAuth,
): void {
  for (const event of UNSUPPORTED_EVENTS) {
    socket.on(event as never, (...args: unknown[]) => {
      const callback = findAck(args);
      // Never pretend the mutation worked. A client that shows "paused" for a
      // monitor that is still running is worse than a visible error.
      if (callback) {
        if (!requireAuth(callback)) return;
        callback({ ok: false, msg: UNSUPPORTED_MESSAGE });
      }

      logger.info(
        { event, hasCallback: callback !== undefined },
        "kuma.event.unsupported",
      );
    });
  }

  // Catch-all: an event from a newer Kuma client becomes visible in the log
  // rather than being silently swallowed. Implemented events are filtered out so
  // this stays quiet in normal operation.
  socket.onAny((event, ...args) => {
    if (HANDLED_EVENTS.has(event)) return;
    logger.info({ event, argCount: args.length, logProtocol }, "kuma.event.unhandled");
  });
}

function findAck(args: unknown[]): Ack | undefined {
  // Kuma's ack is always last when present.
  const last = args[args.length - 1];
  return typeof last === "function" ? (last as Ack) : undefined;
}