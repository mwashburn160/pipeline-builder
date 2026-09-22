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

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from '@jest/globals';
import { buildRouteTable, REMOTE_AUDIT_ACTIONS, type RouteTableEntry } from '@pipeline-builder/api-core';
import {
  INFRA_ROUTE_EXCEPTIONS,
  compareRouteTableSnapshot,
  declaredAuditActions,
  findInternalRouteViolations,
  findRouteCoverageViolations,
  findSystemOrgGuardViolations,
  type InternalRouteDeclaration,
  type RouteCoverageException,
} from '@pipeline-builder/api-core/testing';

process.env.JWT_SECRET ||= 'route-coverage-test-secret';
// The upload route builds its multer instance at module load and mkdir's the
// destination; the production default (/opt/pipeline/...) isn't writable here.
process.env.PLUGIN_UPLOAD_DIR ||= mkdtempSync(join(tmpdir(), 'plugin-route-coverage-'));

const here = dirname(fileURLToPath(import.meta.url));
const snapshotFile = resolve(here, '../../../frontend/src/generated/route-table/plugin.json');

/** Routes that legitimately can't satisfy a rule, each with its reason. */
const EXCEPTIONS: RouteCoverageException[] = [
  ...INFRA_ROUTE_EXCEPTIONS,
  {
    method: 'POST',
    path: '/plugins/lookup',
    waive: 'audit',
    reason: 'Read-only single-plugin lookup that takes its filter from the body (gated on plugins:read); persists nothing.',
  },
  {
    method: 'POST',
    path: '/plugins/inspect',
    waive: 'audit',
    reason: 'Dry-run parse of a plugin zip for the upload dialog (gated on plugins:write, rate limited): builds nothing, reserves no quota and stores nothing; the upload it precedes is audited.',
  },
  {
    method: 'POST',
    path: /^POST \/plugins\/generate/,
    waive: 'audit',
    reason: 'AI generation returns a draft plugin config; nothing is persisted (deploying it goes through POST /plugins/deploy-generated, which is audited).',
  },
  {
    path: /^(PUT|DELETE) \/plugins\/reviews\/:id\/helpful$/,
    waive: 'audit',
    reason: 'A review "helpful" vote is not audited by design (votes are a signal, not a state change anyone is accountable for); gated on plugins:read + a human session, one vote per user, throttled per user and org.',
  },
  {
    path: /^(GET|POST) \/public\/plugin-submissions/,
    waive: 'permission',
    reason: 'Anonymous plugin submissions: no caller identity by design. 404 unless ANONYMOUS_SUBMISSIONS_ENABLED + outbound email; every write needs a single-use proof-of-work; rate limited per trusted IP and capped per email/IP per day. Quarantine only — nothing reaches a plugins row or public/* without the two-person submission request.',
  },
  {
    method: 'POST',
    path: '/public/plugin-submissions/inspect',
    waive: 'audit',
    reason: 'Dry-run parse of a submission zip (proof-of-work, rate limited): builds nothing and stores nothing; the submission it precedes is audited (plugin.submission.create).',
  },
  {
    method: 'POST',
    path: '/public/plugin-security-notifications/confirm',
    waive: 'permission',
    reason: 'Confirms an org\'s external security-notice address from its emailed link: no caller identity by design (the recipient may have no account; nginx strips credentials). The single-use, 24-hour token (stored only as a sha256) is the authority; rate limited per trusted IP; audited.',
  },
  {
    path: /^GET \/public\/plugins/,
    waive: 'permission',
    reason: 'Anonymous public plugin directory: no caller identity by design (nginx strips credentials), reads only the public_* views through the view-only ecosystem_public_reader role, rate limited per trusted IP.',
  },
];

/**
 * This service's INTERNAL routes and their callers — checked against the code
 * in both directions (and mirrored by the Istio `plugin-allow` policy).
 */
const INTERNAL_ROUTES: InternalRouteDeclaration[] = [
  // image-registry: which of an org's plugins its teams may pull.
  { method: 'GET', path: '/internal/plugins/public-names', callers: ['image-registry'] },
];

let table: RouteTableEntry[];

beforeAll(async () => {
  const [{ createApp }, { createQuotaService }, { mountRoutes }] = await Promise.all([
    import('@pipeline-builder/api-server'),
    import('@pipeline-builder/api-core'),
    import('../src/app-routes.js'),
  ]);
  // `logStream: true` is the one createApp option that adds routes (the
  // build-log SSE stream + its ticket mint) — index.ts enables it, so the table
  // must include it.
  const { app, sseManager } = createApp({ enableOpenApi: false, logStream: true });
  mountRoutes(app, { quotaService: createQuotaService(), sseManager });
  table = buildRouteTable(app);
});

describe('plugin route coverage', () => {
  it('serves a non-empty route table', () => {
    expect(table.length).toBeGreaterThan(0);
  });

  it('gates every write route on a permission and declares its audit action', () => {
    const { violations } = findRouteCoverageViolations(table, EXCEPTIONS);
    expect(violations).toEqual([]);
  });

  // Plugin-ecosystem governance: every route gated on a
  // system-org-only permission (plugins:moderate, publishers:verify) must also
  // run requireSystemOrg and demand aal2 — use requireEcosystemPermission. No
  // exception list: passes today, bites the day a governance route lacks it.
  it('guards every ecosystem-governance route to the system org with aal2', () => {
    expect(findSystemOrgGuardViolations(table)).toEqual([]);
  });

  it('has no stale coverage exceptions', () => {
    const { unusedExceptions } = findRouteCoverageViolations(table, EXCEPTIONS);
    expect(unusedExceptions).toEqual([]);
  });

  it('admits only the declared callers on every internal route', () => {
    expect(findInternalRouteViolations(table, INTERNAL_ROUTES)).toEqual([]);
  });

  it('declares only audit actions platform accepts from a service', () => {
    const unknown = declaredAuditActions(table).filter((a) => !(REMOTE_AUDIT_ACTIONS as readonly string[]).includes(a));
    expect(unknown).toEqual([]);
  });

  it('matches the route table the frontend reads', () => {
    expect(compareRouteTableSnapshot(table, snapshotFile)).toBeNull();
  });
});
