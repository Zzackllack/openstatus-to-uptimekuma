import { describe, expect, it } from "vitest";

import { isImportantBeat, buildStatusMessage } from "../../src/kuma/mapper/heartbeat.js";
import {
  KUMA_STATUS_DOWN,
  KUMA_STATUS_MAINTENANCE,
  KUMA_STATUS_PENDING,
  KUMA_STATUS_UP,
} from "../../src/kuma/protocol/version.js";
import { region } from "../helpers/fake-openstatus.js";

/**
 * Table copied from `Monitor.isImportantBeat` in Uptime Kuma 2.5.5
 * (`server/model/monitor.js:1391`). The notable rule is that PENDING is never
 * important except on the way to DOWN — which is exactly why a degraded monitor
 * (mapped to PENDING by default) does not raise a Kuma toast.
 */
describe("isImportantBeat", () => {
  it("treats the first beat as important", () => {
    expect(isImportantBeat(true, undefined, KUMA_STATUS_UP)).toBe(true);
  });

  it("ignores transitions into and out of PENDING", () => {
    expect(isImportantBeat(false, KUMA_STATUS_UP, KUMA_STATUS_PENDING)).toBe(false);
    expect(isImportantBeat(false, KUMA_STATUS_PENDING, KUMA_STATUS_UP)).toBe(false);
    expect(isImportantBeat(false, KUMA_STATUS_PENDING, KUMA_STATUS_PENDING)).toBe(false);
  });

  it("marks PENDING -> DOWN important", () => {
    expect(isImportantBeat(false, KUMA_STATUS_PENDING, KUMA_STATUS_DOWN)).toBe(true);
  });

  it("marks hard transitions important and repeats unimportant", () => {
    expect(isImportantBeat(false, KUMA_STATUS_UP, KUMA_STATUS_DOWN)).toBe(true);
    expect(isImportantBeat(false, KUMA_STATUS_DOWN, KUMA_STATUS_UP)).toBe(true);
    expect(isImportantBeat(false, KUMA_STATUS_DOWN, KUMA_STATUS_DOWN)).toBe(false);
    expect(isImportantBeat(false, KUMA_STATUS_UP, KUMA_STATUS_UP)).toBe(false);
  });

  it("marks any change involving MAINTENANCE important", () => {
    expect(isImportantBeat(false, KUMA_STATUS_UP, KUMA_STATUS_MAINTENANCE)).toBe(true);
    expect(isImportantBeat(false, KUMA_STATUS_MAINTENANCE, KUMA_STATUS_UP)).toBe(true);
    expect(isImportantBeat(false, KUMA_STATUS_MAINTENANCE, KUMA_STATUS_DOWN)).toBe(true);
    expect(isImportantBeat(false, KUMA_STATUS_MAINTENANCE, KUMA_STATUS_MAINTENANCE)).toBe(false);
  });
});

describe("buildStatusMessage", () => {
  it("states the healthy-region count when regions are known", () => {
    const message = buildStatusMessage("up", [region("ams", "up"), region("iad", "up")]);
    expect(message).toContain("2/2 locations healthy");
  });

  it("names the OpenStatus reason for degraded instead of pretending it is pending", () => {
    const message = buildStatusMessage("degraded", [region("ams", "up"), region("iad", "degraded")], {
      degradedThresholdMs: 500,
    });
    expect(message).toMatch(/^Degraded/);
    expect(message).toContain("500 ms");
    expect(message).not.toMatch(/Pending/);
  });

  it("reports failure for down", () => {
    const message = buildStatusMessage("down", [region("ams", "down"), region("iad", "down")]);
    expect(message).toMatch(/^Connection failed/);
    expect(message).toContain("0/2 locations healthy");
  });

  it("degrades gracefully with no region data at all", () => {
    expect(buildStatusMessage("up", [])).toBe("OK");
    expect(buildStatusMessage("unknown", [])).toMatch(/No check data/);
  });
});