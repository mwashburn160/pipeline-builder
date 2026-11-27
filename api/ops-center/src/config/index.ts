// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ops-center configuration. Every section here moved out of platform's
 * config with the code that reads it (the observability proxy, alerting,
 * on-call and the storage / Postgres auto-scaling webhooks); the env var names
 * are unchanged, so a deployment only had to MOVE them to this service.
 */

import { envInt } from '@pipeline-builder/api-core';

const DEFAULT_PLATFORM_URL = 'https://localhost:8443';

/** Per-Alertmanager-instance binding for the relay webhook. */
export interface AlertWebhookInstance {
  /** Stable identifier sent by Alertmanager as `X-Alertmanager-Instance`. */
  id: string;
  /** Bearer token this instance must present. */
  token: string;
  /** Rotation only: the outgoing token, still accepted while set. An empty
   *  string (the deploy manifests' default) means "not rotating". */
  previousToken?: string;
  /** When set, every alert in the payload must have its `labels.org_id`
   *  within this list. Missing → no org-scope restriction. */
  allowedOrgIds?: string[];
}

/**
 * Parse the per-instance JSON config from env. Tolerates missing / malformed
 * input: returns [] so the relay returns 503 (Alert relay not configured)
 * at request time rather than crashing the service at startup. Invalid
 * entries log to stderr (no logger available at config-load time).
 */
function parseAlertWebhookInstances(raw: string | undefined): AlertWebhookInstance[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return [];
      const e = entry as Record<string, unknown>;
      if (typeof e.id !== 'string' || !e.id) return [];
      if (typeof e.token !== 'string' || !e.token) return [];
      const inst: AlertWebhookInstance = { id: e.id, token: e.token };
      if (typeof e.previousToken === 'string' && e.previousToken) inst.previousToken = e.previousToken;
      if (Array.isArray(e.allowedOrgIds) && e.allowedOrgIds.every((x) => typeof x === 'string')) {
        inst.allowedOrgIds = e.allowedOrgIds as string[];
      }
      return [inst];
    });
  } catch {
    // Bad JSON: no instances. Service stays up; misconfig is
    // surfaced via the eventual 401/403 on incoming webhook calls.
    return [];
  }
}

export const config = {
  app: {
    /** Links in the emails this service asks platform to send. */
    frontendUrl: process.env.PLATFORM_FRONTEND_URL || DEFAULT_PLATFORM_URL,
  },

  rateLimit: {
    /** Per-org general bucket for the tenant surfaces (`/dashboards`, `/observability`). */
    max: envInt('LIMITER_MAX', 100),
    windowMs: envInt('LIMITER_WINDOW_MS', 900000), // 15 min
    // Observability endpoints (catalog query, range query, log query) hit
    // Prometheus / Loki directly. A noisy operator clicking through panels
    // can saturate upstream — keep a tighter per-org budget than the
    // general limiter. A single dashboard view fans out to one query per
    // panel (Queue Health = 9, Registry Activity = 6, …) and the client may
    // refetch on mount, so the budget must cover a couple of full page
    // loads in a window or legitimate views 429. 120 req / min default.
    observability: {
      max: envInt('OBSERVABILITY_LIMITER_MAX', 120),
      windowMs: envInt('OBSERVABILITY_LIMITER_WINDOW_MS', 60000), // 1 min
    },
    /**
     * Dedicated bucket for the Alertmanager relay webhook.
     *
     * This endpoint is machine-to-machine and unauthenticated at middleware
     * time (it authenticates itself inside the handler with a per-instance
     * bearer + `X-Alertmanager-Instance` allowlist), so the general limiter
     * would put it in the ANONYMOUS bucket — fleet-wide, shared with every
     * other unauthenticated caller. A multi-group alert storm would exhaust
     * that and get 429s, which Alertmanager treats as a failed notification:
     * alerts silently delayed to the next `group_interval`.
     *
     * Sized for a fleet of Alertmanagers fanning out many groups at once,
     * which is exactly when throttling is most harmful.
     */
    alertWebhook: {
      max: envInt('ALERT_WEBHOOK_LIMITER_MAX', 3000),
      windowMs: envInt('ALERT_WEBHOOK_LIMITER_WINDOW_MS', 60000), // 1 min
    },
  },
  alertWebhook: {
    instances: parseAlertWebhookInstances(process.env.ALERT_WEBHOOK_INSTANCES),
  },
  pvcAutoExpand: {
    enabled: process.env.PVC_AUTOEXPAND_ENABLED === 'true',
    // Expressed as whole numbers because the only env helper here is envInt,
    // and "grow by 50%, never past 4x" reads better than two float factors.
    stepFactor: 1 + envInt('PVC_AUTOEXPAND_STEP_PERCENT', 50) / 100,
    ceilingFactor: envInt('PVC_AUTOEXPAND_CEILING_MULTIPLE', 4),
    maxGi: envInt('PVC_AUTOEXPAND_MAX_GI', 500),
    cooldownSeconds: envInt('PVC_AUTOEXPAND_COOLDOWN_SECONDS', 6 * 60 * 60),
    // Where the StatefulSets whose claims it grows live, for the drift sweep.
    namespace: process.env.PVC_AUTOEXPAND_NAMESPACE || 'pipeline-builder',
    // How often pvc_autoexpand_template_drift is recomputed from the cluster.
    driftSweepIntervalMs: envInt('PVC_AUTOEXPAND_DRIFT_INTERVAL_MS', 10 * 60 * 1000),
  },
  postgresRung: {
    enabled: process.env.POSTGRES_RUNG_ENABLED === 'true',
    namespace: process.env.POSTGRES_RUNG_NAMESPACE || 'pipeline-builder',
    // Long by default: the change restarts a database, and Alertmanager
    // re-sends on its repeat_interval. Without a cooldown a saturated primary
    // would be restarted on every re-send.
    cooldownSeconds: envInt('POSTGRES_RUNG_COOLDOWN_SECONDS', 30 * 60),
    // Top rung index (0-based) this deployment may reach. 2 = the ceiling,
    // which is EXACTLY the namespace LimitRange's container max of 4 CPU —
    // raising it past that means raising the LimitRange first or the pod cannot
    // be created at all. Lower it to pin a deployment below the ceiling.
    maxRung: envInt('POSTGRES_RUNG_MAX', 2),
    // Standby ceiling, deliberately BELOW the primary's: rung 1 = 2000m/4Gi, so
    // 2 CPU per read replica. The replica count multiplies it, so at
    // PG_READ_REPLICA_MAX=2 the read tier tops out at 4 CPU instead of the 8 the
    // primary's ceiling would permit. The primary is held to this on the way up
    // too, so a standby can always match it and stay promotable.
    maxRungReplica: envInt('POSTGRES_RUNG_MAX_REPLICA', 1),
    // The standby replica ceiling, so a standby only scales UP once KEDA has
    // run out of room: out before up. Mirrors PG_READ_REPLICA_MAX.
    replicaMax: envInt('PG_READ_REPLICA_MAX', 1),
  },
  nodeDiskAutoExpand: {
    enabled: process.env.NODE_DISK_AUTOEXPAND_ENABLED === 'true',
    resizeDocument: process.env.NODE_DISK_AUTOEXPAND_SSM_DOCUMENT || 'pipeline-builder-resize-data-fs',
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
    stepFactor: 1 + envInt('NODE_DISK_AUTOEXPAND_STEP_PERCENT', 50) / 100,
    ceilingFactor: envInt('NODE_DISK_AUTOEXPAND_CEILING_MULTIPLE', 4),
    maxGi: envInt('NODE_DISK_AUTOEXPAND_MAX_GI', 2000),
    cooldownSeconds: envInt('NODE_DISK_AUTOEXPAND_COOLDOWN_SECONDS', 6 * 60 * 60),
  },
  observability: {
    /** Backend base URLs, read on access (not at load) so a test can point one
     *  backend at a stub per case. Defaults are the in-cluster service names. */
    get prometheusUrl(): string { return process.env.PROMETHEUS_URL || 'http://prometheus:9090'; },
    get lokiUrl(): string { return process.env.LOKI_URL || 'http://loki:3100'; },
    get alertmanagerUrl(): string { return process.env.ALERTMANAGER_URL || 'http://alertmanager:9093'; },
    /**
     * The always-present anchor matcher for every LogQL selector. A selector
     * needs at least one non-empty matcher, and which labels exist varies by
     * deploy target; `service_name` is set by the shared JSON stage on every
     * target, so it is the portable default. Override for a deploy that ships
     * non-JSON producers people need to browse.
     */
    get lokiBaseSelector(): string { return process.env.LOKI_BASE_SELECTOR || 'service_name=~".+"'; },
    /** Default timeout for any single Alertmanager call. */
    alertmanagerTimeoutMs: envInt('ALERTMANAGER_TIMEOUT_MS', 5000),
    /** Per-destination delivery timeout for the alert relay and test sends — a
     *  slow Slack tenant shouldn't hold up the relay (Alertmanager retries). */
    alertDeliveryTimeoutMs: envInt('ALERT_DELIVERY_TIMEOUT_MS', 5000),
    /** At-least-once dedupe window for alert email: an identical (alert,
     *  recipient) email inside it is suppressed. */
    alertEmailDedupeTtlMs: envInt('ALERT_EMAIL_DEDUPE_TTL_MS', 10 * 60 * 1000),
    /** Alert destination field caps. Slack hooks are ~85 chars, but enterprise
     *  webhooks with long signed query params can be much longer. */
    alertDestinationMaxLabel: envInt('ALERT_DESTINATION_MAX_LABEL', 100),
    alertDestinationMaxTarget: envInt('ALERT_DESTINATION_MAX_TARGET', 2048),
    /** Custom dashboard size caps (defend against pathological payloads). */
    dashboardMaxName: envInt('DASHBOARD_MAX_NAME', 150),
    dashboardMaxDescription: envInt('DASHBOARD_MAX_DESCRIPTION', 1000),
    dashboardMaxPanelTitle: envInt('DASHBOARD_MAX_PANEL_TITLE', 200),
    dashboardMaxPanels: envInt('DASHBOARD_MAX_PANELS', 50),
    /**
     * How far back a log query may reach, in hours: Loki's own retention, read
     * from the SAME variable `loki-config.yml` expands into `retention_period`.
     * A deploy contract asserts the two defaults match, so the name and the
     * 720 h default must not change here alone.
     */
    logRetentionHours: envInt('LOG_RETENTION_HOURS', 720, { min: 1 }),
  },
  oncall: {
    // How often the rota-coverage gauge is refreshed. 15 minutes: the question
    // is "is anyone scheduled over the next two days", which cannot change
    // faster than a human edits a schedule, and the API it reads is
    // rate-limited and billed per-seat rather than per-call.
    rotaIntervalMs: envInt('ONCALL_ROTA_INTERVAL_MS', 900_000, { min: 60_000 }),
  },
};

export type Config = typeof config;
