import { describe, expect, it } from "vitest";

import { parseHostPort, periodicityToSeconds, toKumaMonitor, toKumaMonitorList } from "../../src/kuma/mapper/monitor.js";
import { makeMonitor } from "../helpers/fake-openstatus.js";

describe("monitor type translation", () => {
  it("maps HTTP monitors onto Kuma's `http` type", () => {
    const monitor = makeMonitor({ kind: "http", target: { url: "https://example.com/health" }, method: "POST", kumaId: 1 });
    const kuma = toKumaMonitor(monitor);
    expect(kuma.type).toBe("http");
    expect(kuma.url).toBe("https://example.com/health");
    expect(kuma.method).toBe("POST");
  });

  it("maps TCP monitors onto Kuma's `port` type with host/port split out", () => {
    const monitor = makeMonitor({
      kind: "tcp",
      target: { hostname: "db.example.com", port: 5432 },
      kumaId: 2,
    });
    const kuma = toKumaMonitor(monitor);
    expect(kuma.type).toBe("port");
    expect(kuma.hostname).toBe("db.example.com");
    expect(kuma.port).toBe("5432");
  });

  it("maps DNS monitors onto Kuma's `dns` type", () => {
    const monitor = makeMonitor({ kind: "dns", target: { dnsName: "example.com" }, kumaId: 3 });
    const kuma = toKumaMonitor(monitor);
    expect(kuma.type).toBe("dns");
    expect(kuma.hostname).toBe("example.com");
    expect(kuma.dns_resolve_type).toBe("A");
  });

  it("carries every field the official frontend dereferences unguarded", () => {
    // MonitorListItem.beforeMount calls monitor.childrenIDs.includes(...) and the
    // template calls monitor.tags.length — a missing key crashes the dashboard.
    const kuma = toKumaMonitor(makeMonitor({ kumaId: 7 }));
    expect(Array.isArray(kuma.tags)).toBe(true);
    expect(Array.isArray(kuma.childrenIDs)).toBe(true);
    expect(kuma.parent).toBeNull();
    expect(typeof kuma.notificationIDList).toBe("object");
    expect(typeof kuma.weight).toBe("number");
    expect(typeof kuma.active).toBe("boolean");
    expect(typeof kuma.interval).toBe("number");
  });

  it("never leaks OpenStatus monitor secrets into the Kuma payload", () => {
    const kuma = toKumaMonitor(makeMonitor({ kumaId: 9 }));
    expect(Object.keys(kuma)).not.toContain("headers");
    expect(Object.keys(kuma)).not.toContain("body");
    expect(Object.keys(kuma)).not.toContain("basic_auth_pass");
  });

  it("preserves paused monitors as inactive", () => {
    expect(toKumaMonitor(makeMonitor({ active: false })).active).toBe(false);
  });

  it("keys the monitor list by synthetic id and matches the embedded id", () => {
    const list = toKumaMonitorList([makeMonitor({ kumaId: 1 }), makeMonitor({ kumaId: 12 })]);
    expect(Object.keys(list).sort()).toEqual(["1", "12"]);
    expect(list["12"]?.id).toBe(12);
  });
});

describe("periodicity", () => {
  it("maps OpenStatus periodicity to Kuma interval seconds", () => {
    expect(periodicityToSeconds("30s")).toBe(30);
    expect(periodicityToSeconds("1m")).toBe(60);
    expect(periodicityToSeconds("5m")).toBe(300);
    expect(periodicityToSeconds("10m")).toBe(600);
    expect(periodicityToSeconds("30m")).toBe(1800);
    expect(periodicityToSeconds("1h")).toBe(3600);
    // `other` is not representable over the RPC enum; 10m is Kuma's own default.
    expect(periodicityToSeconds("other")).toBe(600);
    expect(periodicityToSeconds(undefined)).toBe(600);
  });
});

describe("parseHostPort", () => {
  it("parses the uri forms OpenStatus uses", () => {
    expect(parseHostPort("tcp://db.example.com:5432")).toEqual({ hostname: "db.example.com", port: 5432 });
    expect(parseHostPort("db.example.com:5432")).toEqual({ hostname: "db.example.com", port: 5432 });
    expect(parseHostPort("example.com:443")).toEqual({ hostname: "example.com", port: 443 });
  });

  it("returns null rather than guessing on malformed input", () => {
    expect(parseHostPort("example.com")).toBeNull();
    expect(parseHostPort("example.com:notaport")).toBeNull();
    expect(parseHostPort("example.com:99999")).toBeNull();
    expect(parseHostPort("")).toBeNull();
    expect(parseHostPort(undefined)).toBeNull();
  });
});