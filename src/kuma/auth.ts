import { hash, verify } from "@node-rs/argon2";
import { SignJWT, jwtVerify } from "jose";
import { createHash, timingSafeEqual } from "node:crypto";

import type { Env } from "../config/env.js";
import type { Logger } from "../observability/logger.js";

/**
 * Bridge-local authentication.
 *
 * Deliberately *not* a pass-through: the phone authenticates against this
 * process, this process authenticates against OpenStatus with its own API key.
 * A client can therefore never see or influence OpenStatus credentials, and a
 * compromised phone cannot escalate into an OpenStatus session.
 */

/**
 * Kuma's JWT payload shape (`server/model/user.js`): clients read `username` from
 * the decoded token to prefill the UI, and the `h` claim ties the token to the
 * stored password so changing the password invalidates old tokens. We reproduce
 * both claim names.
 */
export interface BridgeTokenClaims {
  username: string;
  /** SHAKE-256 of the stored password hash, as in Kuma. */
  h: string;
}

export class AuthService {
  private readonly key: Uint8Array;

  constructor(
    private readonly env: Pick<Env, "JWT_SECRET" | "JWT_EXPIRES_IN" | "BRIDGE_USERNAME" | "BRIDGE_PASSWORD_HASH">,
    private readonly logger: Logger,
  ) {
    this.key = new TextEncoder().encode(env.JWT_SECRET);
  }

  async verifyCredentials(username: unknown, password: unknown): Promise<boolean> {
    if (typeof username !== "string" || typeof password !== "string") {
      // Still burn a hash verification so a malformed request is not
      // distinguishable from a wrong password by timing.
      await verifyPassword("", this.env.BRIDGE_PASSWORD_HASH);
      return false;
    }

    if (!constantTimeEquals(username, this.env.BRIDGE_USERNAME)) {
      await verifyPassword(password, this.env.BRIDGE_PASSWORD_HASH);
      return false;
    }

    return verifyPassword(password, this.env.BRIDGE_PASSWORD_HASH);
  }

  async issueToken(username: string): Promise<string> {
    const claims: BridgeTokenClaims = {
      username,
      h: passwordFingerprint(this.env.BRIDGE_PASSWORD_HASH),
    };

    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer("openstatus-kuma-bridge")
      .setExpirationTime(this.env.JWT_EXPIRES_IN)
      .sign(this.key);
  }

  /**
   * Returns the username on success, null on any failure. Deliberately does not
   * distinguish "expired" from "bad signature" — the client only needs to know
   * that it must log in again.
   */
  async verifyToken(token: unknown): Promise<string | null> {
    if (typeof token !== "string" || token.length === 0) return null;
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: "openstatus-kuma-bridge" });
      const username = payload["username"];
      if (typeof username !== "string") return null;
      if (!constantTimeEquals(username, this.env.BRIDGE_USERNAME)) return null;

      // Password change must invalidate remembered logins.
      const expected = passwordFingerprint(this.env.BRIDGE_PASSWORD_HASH);
      if (typeof payload["h"] !== "string" || !constantTimeEquals(payload["h"], expected)) {
        this.logger.info("auth.token.stale_password_fingerprint");
        return null;
      }

      return username;
    } catch {
      return null;
    }
  }
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return verify(hash, password, { algorithm: 2 /* argon2id */ });
  } catch {
    // A malformed hash in config must read as "wrong password", not as a 500
    // with the hash attached. Config validation already rejects non-argon2id.
    return Promise.resolve(false);
  }
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, { algorithm: 2 /* argon2id */ });
}

function passwordFingerprint(passwordHash: string): string {
  // Kuma uses SHAKE-256 over the stored hash. Exact algorithm fidelity is not
  // required (only our own tokens are verified against it), but staying close
  // keeps the claim meaningful to anyone reading a captured token.
  return createHash("sha256").update(passwordHash).digest("hex");
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (bufferA.length !== bufferB.length) {
    // Hash both sides to fixed length so the comparison itself is still
    // constant-time with respect to content.
    const digestA = createHash("sha256").update(bufferA).digest();
    const digestB = createHash("sha256").update(bufferB).digest();
    return timingSafeEqual(digestA, digestB) && false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Token-bucket login limiter, per remote address.
 *
 * Kuma uses the `limiter` package with 30 tokens refilled at 1/30s per IP
 * (`server/rate-limiter.js`). Ours is deliberately stricter by default because a
 * single-user bridge does not need to tolerate a login storm from many clients.
 */
export class LoginRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    private readonly tokensPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  pass(key: string): boolean {
    const capacity = this.tokensPerMinute;
    const refillPerMs = capacity / 60_000;
    const bucket = this.buckets.get(key) ?? { tokens: capacity, updatedAt: this.now() };

    const elapsed = this.now() - bucket.updatedAt;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
    bucket.updatedAt = this.now();

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }

    bucket.tokens -= 1;
    this.buckets.set(key, bucket);

    // Keep the map from growing without bound on a long-lived public process.
    if (this.buckets.size > 10_000) this.prune();
    return true;
  }

  private prune(): void {
    const cutoff = this.now() - 300_000;
    for (const [key, bucket] of this.buckets) {
      if (bucket.updatedAt < cutoff) this.buckets.delete(key);
    }
  }
}