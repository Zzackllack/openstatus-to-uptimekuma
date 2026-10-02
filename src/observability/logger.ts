import { pino, type Logger } from "pino";
import type { Env } from "../config/env.js";

/** Keys that must never be serialized into a log line, at any nesting depth. */
const REDACT_PATHS = [
  "password",
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers.set-cookie",
  "*.password",
  "*.apiKey",
  "*.api_key",
  "*.token",
  "*.secret",
  "*.headers.authorization",
];

export function createLogger(env: Pick<Env, "LOG_LEVEL" | "NODE_ENV">): Logger {
  const pretty =
    env.NODE_ENV === "development" &&
    process.env["LOG_PRETTY"] !== "false" &&
    // pino-pretty is a devDependency; never let its absence break production.
    canLoadPretty();

  return pino({
    level: env.LOG_LEVEL,
    base: { service: "openstatus-kuma-bridge" },
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" } } } : {}),
  });
}

function canLoadPretty(): boolean {
  try {
    require.resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

export type { Logger };