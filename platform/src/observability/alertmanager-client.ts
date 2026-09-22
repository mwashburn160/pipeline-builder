// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Thin Alertmanager v2 HTTP client over {@link callUpstream}, like
 * prometheus-client (base URL read per call from `config.observability`).
 *
 * Alertmanager API reference: https://prometheus.io/docs/alerting/latest/clients/
 * — but the v2 OpenAPI is the source of truth:
 * https://github.com/prometheus/alertmanager/blob/main/api/v2/openapi.yaml
 */

import { callUpstream } from './upstream.js';
import { config } from '../config/index.js';

/** A single firing or resolved alert as returned by Alertmanager v2. */
export interface Alert {
  /** Stable fingerprint Alertmanager assigns to (labels+annotations). Use as React key. */
  fingerprint: string;
  /** "active" (firing), "suppressed" (silenced/inhibited), "unprocessed" (just received). */
  status: { state: 'active' | 'suppressed' | 'unprocessed'; silencedBy?: string[]; inhibitedBy?: string[] };
  /** Label key/value pairs from the alert rule + service. `severity`, `alertname`, `component` are conventional. */
  labels: Record<string, string>;
  /** Annotations carry the human-readable `summary` and `description` from alert-rules.yml. */
  annotations: Record<string, string>;
  /** ISO timestamp the alert first fired. */
  startsAt: string;
  /** ISO timestamp Alertmanager will consider it resolved if no further updates arrive. */
  endsAt: string;
  /** ISO timestamp of the last update. */
  updatedAt: string;
  generatorURL?: string;
}

/** Active silence rule — matchers suppress alerts that match all of them. */
export interface Silence {
  id: string;
  status: { state: 'active' | 'expired' | 'pending' };
  matchers: Array<{ name: string; value: string; isRegex: boolean; isEqual: boolean }>;
  startsAt: string;
  endsAt: string;
  createdBy: string;
  comment: string;
}

export interface SilenceCreate {
  matchers: Array<{ name: string; value: string; isRegex?: boolean; isEqual?: boolean }>;
  startsAt: string;
  endsAt: string;
  createdBy: string;
  comment: string;
}

async function fetchJson<T>(path: string, init: { method?: string; body?: string } = {}, parse: 'json' | 'none' = 'json'): Promise<T> {
  return callUpstream<T>(`${config.observability.alertmanagerUrl}${path}`, {
    backend: 'Alertmanager',
    // In-cluster and low-latency: a stalled call must not hold the request.
    timeoutMs: config.observability.alertmanagerTimeoutMs,
    method: init.method,
    body: init.body,
    headers: { 'Content-Type': 'application/json' },
    parse,
    logContext: { path },
  });
}

/** List active + suppressed alerts. Optionally filter to a single org via `org_id` label. */
export async function listAlerts(orgId?: string): Promise<Alert[]> {
  // Alertmanager's filter param is `filter=label=value` (repeatable). When orgId is
  // given we constrain on the `org_id` label; sysadmin path passes orgId=undefined
  // and gets everything.
  let path = '/api/v2/alerts?active=true&silenced=true&inhibited=true';
  if (orgId) path += `&filter=${encodeURIComponent(`org_id="${orgId}"`)}`;
  return fetchJson<Alert[]>(path);
}

/** List active silences (also returns expired/pending so the UI can show recent ones). */
export async function listSilences(): Promise<Silence[]> {
  return fetchJson<Silence[]>('/api/v2/silences');
}

/** Create a silence; Alertmanager returns `{ silenceID: string }`. */
export async function createSilence(body: SilenceCreate): Promise<{ silenceID: string }> {
  return fetchJson<{ silenceID: string }>('/api/v2/silences', {
    method: 'POST',
    body: JSON.stringify({
      ...body,
      matchers: body.matchers.map(m => ({ isRegex: false, isEqual: true, ...m })),
    }),
  });
}

/** Delete (expire) a silence by ID. Alertmanager returns 200 with no body on success. */
export async function deleteSilence(id: string): Promise<void> {
  await fetchJson<void>(`/api/v2/silence/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'none');
}
