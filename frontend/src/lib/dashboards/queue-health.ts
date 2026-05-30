// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Queue Health dashboard — deeper view than the Plugin Builds queue panel.
 * Combines wait-time percentiles, DLQ depth, retry rate, and scaling
 * visibility so operators can tell at a glance whether the queue is
 * healthy, congested, or stuck — and whether the autoscaler is reacting.
 */

export type PanelKind = 'line';

export interface QueueHealthPanel {
  id: string;
  kind: PanelKind;
  title: string;
  queryKey: string;
  span: 3 | 4 | 6 | 8 | 9 | 12;
  groupBy?: string;
  format?: 'percent' | 'seconds';
}

export const QUEUE_HEALTH_DASHBOARD: { id: string; title: string; panels: QueueHealthPanel[] } = {
  id: 'queue-health',
  title: 'Queue Health',
  panels: [
    // Wait-time percentiles
    { id: 'wait-p50', kind: 'line', title: 'Job wait p50', queryKey: 'plugin_job_wait_p50', span: 4, format: 'seconds' },
    { id: 'wait-p95', kind: 'line', title: 'Job wait p95', queryKey: 'plugin_job_wait_p95', span: 4, format: 'seconds' },
    { id: 'wait-p99', kind: 'line', title: 'Job wait p99', queryKey: 'plugin_job_wait_p99', span: 4, format: 'seconds' },

    // Queue depth + DLQ
    { id: 'queue-depth', kind: 'line', title: 'Queue depth by state', queryKey: 'plugin_queue_depth', span: 6, groupBy: 'state' },
    { id: 'dlq-size', kind: 'line', title: 'DLQ size by state', queryKey: 'plugin_dlq_size', span: 6, groupBy: 'state' },

    // Failure rate
    { id: 'retry-rate', kind: 'line', title: 'Failure rate (5m)', queryKey: 'plugin_retry_rate', span: 12 },

    // Plugin autoscaling — replica count (outcome) + one panel per trigger
    // input (queue / cpu / memory). Lets operators verify the scaler is
    // reacting and tune the thresholds in plugin.yaml against real signal.
    { id: 'plugin-replicas',     kind: 'line', title: 'Plugin replicas',          queryKey: 'plugin_replicas',                span: 3 },
    { id: 'keda-trigger-queue',  kind: 'line', title: 'KEDA queue trigger',       queryKey: 'plugin_keda_trigger_queue',      span: 3 },
    { id: 'plugin-pod-cpu',      kind: 'line', title: 'Plugin CPU per pod',       queryKey: 'plugin_pod_cpu_seconds_rate',    span: 3, groupBy: 'instance' },
    { id: 'plugin-pod-memory',   kind: 'line', title: 'Plugin memory per pod',    queryKey: 'plugin_pod_memory_bytes',        span: 3, groupBy: 'instance' },
  ],
};
