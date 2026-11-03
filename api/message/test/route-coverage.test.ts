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
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { buildRouteTable, REMOTE_AUDIT_ACTIONS, type RouteTableEntry, type SseTicketStore } from '@pipeline-builder/api-core';
import {
  INFRA_ROUTE_EXCEPTIONS,
  compareRouteTableSnapshot,
  declaredAuditActions,
  findInternalRouteViolations,
  findRouteCoverageViolations, findSystemOrgGuardViolations,
  findDynamicAuthzViolations,
  type InternalRouteDeclaration,
  findQuotaCoverageViolations,
  type QuotaCoverageException,
  type RouteCoverageException,
} from '@pipeline-builder/api-core/testing';

process.env.JWT_SECRET ||= 'route-coverage-test-secret';

const here = dirname(fileURLToPath(import.meta.url));
const snapshotFile = resolve(here, '../../../frontend/src/generated/route-table/message.json');

/**
 * Routes that legitimately can't satisfy a rule, each with its reason.
 *
 * The un-audited message WRITES are a deliberate product decision recorded with
 * the action list itself (api-core `REMOTE_AUDIT_ACTIONS`): 1:1 sends and replies
 * are high-volume and auditing them would pull private message traffic into the
 * compliance record. Edits and attachment uploads ARE audited, metadata only.
 */
const EXCEPTIONS: RouteCoverageException[] = [
  ...INFRA_ROUTE_EXCEPTIONS,
  {
    method: 'GET',
    path: '/messages/notifications',
    waive: 'permission',
    reason: 'Per-org notification SSE stream — authorized by a single-use, org-bound ticket redeemed in the handler (the mint, POST …/ticket, carries messages:read).',
  },
  {
    method: 'POST',
    path: '/messages/notifications/ticket',
    waive: 'audit',
    reason: 'Mints an ephemeral single-use SSE ticket (TTL-bounded, in Redis/memory); persists no tenant state.',
  },
  {
    method: 'PATCH',
    path: '/messages/support/:id/satisfaction',
    waive: 'audit',
    reason: "CSAT — the customer's 1-to-5 opinion of their OWN closed case, stored on that case and visible to them. It changes no entitlement, no ownership and no clock, and it is the one case write STAFF may not make (a vendor-settable satisfaction score is not a satisfaction score), so there is no privilege escalation to record either. Auditing a 1-to-5 opinion would add noise to a trail read for authorization questions. The product signal lives in the `satisfaction` column and the CSAT-by-level rollup instead.",
  },
  {
    method: 'POST',
    path: '/messages/support',
    waive: 'audit',
    reason: 'Contact-support message — a 1:1 conversation to the support desk, the same intentionally-unaudited message-content class as POST /messages creates (only admin broadcasts and deletes are audited).',
  },
  {
    method: 'POST',
    path: '/messages/:id/reply',
    waive: 'audit',
    reason: '1:1 conversation reply — intentionally not audited (noise + it would pull private message traffic into the trail); only admin broadcasts and deletes are.',
  },
  {
    method: 'POST',
    path: '/messages/support/:id/reply',
    waive: 'audit',
    reason: 'The support-scoped twin of POST /messages/:id/reply: identical handler, gated on messages:read instead of messages:write so the person who RAISED a case can answer it (the support send is already gated that way, so without this carve-out openers could not reply). Waived here for the same reason as its twin — the MIDDLEWARE declares no action — but note the handler itself emits `support.case.reply` via recordAudit for STAFF replies only, carrying `firstResponse`. A tenant answering its own case is correspondence, not a response to it, so auditing every tenant reply would be the noise the twin\'s waiver exists to avoid.',
  },
  {
    method: 'PUT',
    path: '/messages/:id/read',
    waive: 'audit',
    reason: 'Per-reader UI state flip (unread → read) — extremely high volume and no security consequence.',
  },
  {
    method: 'PUT',
    path: '/messages/:id/thread/read',
    waive: 'audit',
    reason: 'Per-reader UI state flip for a whole thread — extremely high volume and no security consequence.',
  },
];

/**
 * The INTERNAL routes this service exposes and the services allowed to
 * call them — the same list `deploy/*​/k8s/istio-internal-routes.yaml` names, and
 * the ONE place it is written down. `findInternalRouteViolations` checks it
 * against the code in both directions.
 */
const INTERNAL_ROUTES: InternalRouteDeclaration[] = [
  { method: 'POST', path: '/messages/internal/notify', callers: ['platform', 'billing', 'compliance', 'quota'] },
  { method: 'DELETE', path: '/messages/internal/org/:orgId/attachments', callers: ['platform'] },
];

/**
 * User routes that deliberately do not meter and/or check apiCalls, each with
 * its reason (docs/quotas.md). The fleet-wide console-polling carve-out lives
 * in api-core `QUOTA_EXEMPT_ROUTES`, not here.
 */
const QUOTA_EXCEPTIONS: QuotaCoverageException[] = [];

let table: RouteTableEntry[];
let ticketStore: SseTicketStore;

beforeAll(async () => {
  const [{ createApp }, { createQuotaService, createEnvSseTicketStore, SSE_TICKET_TTL_MS }, { mountRoutes }] = await Promise.all([
    import('@pipeline-builder/api-server'),
    import('@pipeline-builder/api-core'),
    import('../src/app-routes.js'),
  ]);
  const { app, sseManager } = createApp({ enableOpenApi: false });
  ticketStore = createEnvSseTicketStore({ ttlMs: SSE_TICKET_TTL_MS, maxTotal: 10, maxPerOrg: 2 });
  mountRoutes(app, { quotaService: createQuotaService(), sseManager, ticketStore });
  table = buildRouteTable(app);
});

afterAll(() => {
  ticketStore?.stop();
});

describe('message route coverage', () => {
  it('meters and checks apiCalls on every user route, and meters none twice', () => {
    const { violations } = findQuotaCoverageViolations(table, QUOTA_EXCEPTIONS);
    expect(violations).toEqual([]);
  });

  it('has no stale quota exceptions', () => {
    const { unusedExceptions } = findQuotaCoverageViolations(table, QUOTA_EXCEPTIONS);
    expect(unusedExceptions).toEqual([]);
  });

  it('serves a non-empty route table', () => {
    expect(table.length).toBeGreaterThan(0);
  });

  it('gates every write route on a permission and declares its audit action', () => {
    const { violations } = findRouteCoverageViolations(table, EXCEPTIONS);
    expect(violations).toEqual([]);
  });

  // Every route gated on a SYSTEM-ORG-ONLY permission must also run
  // `requireSystemOrg` and demand an MFA-grade session — i.e. be wired with
  // `requireSystemOrgPermission`, which composes all three so a route cannot
  // forget one. Token confinement already drops those permissions from a
  // tenant-scoped token, so this is the second half of an AND: the claim-only
  // org check costs nothing per request and does not depend on confinement
  // being applied correctly at every minting site.
  //
  // This assertion used to run in only two services, which is exactly how the
  // platform-operations permissions arrived without it. No exception list.
  it('guards every system-org-only route to the system org with aal2', () => {
    expect(findSystemOrgGuardViolations(table)).toEqual([]);
  });

  // The same rule for a route whose authority is resolved in its HANDLER.
  // `dynamicAuthz` is the only thing that puts such a route on the table at all
  // — its row otherwise reads `systemAdmin: false, permissions: []`, which is
  // indistinguishable from "merely authenticated" — so the declaration has to be
  // answerable: every dynamic rule names the principal KINDS it admits, and one
  // admitting a system-org principal names the permission ids it consults.
  //
  // This service has no dynamic route today, so it passes trivially. It is wired
  // anyway, for the same reason `findSystemOrgGuardViolations` is: that check ran
  // in two of ten services, which is exactly how the platform-operations
  // permissions shipped without it. A guard present before the first such route
  // exists bites the day one lands; a guard added afterwards is a guard somebody
  // has to remember.
  it('declares who every dynamically-authorized route admits', () => {
    expect(findDynamicAuthzViolations(table)).toEqual([]);
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
