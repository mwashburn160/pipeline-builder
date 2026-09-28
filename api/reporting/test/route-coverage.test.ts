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
    method: 'GET',
    path: '/reports/events/last-deploy-commit',
    waive: 'all',
    reason: 'Machine read on the same ingest credential — requireIngestScope (`reporting:ingest` token scope). Tenancy is enforced inside from the pipeline REGISTRY (same allow-list as the ingest POST), not by a user permission; the events Lambda reads it to recover its commit-range lower bound after a cold start.',
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
  // ── Stakeholder reports: writes with no separate audit action ───────────────
  {
    method: 'POST',
    path: '/reports/stakeholder/definitions/:id/runs',
    waive: 'audit',
    reason: 'Computes a DRAFT run nobody has seen yet (gated on reports:author + the stakeholder_reports feature + a per-org compose rate limit). Nothing leaves the platform until POST /runs/:id/publish, which IS audited and carries the period + version; auditing every regenerate-while-drafting would bury that entry.',
  },
  {
    method: 'PUT',
    path: '/reports/stakeholder/runs/:id/notes',
    waive: 'audit',
    reason: "Edits the lead's own narrative on an UNPUBLISHED run (gated on reports:author); the store refuses it after publish. The published snapshot is frozen and reporting.report.published records what was released, so the draft's intermediate wording is not audit-relevant.",
  },
  {
    method: 'POST',
    path: '/reports/stakeholder/recipients/:id/resend',
    waive: 'audit',
    reason: 'Re-mints the SAME pending address confirmation (gated on reports:author + a 10/hour per-org limit). The address itself was audited by reporting.report.recipient.added; a resend adds no new fact, and the confirmation still has to be clicked before anything is delivered.',
  },
  {
    method: 'POST',
    path: '/reports/stakeholder/runs/:id/summary',
    waive: 'audit',
    reason: 'Drafts the AI executive summary onto an UNPUBLISHED run (gated on reports:author + the stakeholder_reports feature + a per-org rate limit); the store refuses it after publish. Nothing leaves the platform — the draft is the lead\'s starting point for text they then edit, and `reporting.report.published` records what was actually released. Auditing every regenerate-while-drafting would bury that entry, exactly as it would for the notes route above.',
  },
  {
    method: 'POST',
    path: '/reports/stakeholder-preview',
    waive: 'audit',
    reason: 'The one free watermarked preview for an org that has NOT bought the add-on (gated on reports:author, outside the feature gate by design, once-ever via a conditional claim). It PERSISTS NOTHING — no definition, no run, no link — so there is no entity for an audit row to point at; what it consumes is recorded on the org\'s settings row as `report_preview_used_at`, and the attempt is metered (`report_preview_generated_total`).',
  },
  // ── The UNAUTHENTICATED public half ────────────────────────────────────────
  // These have no user, by design: the manager reading a shared report and the
  // recipient confirming their own address have no account here. Authorization is
  // a 256-bit token resolved to a single row (stored only as a SHA-256 hash), plus
  // a per-client-IP rate limit; see routes/public-reports.ts for the full shape.
  {
    method: 'GET',
    path: '/public/reports/:token',
    waive: 'all',
    reason: 'Unauthenticated by design — the audience is stakeholders with no platform account. Authorized by a 256-bit share token (stored hashed, expiring, revocable, and only mintable when an org admin turned sharing ON); serves one frozen snapshot, per-IP rate-limited, noindex/no-referrer/private-no-store. Every access is LOGGED and counted per link rather than audited: an externally-triggered read must not be able to write unbounded rows into the org audit trail.',
  },
  {
    method: 'GET',
    path: '/public/reports/:token/pdf',
    waive: 'all',
    reason: 'Unauthenticated by design, for exactly the audience and on exactly the terms of the shared report above — same 256-bit hashed share token, same single indistinguishable 404, same redaction, same noindex/no-referrer/private-no-store, and the PDF is rendered FROM the same redacted payload so it can never carry more than the page does (no executive summary, no unredacted names). Rate-limited to 6/min per IP rather than 60, because a render costs a Chromium launch where a page view costs a row read. Logged and counted per link, not audited, for the same reason: an externally-triggered read must not write unbounded rows into the org audit trail.',
  },
  {
    method: 'POST',
    path: '/public/report-recipients/verify',
    waive: 'all',
    reason: 'Unauthenticated by design — the person confirming their own delivery address has no account. Authorized by the single-use emailed token (hashed at rest, consumed on success, TTL-bounded) and per-IP rate-limited. POST rather than GET so a mail scanner cannot consume the confirmation. Its effect is recorded on the recipient row the reporting.report.recipient.added event already named.',
  },
  {
    method: 'POST',
    path: '/public/report-recipients/unsubscribe',
    waive: 'all',
    reason: 'Unauthenticated by design — a recipient stopping email they did not want has no account, and requiring one would make the only way out a spam complaint. Authorized by the recipient\'s own opaque token and per-IP rate-limited; the single effect is setting `unsubscribed_at` on that one row, which is self-limiting (it can only reduce what we send). POST, and the URL the List-Unsubscribe header carries, so a corporate mail gateway prefetching links cannot silently remove managers from the list. Not audited: an externally-triggered write must not be able to append unbounded rows to an org audit trail, and the outcome is visible on the recipient row.',
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
  { method: 'POST', path: '/reports/stakeholder-internal/owner-left/:orgId/:userId', callers: ['platform'] },
  // The account gained or lost the Stakeholder Reports add-on. Pauses or resumes every
  // report in the ACCOUNT (root + teams); billing only.
  { method: 'PUT', path: '/reports/stakeholder-sync/:orgId', callers: ['billing'] },
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
