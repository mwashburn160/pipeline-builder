// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-user monitoring ingest: `POST /observability/client-vitals`.
 *
 * The frontend's telemetry module (frontend/src/lib/telemetry/web-vitals.ts)
 * batches two kinds of sample and posts them here:
 *
 *  - a WEB VITAL (LCP, INP, CLS, FCP, TTFB) for the page load, with the rating
 *    the `web-vitals` library assigned it, recorded on the histogram
 *    `frontend_web_vitals{metric,route,rating}` — seconds for the four timing
 *    metrics, unitless for CLS (the buckets carry both thresholds, see
 *    HISTOGRAM_BUCKETS in api-server's metrics.ts);
 *  - an ERROR-BOUNDARY CATCH, counted on
 *    `frontend_error_boundary_caught_total{boundary,route}`.
 *
 * LABEL CARDINALITY IS THE WHOLE DESIGN. A browser can send anything, so every
 * label is from a closed set: the metric, rating and boundary are enums, and
 * the route is the Next.js route PATTERN (`/dashboard/pipelines/[id]`, never a
 * concrete path) checked against the frontend's known pages — anything else is
 * folded into `other`, so a skewed or hostile client adds at most one series.
 * Nothing identifying is stored: the schema is strict, so a sample carrying a
 * user id, URL or query string is refused outright rather than silently
 * dropped, and the handler never reads `req.user` beyond the auth gate.
 */

import type { Request, Response } from 'express';
import { z } from 'zod';
import { incCounter, observe } from './metrics.js';
import { validateBody } from '../utils/validation.js';

/**
 * Every page pattern the frontend serves (`router.pathname`), plus Next's own
 * error routes. Drift-tested against `frontend/pages` (test/client-vitals.test.ts),
 * so a new page fails CI here until it is listed.
 */
export const FRONTEND_ROUTE_PATTERNS = [
  '/',
  '/404',
  '/_error',
  '/auth/callback/[provider]',
  '/auth/device',
  '/auth/forgot-password',
  '/auth/register',
  '/auth/reset-password',
  '/auth/sso/[orgId]/callback',
  '/auth/sso/[orgId]/saml',
  '/auth/verify-email',
  '/dashboard',
  '/dashboard/admin/billing',
  '/dashboard/admin/cascade',
  '/dashboard/admin/ecosystem',
  '/dashboard/admin/offers',
  '/dashboard/admin/orgs/[orgId]',
  '/dashboard/admin/runner-signing-keys',
  '/dashboard/admin/settings',
  '/dashboard/admin/support',
  '/dashboard/api-catalog',
  '/dashboard/audit',
  '/dashboard/build-queue',
  '/dashboard/campaigns',
  '/dashboard/compliance',
  '/dashboard/deployments',
  '/dashboard/discounts',
  '/dashboard/downloads',
  '/dashboard/executions',
  '/dashboard/help',
  '/dashboard/inbox',
  '/dashboard/logs',
  '/dashboard/members',
  '/dashboard/my-services',
  '/dashboard/notifications',
  '/dashboard/observability',
  '/dashboard/observability/[id]',
  '/dashboard/observability/[id]/edit',
  '/dashboard/observability/alert-destinations',
  '/dashboard/observability/alert-rules',
  '/dashboard/observability/alerts',
  '/dashboard/observability/audit-activity',
  '/dashboard/observability/new',
  '/dashboard/onboarding',
  '/dashboard/organizations',
  '/dashboard/pipelines',
  '/dashboard/pipelines/[id]',
  '/dashboard/plugins',
  '/dashboard/promotions',
  '/dashboard/publisher',
  '/dashboard/registry',
  '/dashboard/reports',
  '/dashboard/security',
  '/dashboard/settings',
  '/dashboard/settings/incident-reporting',
  '/dashboard/settings/sso',
  '/dashboard/support',
  '/dashboard/templates',
  '/dashboard/toolchain',
  '/dashboard/triage',
  '/dashboard/usage',
  '/dashboard/users',
  '/invite/accept',
  '/login',
  '/marketplace/register',
  '/notifications/confirm',
  '/plugins',
  '/plugins/[publisher]/[name]',
  '/plugins/category/[category]',
  '/plugins/submit',
  '/plugins/submit/status',
  '/plugins/submit/verify',
  '/privacy',
  '/reports/confirm',
  '/reports/shared',
  '/reports/unsubscribe',
] as const;

/** The label every route outside {@link FRONTEND_ROUTE_PATTERNS} is recorded under. */
export const OTHER_ROUTE = 'other';

/** The Core Web Vitals plus FCP and TTFB — the metrics `web-vitals` reports. */
export const CLIENT_VITAL_METRICS = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'] as const;
/** The `web-vitals` rating vocabulary. */
export const VITAL_RATINGS = ['good', 'needs-improvement', 'poor'] as const;
/** Where in the UI an error boundary sits (frontend ErrorBoundary `boundary` prop). */
export const ERROR_BOUNDARIES = ['app', 'page', 'ask-panel', 'chart'] as const;

/** At most this many samples per POST (the client flushes well below it). */
export const MAX_SAMPLES_PER_BATCH = 50;
/** Timing metrics arrive in milliseconds; two minutes is past any real page load. */
const MAX_TIMING_MS = 120_000;
/** CLS is a unitless score; real pages sit well under 1, a broken one a few. */
const MAX_CLS = 10;

const KNOWN_ROUTES: ReadonlySet<string> = new Set(FRONTEND_ROUTE_PATTERNS);

/**
 * A route PATTERN: a path of segments and `[param]` placeholders. Refuses a
 * query string, a fragment or an origin, so a concrete URL cannot be sent as a
 * "route" and land in a log line.
 */
const routeSchema = z.string().max(200).regex(/^\/[A-Za-z0-9_.\-[\]/]*$/, 'must be a route pattern');

const vitalSampleSchema = z.object({
  kind: z.literal('vital'),
  metric: z.enum(CLIENT_VITAL_METRICS),
  value: z.number().finite().min(0),
  rating: z.enum(VITAL_RATINGS),
  route: routeSchema,
}).strict();

const errorSampleSchema = z.object({
  kind: z.literal('error'),
  boundary: z.enum(ERROR_BOUNDARIES),
  route: routeSchema,
}).strict();

const sampleSchema = z.discriminatedUnion('kind', [vitalSampleSchema, errorSampleSchema]).superRefine((s, ctx) => {
  if (s.kind !== 'vital') return;
  const max = s.metric === 'CLS' ? MAX_CLS : MAX_TIMING_MS;
  if (s.value > max) ctx.addIssue({ code: 'custom', path: ['value'], message: `must be at most ${max} for ${s.metric}` });
});

/** The request body. Strict at every level: nothing but the samples. */
export const clientVitalsSchema = z.object({
  samples: z.array(sampleSchema).min(1).max(MAX_SAMPLES_PER_BATCH),
}).strict();

export type ClientVitalsBody = z.infer<typeof clientVitalsSchema>;

/** The `route` label for a reported pattern: itself when the frontend serves it, else `other`. */
export function routeLabel(route: string): string {
  return KNOWN_ROUTES.has(route) ? route : OTHER_ROUTE;
}

/** Record one validated batch on the two metrics. */
export function recordClientTelemetry(body: ClientVitalsBody): void {
  for (const s of body.samples) {
    const route = routeLabel(s.route);
    if (s.kind === 'vital') {
      const value = s.metric === 'CLS' ? s.value : s.value / 1000;
      observe('frontend_web_vitals', { metric: s.metric, route, rating: s.rating }, value);
    } else {
      incCounter('frontend_error_boundary_caught_total', { boundary: s.boundary, route });
    }
  }
}

/** `POST /observability/client-vitals` — validate, record, 204. Persists nothing else. */
export async function clientVitals(req: Request, res: Response): Promise<void> {
  const body = validateBody(clientVitalsSchema, req.body, res);
  if (!body) return;
  recordClientTelemetry(body);
  res.status(204).end();
}
