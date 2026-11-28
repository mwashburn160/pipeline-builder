// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-user monitoring: web vitals and error-boundary catches, batched to
 * ops-center's `POST /api/observability/client-vitals` (sent by the api
 * client's `sendClientTelemetry`), which records them on
 * `frontend_web_vitals{metric,route,rating}` and
 * `frontend_error_boundary_caught_total{boundary,route}` (Prometheus).
 *
 * LABELS ARE ROUTE PATTERNS. Every sample carries the Next.js `router.pathname`
 * (`/dashboard/pipelines/[id]`) — never `asPath`, an id or a query string —
 * plus a closed-set metric/rating or boundary name. That keeps the series
 * count bounded and keeps tokens in invite / OAuth URLs out of the metrics.
 * The server re-checks all of it (strict schema, known-route allow-list).
 *
 * Vitals describe the page LOAD, so they are labelled with the route the
 * document loaded on (`initWebVitals(route)`): `web-vitals` measures that load,
 * and CLS/INP keep accumulating on it until the page is hidden.
 *
 * Batches go out when full or when the page is hidden (the last moment a page
 * is reliably alive, and when CLS/INP report their final value). With no
 * session the endpoint would refuse them, so they are held — a login page's
 * vitals go out once the person signs in — and dropped if the page goes away
 * first. Reporting never throws into the app.
 */

import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from 'web-vitals';

/** Samples per request; a full batch is sent at once (the server caps at 50). */
export const MAX_BATCH = 20;

/**
 * Where an error boundary sits — the server's allow-list (`ERROR_BOUNDARIES`):
 * `app` the last-resort root in _app, `page` a dashboard page's content,
 * `ask-panel` the Ask drawer, `chart` one chart or observability panel.
 */
export type ErrorBoundaryName = 'app' | 'page' | 'ask-panel' | 'chart';
type VitalName = 'LCP' | 'INP' | 'CLS' | 'FCP' | 'TTFB';

export type TelemetrySample =
  | { kind: 'vital'; metric: VitalName; value: number; rating: Metric['rating']; route: string }
  | { kind: 'error'; boundary: ErrorBoundaryName; route: string };

export interface TelemetryOptions {
  /** Send one batch (`api.sendClientTelemetry`); `false` when there is no session to send under. */
  send: (samples: readonly TelemetrySample[]) => boolean;
}

let options: TelemetryOptions | null = null;
let vitalsStarted = false;
let lifecycleBound = false;
let queue: TelemetrySample[] = [];

/** Point the module at its transport. Called by {@link initWebVitals}; safe to call again. */
export function configureTelemetry(opts: TelemetryOptions): void {
  options = opts;
  bindLifecycle();
}

function bindLifecycle(): void {
  if (lifecycleBound || typeof document === 'undefined') return;
  lifecycleBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushTelemetry({ dropIfUnsent: true });
  });
  // Safari does not always fire visibilitychange on unload; pagehide covers it.
  window.addEventListener('pagehide', () => flushTelemetry({ dropIfUnsent: true }));
}

function enqueue(sample: TelemetrySample): void {
  queue.push(sample);
  // Never grow without bound while signed out: keep the newest full batch.
  if (queue.length > MAX_BATCH) queue = queue.slice(-MAX_BATCH);
  if (queue.length >= MAX_BATCH) flushTelemetry();
}

/**
 * Send whatever is queued. Without a session the queue is kept — unless
 * `dropIfUnsent`, used when the page is going away and there is no later chance.
 */
export function flushTelemetry({ dropIfUnsent = false }: { dropIfUnsent?: boolean } = {}): void {
  if (queue.length === 0) return;
  let sent = false;
  try {
    sent = options?.send(queue) ?? false;
  } catch {
    sent = true; // a transport that threw has had its chance; do not resend
  }
  if (sent || dropIfUnsent) queue = [];
}

/**
 * Start reporting LCP, INP, CLS, FCP and TTFB for this page load, labelled with
 * `route` — the Next.js route pattern the document loaded on. Once per page
 * load; later calls only refresh the transport.
 */
export function initWebVitals(route: string, opts: TelemetryOptions): void {
  configureTelemetry(opts);
  if (vitalsStarted || typeof window === 'undefined') return;
  vitalsStarted = true;
  const report = (m: Metric) => enqueue({ kind: 'vital', metric: m.name as VitalName, value: m.value, rating: m.rating, route });
  onLCP(report);
  onINP(report);
  onCLS(report);
  onFCP(report);
  onTTFB(report);
}

/** Count one error caught by an {@link ErrorBoundaryName} boundary on `route` (a route pattern). */
export function reportBoundaryError(boundary: ErrorBoundaryName, route: string): void {
  try {
    enqueue({ kind: 'error', boundary, route });
  } catch {
    // Reporting must never throw from inside an error boundary.
  }
}

/** Test seam: forget all module state. */
export function __resetTelemetryForTests(): void {
  options = null;
  vitalsStarted = false;
  queue = [];
}
