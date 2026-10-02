import { describe, expect, it } from "vitest";

import { createStatusAggregator, aggregateLatency } from "../../src/kuma/aggregate/regional.js";
import { makeMonitor, region } from "../helpers/fake-openstatus.js";

describe("status aggregation", () => {
  const monitor = makeMonitor({ status: "up" });

  it("uses OpenStatus' own verdict by default", () => {
    const aggregator = createStatusAggregator("openstatus");
    // OpenStatus says degraded (e.g. 1 of 4 regions slow, below quorum). The
    // bridge must not second-guess that into "up".
    const degraded = makeMonitor({ status: "degraded" });
    expect(aggregator.aggregate(degraded, [region("a", "up"), region("b", "up"), region("c", "up"), region("d", "degraded")])).toBe(
      "degraded",
    );
    expect(aggregator.aggregate(monitor, [region("a", "up"), region("b", "up")])).toBe("up");
  });

  it("falls back to a local quorum only when OpenStatus has no verdict", () => {
    const unknown = makeMonitor({ status: "unknown" });
    const aggregator = createStatusAggregator("openstatus");

    // 1 of 4 failing is below the 50 % quorum -> still up
    expect(
      aggregator.aggregate(unknown, [region("a", "up"), region("b", "up"), region("c", "up"), region("d", "down")]),
    ).toBe("up");
    // 2 of 4 hits quorum -> down
    expect(
      aggregator.aggregate(unknown, [region("a", "up"), region("b", "up"), region("c", "down"), region("d", "down")]),
    ).toBe("down");
  });

  it("never returns up for an inactive monitor", () => {
    const paused = makeMonitor({ active: false, status: "up" });
    expect(createStatusAggregator("openstatus").aggregate(paused, [region("a", "up")])).toBe("unknown");
  });

  it("supports worst / majority / all / any", () => {
    const regions = [region("a", "up"), region("b", "up"), region("c", "down")];
    expect(createStatusAggregator("worst").aggregate(monitor, regions)).toBe("down");
    expect(createStatusAggregator("majority").aggregate(monitor, regions)).toBe("up");
    expect(createStatusAggregator("all").aggregate(monitor, regions)).toBe("down");
    expect(createStatusAggregator("any").aggregate(monitor, regions)).toBe("up");
    expect(createStatusAggregator("any").aggregate(monitor, [region("a", "down")])).toBe("down");
  });

  it("reports unknown when there is nothing to aggregate and no verdict", () => {
    expect(createStatusAggregator("majority").aggregate(makeMonitor({ status: "unknown" }), [])).toBe("unknown");
  });
});

describe("latency aggregation", () => {
  it("uses the median by default, resistant to one distant probe", () => {
    // A single 400 ms probe from a far-away region should not represent the fleet.
    expect(aggregateLatency([18, 23, 27, 400], "median")).toBe(25);
  });

  it("averages the middle pair for even counts", () => {
    expect(aggregateLatency([10, 20], "median")).toBe(15);
  });

  it("supports the documented alternatives", () => {
    expect(aggregateLatency([10, 20, 30], "mean")).toBe(20);
    expect(aggregateLatency([10, 20, 30], "min")).toBe(10);
    expect(aggregateLatency([10, 20, 30], "max")).toBe(30);
    expect(aggregateLatency([10, 20, 30], "p50")).toBe(20);
  });

  it("returns null when there is no usable latency", () => {
    expect(aggregateLatency([], "median")).toBeNull();
    expect(aggregateLatency([Number.NaN, -5], "median")).toBeNull();
  });
});