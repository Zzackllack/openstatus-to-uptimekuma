import type { HttpDeps } from "../http/server.js";

/**
 * Prometheus text-format metrics, hand-rolled.
 *
 * A full client library would be a dependency we would use for four counters and
 * a handful of gauges, in a service that is usually a single container. The
 * names follow the `bridge_` prefix from the project brief.
 */
interface Counter {
  name: string;
  help: string;
  type: "counter" | "gauge";
  value: number;
}

const counters = new Map<string, Counter>();

function counter(name: string, help: string): Counter {
  let existing = counters.get(name);
  if (!existing) {
    existing = { name, help, type: "counter", value: 0 };
    counters.set(name, existing);
  }
  return existing;
}

export const metrics = {
  openstatusRequests: () => counter("bridge_openstatus_requests_total", "OpenStatus API calls made"),
  openstatusErrors: () => counter("bridge_openstatus_request_errors_total", "OpenStatus API calls that failed"),
  openstatusDuration: () => counter("bridge_openstatus_request_duration_seconds_total", "Cumulative OpenStatus latency"),
  webhookReceived: () => counter("bridge_webhooks_received_total", "Webhook requests accepted"),
  webhookRejected: () => counter("bridge_webhooks_rejected_total", "Webhook requests rejected"),
  notificationsSent: () => counter("bridge_notifications_sent_total", "State-change events emitted to clients"),
  notificationsFailed: () => counter("bridge_notifications_failed_total", "Emissions that failed"),
  pollDuration: () => counter("bridge_status_poll_duration_seconds_total", "Cumulative reconciliation duration"),
  pollRuns: () => counter("bridge_status_poll_runs_total", "Reconciliation cycles completed"),
};

export function increment(metric: Counter, by = 1): void {
  metric.value += by;
}

export function renderPrometheusMetrics(deps: HttpDeps, backendHealthyFlag: boolean): string {
  const lines: string[] = [];

  const emit = (metric: Counter) => {
    lines.push(`# HELP ${metric.name} ${metric.help}`);
    lines.push(`# TYPE ${metric.name} ${metric.type}`);
    lines.push(`${metric.name} ${metric.value}`);
  };

  for (const metric of counters.values()) emit(metric);

  const gauges: Counter[] = [
    { name: "bridge_monitors", help: "Monitors currently tracked", type: "gauge", value: deps.services.listMonitors().length },
    {
      name: "bridge_socket_connections",
      help: "Socket.IO connections currently open",
      type: "gauge",
      value: deps.runtime.socketCount(),
    },
    {
      name: "bridge_authenticated_socket_connections",
      help: "Authenticated Socket.IO connections currently open",
      type: "gauge",
      value: deps.runtime.authenticatedCount(),
    },
    {
      name: "bridge_openstatus_connected",
      help: "1 when the last OpenStatus health probe succeeded",
      type: "gauge",
      value: backendHealthyFlag ? 1 : 0,
    },
    {
      name: "bridge_state_stale",
      help: "1 when state has not been refreshed within STALE_AFTER_SECONDS",
      type: "gauge",
      value: deps.services.isStale() ? 1 : 0,
    },
  ];

  for (const gauge of gauges) {
    lines.push(`# HELP ${gauge.name} ${gauge.help}`);
    lines.push(`# TYPE ${gauge.name} gauge`);
    lines.push(`${gauge.name} ${gauge.value}`);
  }

  return `${lines.join("\n")}\n`;
}