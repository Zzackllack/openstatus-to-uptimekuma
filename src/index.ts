import { ConfigError, loadConfig, type Env } from "./config/env.js";
import { startBridge } from "./app.js";
import { createLogger } from "./observability/logger.js";

/**
 * Process entry point.
 *
 * Config is validated before anything binds a port, and a config error is
 * printed without ever echoing a secret value.
 */
async function main(): Promise<void> {
  let env;
  try {
    env = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }

  const bridge = await startBridge(env);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    bridge.logger.info({ signal }, "bridge.shutdown_requested");
    bridge
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        bridge.logger.error({ err: error }, "bridge.shutdown_failed");
        process.exit(1);
      });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    bridge.logger.error({ err: reason }, "process.unhandled_rejection");
  });
  process.on("uncaughtException", (error) => {
    bridge.logger.fatal({ err: error }, "process.uncaught_exception");
    shutdown("uncaughtException");
  });
}

main().catch((error: unknown) => {
  const logger = createLogger({ LOG_LEVEL: "info", NODE_ENV: "production" } satisfies Pick<Env, "LOG_LEVEL" | "NODE_ENV">);
  logger.fatal({ err: error }, "bridge.startup_failed");
  process.exit(1);
});