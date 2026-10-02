import Fastify, { type FastifyInstance } from "fastify";

import { publicConfigSummary, redactUrlCredentials, type Env } from "../config/env.js";
import type { SqliteDatabase } from "../state/sqlite.js";
import { KUMA_COMPATIBILITY_VERSION } from "../kuma/protocol/version.js";
import { isValidTimezone } from "../kuma/info.js";
import type { OpenStatusBackend } from "../openstatus/types.js";
import type { BridgeServices } from "../service/bridge-services.js";
import type { Logger } from "../observability/logger.js";
import type { Reconciler } from "../poller/reconcile.js";
import { applyWebhook, type WebhookOutcome } from "../poller/reconcile.js";
import type { ObservedCheckStore } from "../state/observed-checks.js";
import type { StatusStore } from "../state/status-store.js";
import type { Broadcaster } from "../kuma/broadcaster.js";
import { parseWebhookPayload, verifyWebhookSecret } from "../webhook/verify.js";
import { renderPrometheusMetrics } from "../observability/metrics.js";

export interface HttpDeps {
  env: Env;
  logger: Logger;
  backend: OpenStatusBackend;
  services: BridgeServices;
  statusStore: StatusStore;
  observed: ObservedCheckStore;
  reconciler: Reconciler;
  broadcaster: Broadcaster;
  roomName: string;
  database: SqliteDatabase;
  bridgeVersion: string;
  startedAt: Date;
  /** Live runtime facts the endpoints report without reaching into other modules. */
  runtime: {
    socketCount(): number;
    authenticatedCount(): number;
    backendHealthy(): Promise<boolean>;
  };
}

export async function createHttpServer(deps: HttpDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: deps.env.TRUST_PROXY,
    bodyLimit: deps.env.WEBHOOK_BODY_LIMIT_BYTES,
  });

  // Security headers on every response. These endpoints are not part of the
  // Kuma facade, so nothing here can be relied upon by a client and the headers
  // are purely defence in depth.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    return payload;
  });

  /**
   * Liveness. 200 whenever the process itself is healthy, *regardless* of
   * whether OpenStatus is reachable.
   *
   * These must not be conflated: a bridge that still holds every monitor's last
   * known state is doing its job during an OpenStatus outage, and a container
   * orchestrator killing it for that would turn a monitoring blip into a total
   * loss of visibility.
   */
  app.get("/healthz", async (_request, reply) => {
    const openstatus = deps.services.isStale() ? "stale" : await backendHealth(deps);
    reply.code(200);
    return {
      status: openstatus === "connected" ? "ok" : "degraded",
      openstatus,
      monitors: deps.services.listMonitors().length,
      lastSyncAt: deps.services.getLastSyncAt()?.toISOString() ?? null,
      uptimeSeconds: Math.round((Date.now() - deps.startedAt.getTime()) / 1000),
    };
  });

  /**
   * Readiness. 503 when the bridge cannot currently refresh state, so a load
   * balancer stops sending new clients here while existing ones keep their last
   * known state.
   */
  app.get("/readyz", async (_request, reply) => {
    const openstatus = deps.services.isStale() ? "stale" : await backendHealth(deps);
    const ready = openstatus === "connected";
    reply.code(ready ? 200 : 503);
    return {
      ready,
      openstatus,
      stale: deps.services.isStale(),
      lastSyncAt: deps.services.getLastSyncAt()?.toISOString() ?? null,
    };
  });

  /**
   * Bridge's own diagnostics. Deliberately separate from the Kuma protocol so we
   * never have to add non-Kuma keys to a `monitorList`/`info` payload, where a
   * strict client might reject them.
   */
  app.get("/bridge/info", async () => ({
    name: "openstatus-kuma-bridge",
    version: deps.bridgeVersion,
    kumaCompatibilityVersion: KUMA_COMPATIBILITY_VERSION,
    openstatusConnected: (await backendHealth(deps)) === "connected",
    openstatusApiUrl: redactUrlCredentials(deps.env.OPENSTATUS_API_URL),
    monitors: deps.services.listMonitors().length,
    lastSyncAt: deps.services.getLastSyncAt()?.toISOString() ?? null,
    config: publicConfigSummary(deps.env),
  }));

  app.get("/metrics", async (_request, reply) => {
    if (!deps.env.METRICS_ENABLED) {
      reply.code(404);
      return { error: "metrics disabled" };
    }
    reply.header("Content-Type", "text/plain; version=0.0.4");
    return renderPrometheusMetrics(deps, (await backendHealth(deps)) === "connected");
  });

  app.post("/webhooks/openstatus", async (request, reply) => {
    const header = request.headers[deps.env.OPENSTATUS_WEBHOOK_SECRET_HEADER.toLowerCase()];
    const provided = Array.isArray(header) ? header[0] : header;

    const auth = verifyWebhookSecret(provided, deps.env.OPENSTATUS_WEBHOOK_SECRET);
    if (!auth.ok) {
      // 401 not 403: do not confirm whether the secret exists.
      deps.logger.warn({ reason: auth.reason }, "webhook.rejected");
      reply.code(401);
      return { error: "unauthorized" };
    }

    const parsed = parseWebhookPayload(request.body);
    if (!parsed.ok) {
      reply.code(400);
      return { error: parsed.reason };
    }

    const payload = parsed.payload;
    const outcome = await applyWebhook(
      {
        monitorId: payload.monitor.id,
        cronTimestamp: payload.cronTimestamp,
        status: payload.status,
        ...(payload.latency !== undefined ? { latency: payload.latency } : {}),
        ...(payload.errorMessage !== undefined ? { errorMessage: payload.errorMessage } : {}),
      },
      {
        backend: deps.backend,
        services: deps.services,
        statusStore: deps.statusStore,
        observed: deps.observed,
        broadcaster: deps.broadcaster,
        logger: deps.logger,
        roomName: deps.roomName,
      },
    ).catch((error: unknown): WebhookOutcome => {
      deps.logger.error({ err: error instanceof Error ? error.message : String(error) }, "webhook.apply_failed");
      return { applied: false, reason: "internal error" };
    });

    if (outcome.applied) {
      await deps.reconciler.applyExternalTransition(
        outcome.monitor,
        outcome.check,
        outcome.previous,
        true,
      );
    }

    // Always 200 on a well-formed request: OpenStatus retries 3× on non-2xx and
    // a duplicate delivery would be pointless churn. The `applied` flag is for
    // humans debugging, not for retry control.
    return { received: true, applied: outcome.applied, ...("reason" in outcome ? { reason: outcome.reason } : {}) };
  });

  // Kuma clients that probe a server before connecting sometimes hit these.
  // Answering with the same shapes avoids a confusing "server unreachable".
  app.get("/api/status-page/heartbeat/:slug", () => ({ pageId: null, heartbeatList: {} }));
  app.get("/api/status-page/:slug", async (_request, reply) => {
    reply.code(404);
    return { error: "Not found" };
  });

  app.setNotFoundHandler(async (_request, reply) => {
    reply.code(404);
    return { error: "Not found" };
  });

  return app;
}

/**
 * A health endpoint that throws is worse than useless: it turns "OpenStatus is
 * unreachable" into "the bridge itself is broken", which is exactly the
 * distinction this project exists to preserve. Every probe here is total.
 */
async function backendHealth(deps: HttpDeps): Promise<"connected" | "unavailable"> {
  try {
    return (await deps.runtime.backendHealthy()) ? "connected" : "unavailable";
  } catch (error) {
    deps.logger.warn({ err: error instanceof Error ? error.message : String(error) }, "health.probe_failed");
    return "unavailable";
  }
}

export { isValidTimezone };