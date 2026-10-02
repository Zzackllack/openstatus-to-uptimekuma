import type { Server as SocketServer } from "socket.io";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Env } from "./config/env.js";
import { createLogger, type Logger } from "./observability/logger.js";
import { OpenStatusSdkBackend } from "./openstatus/sdk-backend.js";
import type { OpenStatusBackend } from "./openstatus/types.js";
import { openDatabase } from "./state/database.js";
import { MonitorIdMap } from "./state/monitor-id-map.js";
import { ObservedCheckStore } from "./state/observed-checks.js";
import { StatusStore } from "./state/status-store.js";
import { BridgeServices } from "./service/bridge-services.js";
import { createStatusAggregator } from "./kuma/aggregate/regional.js";
import { createStatusMapper } from "./kuma/mapper/status.js";
import { Broadcaster } from "./kuma/broadcaster.js";
import { AuthService, LoginRateLimiter } from "./kuma/auth.js";
import { buildInfo, isValidTimezone } from "./kuma/info.js";
import { createKumaSocketServer } from "./kuma/server.js";
import { createHttpServer } from "./http/server.js";
import { Reconciler } from "./poller/reconcile.js";

/** Single-user bridge: every authenticated socket shares one Kuma room. */
const ROOM_NAME = "bridge";

export interface Bridge {
  env: Env;
  logger: Logger;
  close(): Promise<void>;
  address(): { host: string; port: number };
}

/**
 * Composition root.
 *
 * `backend` is injectable so integration tests can drive the whole stack with a
 * fake OpenStatus and no network access.
 */
export async function startBridge(
  env: Env,
  options: { backend?: OpenStatusBackend; logger?: Logger } = {},
): Promise<Bridge> {
  const logger = options.logger ?? createLogger(env);

  if (!isValidTimezone(env.SERVER_TIMEZONE)) {
    throw new Error(`SERVER_TIMEZONE "${env.SERVER_TIMEZONE}" is not a valid IANA timezone.`);
  }

  const database = openDatabase({ path: env.DATABASE_PATH, logger });
  const idMap = new MonitorIdMap(database);
  const observed = new ObservedCheckStore(database);
  const statusStore = new StatusStore();

  const backend =
    options.backend ??
    new OpenStatusSdkBackend(
      {
        OPENSTATUS_API_URL: env.OPENSTATUS_API_URL,
        OPENSTATUS_API_KEY: env.OPENSTATUS_API_KEY,
        MAX_HISTORY_HOURS: env.MAX_HISTORY_HOURS,
      },
      logger,
    );

  const statusMapper = createStatusMapper(env.DEGRADED_STATUS_MAPPING);
  const aggregator = createStatusAggregator(env.STATUS_AGGREGATION_STRATEGY);

  const services = new BridgeServices({
    backend,
    idMap,
    observed,
    statusStore,
    aggregator,
    statusMapper,
    latencyStrategy: env.LATENCY_AGGREGATION,
    historySource: env.HISTORY_SOURCE,
    env: {
      MAX_HISTORY_HOURS: env.MAX_HISTORY_HOURS,
      HEARTBEAT_CACHE_TTL_SECONDS: env.HEARTBEAT_CACHE_TTL_SECONDS,
      MAX_OPENSTATUS_CONCURRENCY: env.MAX_OPENSTATUS_CONCURRENCY,
      STALE_AFTER_SECONDS: env.STALE_AFTER_SECONDS,
    },
    logger,
  });

  // Declared before `io` on purpose: the thunk is only invoked at emit time, by
  // which point the Socket.IO server exists.
  let ioRef: SocketServer | null = null;
  const io = (): SocketServer => {
    if (!ioRef) throw new Error("broadcaster used before the socket server was created");
    return ioRef;
  };
  const broadcaster = new Broadcaster({ io, statusMapper });

  const reconciler = new Reconciler({
    backend,
    services,
    statusStore,
    observed,
    idMap,
    broadcaster,
    logger,
    statusPollIntervalSeconds: env.STATUS_POLL_INTERVAL_SECONDS,
    monitorListRefreshSeconds: env.MONITOR_LIST_REFRESH_SECONDS,
    summaryRefreshSeconds: env.SUMMARY_REFRESH_SECONDS,
    observedRetentionDays: Math.max(1, Math.ceil(env.MAX_HISTORY_HOURS / 24)),
    roomName: ROOM_NAME,
  });

  const fastify = await createHttpServer({
    env,
    logger,
    backend,
    services,
    statusStore,
    observed,
    reconciler,
    broadcaster,
    roomName: ROOM_NAME,
    database,
    bridgeVersion: await readVersion(),
    startedAt: new Date(),
    runtime: {
      socketCount: () => io().engine.clientsCount,
      authenticatedCount: () => io().sockets.adapter.rooms.get(ROOM_NAME)?.size ?? 0,
      backendHealthy: async () => backend.checkHealth(),
    },
  });

  // Fastify owns the HTTP server: one port serves /healthz, /bridge/info,
  // /webhooks/openstatus and the Socket.IO transport, so a reverse proxy only
  // needs a single upstream. Attaching before listen keeps the handshake on the
  // same server from the very first connection.
  await fastify.ready();
  ioRef = createKumaSocketServer({
    httpServer: fastify.server,
    services,
    broadcaster,
    auth: new AuthService(env, logger),
    rateLimiter: new LoginRateLimiter(env.LOGIN_RATE_LIMIT_PER_MINUTE),
    logger,
    info: buildInfo({ primaryBaseURL: env.PUBLIC_BASE_URL, serverTimezone: env.SERVER_TIMEZONE }),
    initialHeartbeatCount: env.INITIAL_HEARTBEAT_COUNT,
    maxConnections: env.MAX_SOCKET_CONNECTIONS,
    allowedOrigins: env.ALLOWED_ORIGINS,
    logProtocol: env.LOG_PROTOCOL,
    roomName: ROOM_NAME,
  });

  await fastify.listen({ port: env.PORT, host: env.HOST });
  await reconciler.start();

  logger.info(
    {
      port: env.PORT,
      publicBaseURL: env.PUBLIC_BASE_URL,
      monitors: services.listMonitors().length,
      openstatusApiUrl: env.OPENSTATUS_API_URL.replace(/\/\/[^@/]+@/, "//[redacted]@"),
    },
    "bridge.started",
  );

  const close = async (): Promise<void> => {
    reconciler.stop();
    await closeSocketServer(io);
    await fastify.close();
    void database.close();
    logger.info("bridge.stopped");
  };

  return {
    env,
    logger,
    close,
    address: () => ({ host: env.HOST, port: env.PORT }),
  };
}

/**
 * Socket.IO 4's `close()` is promise-returning when called without a callback,
 * which is what we want: it resolves once the HTTP server has fully drained, so
 * in-flight acks are not cut off mid-response.
 */
async function closeSocketServer(io: () => SocketServer): Promise<void> {
  await io().close();
}

async function readVersion(): Promise<string> {
  try {
    const url = new URL("../package.json", import.meta.url);
    const raw = await readFile(fileURLToPath(url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
      const version = (parsed).version;
      if (typeof version === "string") return version;
    }
  } catch {
    // Running from a bundle without package.json next to it.
  }
  return "0.0.0";
}