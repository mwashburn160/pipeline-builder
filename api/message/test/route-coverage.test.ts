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
  findRouteCoverageViolations,
  type InternalRouteDeclaration,
  type RouteCoverageException,
} from '@pipeline-builder/api-core/testing';

process.env.JWT_SECRET ||= 'route-coverage-test-secret';

const here = dirname(fileURLToPath(import.meta.url));
const snapshotFile = resolve(here, '../../../frontend/src/generated/route-table/message.json');

/**
 * Routes that legitimately can't satisfy a rule, each with its reason.
 *
 * The un-audited message WRITES are a deliberate product decision recorded with
 * the action list itself (api-core `REMOTE_AUDIT_ACTIONS`): only admin BROADCAST
 * announcements and the destructive delete/restore/purge reach the central trail
 * — 1:1 message traffic is high-volume and auditing it would pull private
 * message content (or its metadata trail) into the compliance record.
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
    method: 'POST',
    path: '/messages/attachments',
    waive: 'audit',
    reason: 'Message CONTENT write (a pending upload for a 1:1 message) — the same intentionally-unaudited class as the message it attaches to; the destructive side (delete/purge) IS audited.',
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
    method: 'PATCH',
    path: '/messages/:id',
    waive: 'audit',
    reason: 'Author-only edit of a message body (ownership enforced in messageService.editContent) — same unaudited message-content class as send/reply.',
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
  {
    method: 'POST',
    path: '/messages/internal/notify',
    waive: 'all',
    reason: 'INTERNAL route: requireAuth + requireInternalService({ callers: [platform, billing, compliance] }) — a signed service token, never a user session — so no user permission applies; the calling service audits the event it notifies about.',
  },
  {
    method: 'DELETE',
    path: '/messages/internal/org/:orgId/attachments',
    waive: 'all',
    reason: 'INTERNAL route: requireAuth + requireInternalService({ callers: [platform] }); the platform org-delete cascade calls it and audits the org deletion that triggers the blob reclaim.',
  },
];

/**
 * The INTERNAL routes this service exposes and the services allowed to
 * call them — the same list `deploy/*​/k8s/istio-internal-routes.yaml` names, and
 * the ONE place it is written down. `findInternalRouteViolations` checks it
 * against the code in both directions.
 */
const INTERNAL_ROUTES: InternalRouteDeclaration[] = [
  { method: 'POST', path: '/messages/internal/notify', callers: ['platform', 'billing', 'compliance'] },
  { method: 'DELETE', path: '/messages/internal/org/:orgId/attachments', callers: ['platform'] },
];

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
