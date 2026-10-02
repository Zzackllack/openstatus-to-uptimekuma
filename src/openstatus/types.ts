import { z } from "zod";

import type { NormalizedMonitor, NormalizedRegionalResult, NormalizedSummary } from "../model/monitor.js";

/**
 * The boundary between the bridge and OpenStatus.
 *
 * Everything upstream of this interface speaks normalized types; everything
 * downstream of it is SDK-shaped. Tests substitute `FakeBackend`, which is why no
 * test in this repo needs network access.
 */
export interface OpenStatusBackend {
  listMonitors(): Promise<NormalizedMonitor[]>;
  getMonitor(id: string): Promise<NormalizedMonitor | null>;
  /** Raw per-region rows. Does NOT include private locations. */
  getMonitorStatus(id: string): Promise<NormalizedRegionalResult[]>;
  getMonitorSummary(id: string, timeRangeHours: number): Promise<NormalizedSummary | null>;
  /**
   * Real response logs. **HTTP monitors only** — OpenStatus' `listResponseLogs`
   * hard-rejects other job types, so this returns an empty array for TCP/DNS
   * rather than pretending otherwise.
   */
  getMonitorHistory(id: string, from: Date, to: Date, limit: number): Promise<RawResponseLog[]>;
  setActive(id: string, active: boolean): Promise<NormalizedMonitor | null>;
  trigger(id: string): Promise<void>;
  /** Cheap liveness probe. Must not throw; returns false when unreachable. */
  checkHealth(): Promise<boolean>;
}

export interface RawResponseLog {
  /** OpenStatus response-log id. */
  id: string | null;
  /** Unix ms of the scheduled check slot. This is the logical-run key. */
  cronTimestamp: number;
  /** Unix ms of when the response actually landed. */
  timestamp: number;
  latencyMs: number;
  statusCode: number | null;
  region: string;
  /** "success" | "error" | "degraded" */
  requestStatus: string;
}

/** OpenStatus webhook body. See docs/protocol-research.md §5. */
export const openstatusWebhookSchema = z.object({
  monitor: z.object({
    // The webhook sends a *number* here while the RPC layer uses strings.
    // Self-hosted and managed versions have been seen disagreeing, so accept both.
    id: z.union([z.string(), z.number()]).transform(String),
    name: z.string().optional(),
    url: z.string().optional(),
  }),
  cronTimestamp: z.number(),
  status: z.enum(["error", "recovered", "degraded"]),
  statusCode: z.number().optional(),
  latency: z.number().optional(),
  errorMessage: z.string().optional(),
});

export type OpenStatusWebhookPayload = z.infer<typeof openstatusWebhookSchema>;