import { timingSafeEqual } from "node:crypto";

import type { OpenStatusWebhookPayload } from "../openstatus/types.js";
import { openstatusWebhookSchema } from "../openstatus/types.js";

export interface WebhookVerification {
  ok: boolean;
  reason?: string;
}

/**
 * Authenticate an OpenStatus webhook.
 *
 * OpenStatus webhooks carry **no signature and no HMAC** — the documented
 * mechanism is a custom header you configure yourself (see the OpenStatus
 * notification reference). So the shared secret is the entire auth story, and it
 * is compared in constant time.
 *
 * When no secret is configured the endpoint is disabled entirely rather than
 * left open, because an unauthenticated endpoint that can trigger push-like
 * state changes is an obvious abuse target.
 */
export function verifyWebhookSecret(
  provided: string | undefined,
  expected: string | undefined,
): WebhookVerification {
  if (!expected) return { ok: false, reason: "webhook disabled: OPENSTATUS_WEBHOOK_SECRET is not set" };
  if (!provided) return { ok: false, reason: "missing secret header" };

  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return { ok: false, reason: "invalid secret" };
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: "invalid secret" };
}

export type ParseResult =
  | { ok: true; payload: OpenStatusWebhookPayload }
  | { ok: false; reason: string };

export function parseWebhookPayload(body: unknown): ParseResult {
  const result = openstatusWebhookSchema.safeParse(body);
  if (!result.success) {
    // Only the first issue's path; the payload is untrusted and we do not want to
    // echo it back into a response.
    const issue = result.error.issues[0];
    return { ok: false, reason: `invalid payload at ${issue?.path.join(".") || "(root)"}` };
  }
  return { ok: true, payload: result.data };
}