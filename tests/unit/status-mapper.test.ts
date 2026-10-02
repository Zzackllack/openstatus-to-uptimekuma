import { describe, expect, it } from "vitest";

import { createStatusMapper } from "../../src/kuma/mapper/status.js";
import {
  KUMA_STATUS_DOWN,
  KUMA_STATUS_MAINTENANCE,
  KUMA_STATUS_PENDING,
  KUMA_STATUS_UP,
} from "../../src/kuma/protocol/version.js";

/**
 * These assertions mirror `server/uptime-calculator.js` and `src/util.ts` in
 * Uptime Kuma 2.5.5. If Uptime Kuma ever changes them, these tests are the place
 * to notice.
 */
describe("status mapper", () => {
  it("maps normalized statuses to Kuma codes", () => {
    const mapper = createStatusMapper("pending");
    expect(mapper.toKuma("up")).toBe(KUMA_STATUS_UP);
    expect(mapper.toKuma("down")).toBe(KUMA_STATUS_DOWN);
    expect(mapper.toKuma("degraded")).toBe(KUMA_STATUS_PENDING);
    expect(mapper.toKuma("maintenance")).toBe(KUMA_STATUS_MAINTENANCE);
    expect(mapper.toKuma("unknown")).toBe(KUMA_STATUS_PENDING);
  });

  it("honours the degraded mapping override", () => {
    expect(createStatusMapper("up").toKuma("degraded")).toBe(KUMA_STATUS_UP);
    expect(createStatusMapper("down").toKuma("degraded")).toBe(KUMA_STATUS_DOWN);
    expect(createStatusMapper("pending").toKuma("degraded")).toBe(KUMA_STATUS_PENDING);
  });

  it("reproduces Kuma's flatStatus: maintenance counts as UP, pending as DOWN", () => {
    const mapper = createStatusMapper("pending");
    expect(mapper.toKumaFlat(KUMA_STATUS_UP)).toBe("UP");
    expect(mapper.toKumaFlat(KUMA_STATUS_MAINTENANCE)).toBe("UP");
    expect(mapper.toKumaFlat(KUMA_STATUS_DOWN)).toBe("DOWN");
    expect(mapper.toKumaFlat(KUMA_STATUS_PENDING)).toBe("DOWN");
  });
});