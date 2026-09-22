// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Permission + audit coverage for every route this service serves.
 *
 * Builds the REAL route table from `src/app-routes.ts` (the same mount code
 * `index.ts` runs) and fails when a write route has no permission gate or no
 * declared audit action, or a read route has no permission gate. Exceptions are
 * explicit and carry a reason; a stale one fails the test too.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from '@jest/globals';
import { buildRouteTable, REMOTE_AUDIT_ACTIONS, type RouteTableEntry } from '@pipeline-builder/api-core';
import {
  INFRA_ROUTE_EXCEPTIONS,
  compareRouteTableSnapshot,
  declaredAuditActions,
  findInternalRouteViolations,
  findRouteCoverageViolations,
  type InternalRouteDeclaration,
  type RouteCoverageException,
} from '@pipeline-builder/api-core/testing';

process.env.JWT_SECRET ||= 'route-coverage-test-secret';

const here = dirname(fileURLToPath(import.meta.url));
const snapshotFile = resolve(here, '../../../frontend/src/generated/route-table/reporting.json');

/** Routes that legitimately can't satisfy a rule, each with its reason. */
const EXCEPTIONS: RouteCoverageException[] = [
  ...INFRA_ROUTE_EXCEPTIONS,
  // ── Machine ingest: authorized by the `reporting:ingest` TOKEN SCOPE ────────
  // Not a user permission — the credentials are the AWS event-forwarder Lambda
  // and the customer's incident tool, which hold no org-user capabilities. The
  // per-route `requireIngestScope` gate (tagged, so it shows on the route table
  // as `scopes: ['reporting:ingest']`) 403s anything without the scope. High-rate
  // telemetry writes: auditing every batch would flood the trail with machine
  // rows and say nothing a Prometheus counter doesn't (see the ingest-health
  // endpoint + `pipeline_stage_result_total`).
  {
    method: 'POST',
    path: '/reports/events',
    waive: 'all',
    reason: 'Machine event ingest — requireIngestScope (`reporting:ingest` token scope); high-rate telemetry, counted in metrics rather than audited per batch.',
  },
  {
    method: 'POST',
    path: '/reports/ingest-health',
    waive: 'all',
    reason: 'Machine ingest-health heartbeat — requireIngestScope (`reporting:ingest` token scope); periodic counter upsert, not an audit-worthy mutation.',
  },
  {
    method: 'POST',
    path: '/reports/incidents',
    waive: 'all',
    reason: 'Machine incident webhook (PagerDuty/Datadog) — requireIngestScope (`reporting:ingest` token scope); org comes from the token identity, and the upsert stream is telemetry, not an operator action.',
  },
  {
    method: 'POST',
    path: '/reports/incidents/alertmanager',
    waive: 'all',
    reason: 'Machine Alertmanager webhook adapter — same requireIngestScope credential + idempotent (org, incidentId) upsert as POST /reports/incidents.',
  },
  // ── Internal service-to-service entitlement sync ───────────────────────────
  // ── Non-persisting POSTs ───────────────────────────────────────────────────
  {
    method: 'POST',
    path: '/reports/incidents/test',
    waive: 'audit',
    reason: 'Wiring-test dry-run: computes whether a synthetic incident opening now would correlate to a recent deploy and persists nothing (gated on reports:read + advanced_reporting).',
  },
  {
    method: 'POST',
    path: '/reports/execution/stream/ticket',
    waive: 'audit',
    reason: 'Mints a single-use, TTL-bound SSE ticket for the live execution channel — no persisted state (gated on reports:read).',
  },
  {
    method: 'GET',
    path: '/reports/execution/stream',
    waive: 'permission',
    reason: 'Ticket-gated SSE stream: the EventSource cannot send an Authorization header, so authorization is the single-use org-bound ticket redeemed in the handler (minted by the reports:read-gated POST above).',
  },
];

/**
 * The INTERNAL routes this service exposes and the services allowed to
 * call them — the same list `deploy/*​/k8s/istio-internal-routes.yaml` names, and
 * the ONE place it is written down. `findInternalRouteViolations` checks it
 * against the code in both directions.
 */
const INTERNAL_ROUTES: InternalRouteDeclaration[] = [
  { method: 'PUT', path: '/reports/retention-sync/:orgId', callers: ['billing'] },
  { method: 'GET', path: '/reports/retention-sync/:orgId', callers: ['billing'] },
];

let table: RouteTableEntry[];

beforeAll(async () => {
  const [{ createApp, postgresHealthCheck }, { mountRoutes }] = await Promise.all([
    import('@pipeline-builder/api-server'),
    import('../src/app-routes.js'),
  ]);
  const { app, sseManager } = createApp({ enableOpenApi: false, checkDependencies: postgresHealthCheck, jsonLimit: '5mb' });
  // The ticket store's backing Redis is irrelevant to the route table (no request
  // is served) — only the routes registerSseTicketChannel adds matter.
  const executionTicketStore = { issue: async () => ({ ok: true as const, ticket: 't' }), consume: async () => null, bindOwner: async () => undefined, getOwner: async () => null, stop: () => undefined };
  mountRoutes(app, { sseManager, executionTicketStore });
  table = buildRouteTable(app);
});

describe('reporting route coverage', () => {
  it('serves a non-empty route table', () => {
    expect(table.length).toBeGreaterThan(0);
  });

  it('gates every write route on a permission and declares its audit action', () => {
    const { violations } = findRouteCoverageViolations(table, EXCEPTIONS);
    expect(violations).toEqual([]);
  });

  it('has no stale coverage exceptions', () => {
    const { unusedExceptions } = findRouteCoverageViolations(table, EXCEPTIONS);
    expect(unusedExceptions).toEqual([]);
  });

  it('declares only audit actions platform accepts from a service', () => {
    const unknown = declaredAuditActions(table).filter((a) => !(REMOTE_AUDIT_ACTIONS as readonly string[]).includes(a));
    expect(unknown).toEqual([]);
  });

  it('gates every internal route on requireInternalService, with the declared callers', () => {
    expect(findInternalRouteViolations(table, INTERNAL_ROUTES)).toEqual([]);
  });

  it('matches the route table the frontend reads', () => {
    expect(compareRouteTableSnapshot(table, snapshotFile)).toBeNull();
  });
});
