// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Thin Alertmanager v2 HTTP client. Mirrors the shape of prometheus-client /
 * loki-client (uses Node 24 native fetch, reads ALERTMANAGER_URL at call
 * time so tests can stub the env without import-order pain).
 *
 * Alertmanager API reference: https://prometheus.io/docs/alerting/latest/clients/
 * — but the v2 OpenAPI is the source of truth:
 * https://github.com/prometheus/alertmanager/blob/main/api/v2/openapi.yaml
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';

const logger = createLogger('alertmanager-client');

/** Default URL when env is unset — matches the in-cluster service name. */
const DEFAULT_URL = 'http://alertmanager:9093';

export type AlertmanagerError =
  | { kind: 'upstream-4xx'; status: number; message: string }
  | { kind: 'unreachable'; message: string };

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

function baseUrl(): string {
  return process.env.ALERTMANAGER_URL || DEFAULT_URL;
}

/** Default timeout for any single Alertmanager call. Tuned to be fast — Alertmanager is
 *  in-cluster, low-latency, and a stalled call shouldn't block the entire request thread.
 *  Override via `ALERTMANAGER_TIMEOUT_MS` for hostile networks / debugging. */
const TIMEOUT_MS = parseInt(process.env.ALERTMANAGER_TIMEOUT_MS || '5000', 10);

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${baseUrl()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (resp.status >= 400 && resp.status < 500) {
      const body = await resp.text().catch(() => '');
      throw { kind: 'upstream-4xx', status: resp.status, message: body || resp.statusText } as AlertmanagerError;
    }
    if (!resp.ok) {
      throw { kind: 'unreachable', message: `Alertmanager returned ${resp.status}` } as AlertmanagerError;
    }
    return await resp.json() as T;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'kind' in err) throw err;
    const message = errorMessage(err);
    logger.warn('Alertmanager request failed', { path, message });
    throw { kind: 'unreachable', message } as AlertmanagerError;
  } finally {
    clearTimeout(timer);
  }
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
  await fetchJson<unknown>(`/api/v2/silence/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
