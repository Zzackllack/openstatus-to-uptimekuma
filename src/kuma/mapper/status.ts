import type { NormalizedStatus } from "../../model/monitor.js";
import {
  KUMA_STATUS_DOWN,
  KUMA_STATUS_MAINTENANCE,
  KUMA_STATUS_PENDING,
  KUMA_STATUS_UP,
  type KumaStatus,
} from "../protocol/version.js";

export type DegradedMapping = "pending" | "up" | "down";

export interface StatusMapper {
  /** Normalized status → Kuma status code. */
  toKuma(status: NormalizedStatus): KumaStatus;
  /**
   * Kuma's `UptimeCalculator.flatStatus()`, reproduced exactly:
   * UP and MAINTENANCE count as uptime, DOWN and PENDING count as downtime.
   * Getting this wrong silently shifts every uptime number, so it lives in one
   * place with a test pinning it.
   */
  toKumaFlat(status: KumaStatus): "UP" | "DOWN";
  /** Normalized "is this a successful check" question, used for latency stats. */
  isUp(status: NormalizedStatus): boolean;
}

export function createStatusMapper(degradedMapping: DegradedMapping): StatusMapper {
  const degradedStatus: KumaStatus =
    degradedMapping === "up"
      ? KUMA_STATUS_UP
      : degradedMapping === "down"
        ? KUMA_STATUS_DOWN
        : KUMA_STATUS_PENDING;

  return {
    toKuma(status: NormalizedStatus): KumaStatus {
      switch (status) {
        case "up":
          return KUMA_STATUS_UP;
        case "down":
          return KUMA_STATUS_DOWN;
        case "degraded":
          return degradedStatus;
        case "maintenance":
          return KUMA_STATUS_MAINTENANCE;
        case "unknown":
          // Kuma has no "no data" state. PENDING renders as a neutral warning and,
          // per flatStatus, counts as downtime — which is what a monitor with no
          // data should cost you.
          return KUMA_STATUS_PENDING;
      }
    },

    toKumaFlat(status: KumaStatus): "UP" | "DOWN" {
      return status === KUMA_STATUS_UP || status === KUMA_STATUS_MAINTENANCE ? "UP" : "DOWN";
    },

    isUp(status: NormalizedStatus): boolean {
      return status === "up" || status === "maintenance";
    },
  };
}