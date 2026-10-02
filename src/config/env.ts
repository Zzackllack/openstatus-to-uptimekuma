import { z } from "zod";

/**
 * All bridge configuration in one place.
 *
 * Two rules the schema enforces for us:
 *  - secrets are never printed on failure (see `formatValidationError`)
 *  - nothing here can be influenced by a connecting client
 */

const DEFAULT_OPENSTATUS_API_URL = "https://api.openstatus.dev/rpc";

const logLevel = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

const degradedMapping = z.enum(["pending", "up", "down"]);
const aggregationStrategy = z.enum(["openstatus", "worst", "majority", "all", "any"]);
const latencyStrategy = z.enum(["median", "mean", "min", "max", "p50"]);
const historySource = z.enum(["auto", "openstatus", "local"]);

/** Argon2id PHC string, as produced by `pnpm bridge password hash`. */
const argon2Hash = z
  .string()
  .refine((v) => v.startsWith("$argon2id$"), {
    message: "must be an Argon2id PHC hash (start with $argon2id$) — generate one with `pnpm bridge password hash`",
  });

const port = z.coerce.number().int().min(1).max(65535);

/** A URL that must be https (or loopback http) — used for anything a browser may load. */
const publicBaseUrl = z
  .string()
  .url()
  .refine((v) => {
    const url = new URL(v);
    return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
  }, "must be https (http is only allowed for localhost)");

const openstatusApiUrl = z.string().url().refine((v) => v.startsWith("http://") || v.startsWith("https://"), {
  message: "must be an http(s) URL",
});

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
    LOG_LEVEL: logLevel.default("info"),

    HOST: z.string().default("0.0.0.0"),
    PORT: port.default(3000),

    /**
     * Advertised to clients in the Kuma `info` event. Native clients use it to
     * build status-page and badge URLs, so it must be the externally reachable
     * origin — not localhost.
     */
    PUBLIC_BASE_URL: publicBaseUrl,
    SERVER_TIMEZONE: z.string().default("UTC"),
    TRUST_PROXY: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),

    // --- OpenStatus (server-side only; never leaves this process) ---
    OPENSTATUS_API_URL: openstatusApiUrl.default(DEFAULT_OPENSTATUS_API_URL),
    OPENSTATUS_API_KEY: z.string().min(1, "OPENSTATUS_API_KEY is required"),

    // --- Bridge auth ---
    BRIDGE_USERNAME: z.string().min(1, "BRIDGE_USERNAME is required"),
    BRIDGE_PASSWORD_HASH: argon2Hash,
    JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
    /** Token lifetime for remembered logins. Kuma clients treat this as "forever" anyway. */
    JWT_EXPIRES_IN: z.string().default("30d"),

    // --- Storage ---
    DATABASE_PATH: z.string().default("./data/bridge.sqlite"),

    // --- Polling / caching ---
    STATUS_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(600).default(30),
    MONITOR_LIST_REFRESH_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
    SUMMARY_REFRESH_SECONDS: z.coerce.number().int().min(30).max(86400).default(300),
    /** OpenStatus allows 600 req/min per API key. Stay well under it. */
    MAX_OPENSTATUS_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(5),
    STALE_AFTER_SECONDS: z.coerce.number().int().min(60).default(300),

    INITIAL_HEARTBEAT_COUNT: z.coerce.number().int().min(1).max(150).default(100),
    HEARTBEAT_CACHE_TTL_SECONDS: z.coerce.number().int().min(5).max(600).default(60),
    HISTORY_CACHE_TTL_SECONDS: z.coerce.number().int().min(10).max(3600).default(300),

    // --- Translation semantics ---
    DEGRADED_STATUS_MAPPING: degradedMapping.default("pending"),
    STATUS_AGGREGATION_STRATEGY: aggregationStrategy.default("openstatus"),
    LATENCY_AGGREGATION: latencyStrategy.default("median"),
    /**
     * `openstatus` uses real response logs but only HTTP monitors expose them.
     * `auto` (default) uses them for HTTP and the bridge's own observation log
     * for TCP/DNS, so those monitors still get a truthful (if shorter) history.
     */
    HISTORY_SOURCE: historySource.default("auto"),
    /** Hard cap regardless of what a client asks for. Kuma itself caps at 720h/365d. */
    MAX_HISTORY_HOURS: z.coerce.number().int().min(1).max(8760).default(720),

    // --- Webhook ---
    OPENSTATUS_WEBHOOK_SECRET: z.string().min(16).optional(),
    OPENSTATUS_WEBHOOK_SECRET_HEADER: z.string().default("X-Bridge-Secret"),
    WEBHOOK_BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).max(1_048_576).default(16_384),

    // --- Limits / hardening ---
    LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100).default(10),
    MAX_SOCKET_CONNECTIONS: z.coerce.number().int().min(1).max(1000).default(50),
    /**
     * Comma-separated allowed browser origins for Socket.IO polling. Native
     * clients send no Origin at all, so this only constrains web clients.
     * Empty = allow any origin (Kuma's own production behaviour).
     */
    ALLOWED_ORIGINS: z
      .string()
      .default("")
      .transform((v) =>
        v
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      ),

    METRICS_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    LOG_PROTOCOL: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  })
  .superRefine((env, ctx) => {
    if (env.OPENSTATUS_WEBHOOK_SECRET === undefined && env.OPENSTATUS_WEBHOOK_SECRET_HEADER !== "X-Bridge-Secret") {
      // Harmless, but a custom header without a secret is a config mistake that
      // silently disables webhook authentication.
      ctx.addIssue({
        code: "custom",
        path: ["OPENSTATUS_WEBHOOK_SECRET_HEADER"],
        message: "set OPENSTATUS_WEBHOOK_SECRET or revert the header name; a custom header without a secret is pointless",
      });
    }
  });

export type Env = z.infer<typeof schema>;

/**
 * Keys whose values must never reach a log line, a crash message or stdout.
 * Zod's own error output only contains the *received* value for `invalid_type`
 * on some paths, so we redact by key name rather than relying on that.
 */
const SECRET_KEYS = new Set([
  "OPENSTATUS_API_KEY",
  "BRIDGE_PASSWORD_HASH",
  "JWT_SECRET",
  "OPENSTATUS_WEBHOOK_SECRET",
]);

function redact(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    result[key] = SECRET_KEYS.has(key) ? "[redacted]" : inner;
  }
  return result;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: { path: string; message: string }[],
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Env {
  // Empty strings are what you get from an unset variable in a .env file or a
  // compose file; treat them as absent so defaults and refinements behave.
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value.length > 0) cleaned[key] = value;
  }

  const result = schema.safeParse(cleaned);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));

  throw new ConfigError(
    `Invalid configuration:\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n")}\n\nSee .env.example for the full list of variables.`,
    issues,
  );
}

/** For `/bridge/info` — a safe subset of the config. */
export function publicConfigSummary(env: Env): Record<string, unknown> {
  return redact({
    nodeEnv: env.NODE_ENV,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    serverTimezone: env.SERVER_TIMEZONE,
    openstatusApiUrl: redactUrlCredentials(env.OPENSTATUS_API_URL),
    degradedStatusMapping: env.DEGRADED_STATUS_MAPPING,
    statusAggregationStrategy: env.STATUS_AGGREGATION_STRATEGY,
    latencyAggregation: env.LATENCY_AGGREGATION,
    historySource: env.HISTORY_SOURCE,
    maxHistoryHours: env.MAX_HISTORY_HOURS,
    staleAfterSeconds: env.STALE_AFTER_SECONDS,
  });
}

/** An API URL can legitimately contain basic-auth credentials; never log them. */
export function redactUrlCredentials(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
      return `${url.toString()} [credentials redacted]`;
    }
    return url.toString();
  } catch {
    return "[unparseable url]";
  }
}

export { DEFAULT_OPENSTATUS_API_URL };