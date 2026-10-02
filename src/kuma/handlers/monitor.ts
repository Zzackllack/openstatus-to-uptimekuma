import type { Socket } from "socket.io";

import type { NormalizedMonitor } from "../../model/monitor.js";
import type { BridgeServices } from "../../service/bridge-services.js";
import type { Broadcaster } from "../broadcaster.js";
import { toKumaMonitor, toKumaMonitorList } from "../mapper/monitor.js";

type Ack = (response: unknown) => void;
export type RequireAuth = (callback: unknown) => boolean;

export function ok(data?: unknown): unknown {
  return data === undefined ? { ok: true } : { ok: true, data };
}

export function failure(msg: string): unknown {
  return { ok: false, msg };
}

export function resolveMonitor(
  services: BridgeServices,
  rawId: unknown,
): { monitor: NormalizedMonitor } | { error: unknown } {
  // Kuma's own frontend passes ids from `Object.keys()`, i.e. **strings**, in
  // several places (`MonitorList.vue:450`). Accept both rather than making
  // clients do the conversion.
  const kumaId = typeof rawId === "number" ? rawId : Number.parseInt(String(rawId), 10);
  if (!Number.isInteger(kumaId)) return { error: failure("Invalid monitor ID") };

  const monitor = services.getMonitorByKumaId(kumaId);
  if (!monitor) return { error: failure("Monitor not found") };
  return { monitor };
}

export function registerMonitorHandlers(
  socket: Socket,
  services: BridgeServices,
  broadcaster: Broadcaster,
  requireAuth: RequireAuth,
): void {
  socket.on("getMonitor", (rawId: unknown, callback?: Ack) => {
    if (!requireAuth(callback)) return;
    const result = resolveMonitor(services, rawId);
    if ("error" in result) {
      callback?.(result.error);
      return;
    }
    callback?.({ ok: true, monitor: toKumaMonitor(result.monitor) });
  });

  socket.on("getMonitorList", (callback?: Ack) => {
    if (!requireAuth(callback)) return;
    callback?.({ ok: true, monitorList: toKumaMonitorList(services.listMonitors()) });
  });

  socket.on("pauseMonitor", (rawId: unknown, callback?: Ack) => {
    if (!requireAuth(callback)) return;
    const result = resolveMonitor(services, rawId);
    if ("error" in result) {
      callback?.(result.error);
      return;
    }
    void setActive(socket, services, broadcaster, result.monitor, false, callback);
  });

  socket.on("resumeMonitor", (rawId: unknown, callback?: Ack) => {
    if (!requireAuth(callback)) return;
    const result = resolveMonitor(services, rawId);
    if ("error" in result) {
      callback?.(result.error);
      return;
    }
    void setActive(socket, services, broadcaster, result.monitor, true, callback);
  });

  socket.on("clearEvents", (rawId: unknown, callback?: Ack) => {
    if (!requireAuth(callback)) return;
    const result = resolveMonitor(services, rawId);
    if ("error" in result) {
      callback?.(result.error);
      return;
    }
    // Kuma deletes heartbeat rows here. Our history comes from OpenStatus, so
    // there is nothing local to clear — but the ack must be honest about having
    // resolved the monitor, and we do not pretend history was deleted.
    callback?.(ok());
  });
}

async function setActive(
  socket: Socket,
  services: BridgeServices,
  broadcaster: Broadcaster,
  monitor: NormalizedMonitor,
  active: boolean,
  callback?: Ack,
): Promise<void> {
  try {
    const updated = await services.backend.setActive(monitor.openStatusId, active);
    if (!updated) {
      callback?.(failure("Monitor not found"));
      return;
    }

    // Push the update before acking so a client that refreshes on ack already
    // sees the new state.
    broadcaster.updateMonitorIntoList(socket, toKumaMonitor({ ...updated, kumaId: monitor.kumaId }));
    callback?.(ok());
  } catch (error) {
    callback?.(failure(error instanceof Error ? error.message : "Failed to update monitor"));
  }
}