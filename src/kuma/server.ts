import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import type { Logger } from "pino";

import type { NormalizedCheck } from "../model/monitor.js";
import type { BridgeServices } from "../service/bridge-services.js";
import type { AuthService, LoginRateLimiter } from "./auth.js";
import type { Broadcaster } from "./broadcaster.js";
import type { KumaInfo } from "./protocol/monitor.js";
import { isImportantBeat } from "./mapper/heartbeat.js";
import { toKumaMonitor, toKumaMonitorList } from "./mapper/monitor.js";
import { buildChartData, computeUptime } from "./mapper/chart.js";
import { buildInfo, buildMonitorTypeList } from "./info.js";
import { registerMonitorHandlers } from "./handlers/monitor.js";
import { registerHistoryHandlers } from "./handlers/history.js";
import { registerUnsupportedHandlers } from "./handlers/unsupported.js";

export interface KumaSocketServerDeps {
  httpServer: HttpServer;
  services: BridgeServices;
  broadcaster: Broadcaster;
  auth: AuthService;
  rateLimiter: LoginRateLimiter;
  logger: Logger;
  info: KumaInfo;
  initialHeartbeatCount: number;
  maxConnections: number;
  allowedOrigins: string[];
  logProtocol: boolean;
  /** Room every authenticated socket joins. Kuma keys rooms by user id. */
  roomName: string;
}

const UNSUPPORTED_MESSAGE = "Not supported by OpenStatus compatibility bridge";

/**
 * The Kuma-facing Socket.IO server.
 *
 * Event ordering is copied from `afterLogin()` in Uptime Kuma 2.5.5
 * (`server/server.js:1834`) because clients are order-sensitive: `monitorList`
 * must exist before any `heartbeat` references a monitor id, and the frontend
 * reads `info.version` from the *second* push.
 */
export function createKumaSocketServer(deps: KumaSocketServerDeps): Server {
  const io = new Server(deps.httpServer, {
    path: "/socket.io/",
    serveClient: false,
    // Kuma leaves `cors` undefined in production, i.e. it relies on the
    // Origin check. Native clients send no Origin, so an empty allow-list here
    // behaves like Kuma; a non-empty one locks web clients down.
    cors:
      deps.allowedOrigins.length > 0
        ? { origin: deps.allowedOrigins, credentials: false }
        : undefined,
    maxHttpBufferSize: 1e6,
    pingTimeout: 25_000,
    allowRequest: (_req, callback) => {
      const total = io.engine.clientsCount;
      if (total >= deps.maxConnections) {
        deps.logger.warn({ total, limit: deps.maxConnections }, "socket.connection.rejected");
        callback("Too many connections", false);
        return;
      }
      callback(null, true);
    },
  });

  io.on("connection", (socket) => {
    handleConnection(socket, io, deps);
  });

  return io;
}

function handleConnection(socket: Socket, io: Server, deps: KumaSocketServerDeps): void {
  const clientId = socket.id;
  deps.logger.info({ clientId }, "socket.connected");

  // Order matters: Kuma sends `info` first, then registers handlers, then
  // `loginRequired`.
  deps.broadcaster.info(socket, deps.info);

  let authenticated = false;

  const login = async (username: unknown, password: unknown, callback?: (r: unknown) => void): Promise<void> => {
    if (!deps.rateLimiter.pass(clientId)) {
      deps.logger.warn({ clientId }, "socket.auth.rate_limited");
      reply(callback, { ok: false, msg: "Too many login attempts", msgi18n: false });
      return;
    }

    const ok = await deps.auth.verifyCredentials(username, password);
    if (!ok) {
      deps.logger.warn({ clientId }, "socket.auth.failed");
      reply(callback, { ok: false, msg: "authIncorrectCreds", msgi18n: true });
      return;
    }

    authenticated = true;
    void socket.join(deps.roomName);

    const token = await deps.auth.issueToken(String(username));
    deps.logger.info({ clientId, user: username }, "socket.auth.success");

    reply(callback, { ok: true, token });

    // Kuma emits the state *after* the ack, so the client has a token stored
    // before the first heartbeat arrives.
    await sendInitialState(socket, io, deps);
  };

  socket.on("login", (data: unknown, callback?: (r: unknown) => void) => {
    if (deps.logProtocol) {
      deps.logger.debug({ clientId, event: "login" }, "kuma.event.received");
    }
    const payload = (data ?? {}) as { username?: unknown; password?: unknown };
    // Errors inside `login` are already turned into ack payloads by its own
    // try/catch paths; the catch here is the last line of defence so a Socket.IO
    // handler can never leave an unhandled rejection.
    void login(payload.username, payload.password, callback).catch((error: unknown) => {
      deps.logger.error({ clientId, err: describe(error) }, "socket.login.failed");
      callback?.({ ok: false, msg: "Login failed" });
    });
  });

  socket.on("loginByToken", (token: unknown, callback?: (r: unknown) => void) => {
    if (deps.logProtocol) {
      deps.logger.debug({ clientId, event: "loginByToken" }, "kuma.event.received");
    }
    const byToken = async (): Promise<void> => {
      if (!deps.rateLimiter.pass(clientId)) {
        reply(callback, { ok: false, msg: "Too many login attempts", msgi18n: false });
        return;
      }

      const username = await deps.auth.verifyToken(token);
      if (username === null) {
        // Kuma's exact keys, so translated clients show their own wording.
        reply(callback, { ok: false, msg: "authInvalidToken", msgi18n: true });
        return;
      }

      authenticated = true;
      void socket.join(deps.roomName);
      deps.logger.info({ clientId, user: username }, "socket.auth.token_success");
      reply(callback, { ok: true });
      await sendInitialState(socket, io, deps);
    };

    void byToken().catch((error: unknown) => {
      deps.logger.error({ clientId, err: describe(error) }, "socket.loginByToken.failed");
      reply(callback, { ok: false, msg: "Login failed" });
    });
  });

  socket.on("logout", (callback?: (r: unknown) => void) => {
    void socket.leave(deps.roomName);
    authenticated = false;
    reply(callback, { ok: true });
  });

  const requireAuth = (callback: unknown): boolean => {
    if (authenticated) return true;
    // Kuma's `checkLogin` throws "You are not logged in."
    reply(callback, { ok: false, msg: "You are not logged in." });
    return false;
  };

  registerMonitorHandlers(socket, deps.services, deps.broadcaster, requireAuth);
  registerHistoryHandlers(socket, deps.services, deps.broadcaster, requireAuth);
  registerUnsupportedHandlers(socket, deps.logger, deps.logProtocol, requireAuth);

  socket.on("getSettings", (callback?: (r: unknown) => void) => {
    if (!requireAuth(callback)) return;
    reply(callback, {
      ok: true,
      data: {
        // Everything the Settings page reads. Reported honestly rather than
        // pretending the features exist.
        checkUpdate: false,
        searchEngineIndex: false,
        entryPage: "dashboard",
        primaryBaseURL: deps.info.primaryBaseURL,
        serverTimezone: deps.info.serverTimezone,
        keepDataPeriodDays: 0,
        tlsExpiryNotifyDays: 0,
        domainExpiryNotifyDays: 0,
        trustProxy: false,
      },
    });
  });

  socket.on("getTags", (callback?: (r: unknown) => void) => {
    if (!requireAuth(callback)) return;
    // OpenStatus does not expose monitor tags over RPC (see protocol research),
    // so there is nothing truthful to return.
    reply(callback, { ok: true, tags: [] });
  });

  deps.broadcaster.loginRequired(socket);

  socket.on("disconnect", (reason) => {
    deps.logger.info({ clientId, reason }, "socket.disconnected");
  });
}

/**
 * Reproduces `afterLogin()`.
 *
 * `Promise.all` over monitors rather than sequential sends: with hundreds of
 * monitors a serial loop would take minutes, and clients time out.
 */
async function sendInitialState(socket: Socket, io: Server, deps: KumaSocketServerDeps): Promise<void> {
  const { broadcaster, services } = deps;
  const monitors = services.listMonitors();

  broadcaster.monitorList(socket, toKumaMonitorList(monitors));

  // Second `info` — this is the one Kuma clients read `version` from.
  broadcaster.info(socket, deps.info);
  broadcaster.maintenanceList(socket);
  broadcaster.notificationList(socket);
  broadcaster.proxyList(socket);
  broadcaster.dockerHostList(socket);
  broadcaster.apiKeyList(socket);
  broadcaster.remoteBrowserList(socket);
  broadcaster.statusPageList(socket);
  broadcaster.monitorTypeList(socket, buildMonitorTypeList());

  await Promise.all(
    monitors.map(async (monitor) => {
      try {
        // `historyFor` returns newest-first; Kuma pushes oldest-first.
        const chronological = (await historyFor(services, monitor, deps.initialHeartbeatCount)).reverse();

        const beats = chronological.map((check, index) => {
          const previous = chronological[index - 1];
          const important = isImportantBeat(
            index === 0,
            previous ? deps.broadcaster.kumaStatusOf(previous) : undefined,
            deps.broadcaster.kumaStatusOf(check),
          );
          return deps.broadcaster.toHeartbeat(monitor, check, important);
        });

        broadcaster.heartbeatList(socket, monitor.kumaId, beats, true);
        broadcaster.stats({ monitor, checks: chronological, room: deps.roomName });
      } catch (error) {
        // One monitor failing to load history must not abort the whole login.
        deps.logger.error(
          { monitorKumaId: monitor.kumaId, err: describe(error) },
          "socket.initial_state.monitor_failed",
        );
        broadcaster.heartbeatList(socket, monitor.kumaId, [], true);
      }
    }),
  );

  deps.logger.info({ clientId: socket.id, monitors: monitors.length }, "socket.initial_state.sent");
  void io;
}

async function historyFor(
  services: BridgeServices,
  monitor: Parameters<BridgeServices["recentChecks"]>[0],
  count: number,
): Promise<NormalizedCheck[]> {
  const recent = services.recentChecks(monitor, count);
  if (recent.length > 0) return recent;

  // Fall back to upstream history so a freshly started bridge is not blank.
  const hours = Math.max(1, Math.ceil((monitor.intervalSeconds * count) / 3600));
  const history = await services.getHistory(monitor, hours);
  return history.slice(-count);
}

function reply(callback: unknown, payload: unknown): void {
  if (typeof callback === "function") {
    (callback as (p: unknown) => void)(payload);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { toKumaMonitor, buildChartData, computeUptime, buildInfo };
export const UNSUPPORTED = UNSUPPORTED_MESSAGE;