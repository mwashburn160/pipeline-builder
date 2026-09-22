// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin-ecosystem GOVERNANCE (plan §3.0 "Enforcement", §8 checklist):
 * only the system org manages or approves the ecosystem. Built from the REAL
 * route table (`mountRoutes`), this fails when
 *
 *  - any `/plugins/ecosystem/*` route is reachable without the system-org
 *    guard, an MFA-grade session and a system-org-only permission;
 *  - any route that DECIDES, admits, expands or changes ecosystem state (by the
 *    audit actions it declares) is reachable by a tenant-held permission;
 *  - the tenant ecosystem routes are anything but the enumerated request and
 *    restrict set (§3.0 "What tenant orgs keep").
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from '@jest/globals';
import { buildRouteTable, isSystemOrgOnlyPermission, type RouteTableEntry } from '@pipeline-builder/api-core';

process.env.JWT_SECRET ||= 'ecosystem-governance-test-secret';
process.env.PLUGIN_UPLOAD_DIR ||= mkdtempSync(join(tmpdir(), 'plugin-governance-'));

/** Audit actions that record an ECOSYSTEM DECISION — system org only. */
const GOVERNANCE_ACTIONS = [
  'plugin.request.approve', 'plugin.request.second-approve', 'plugin.request.reject', 'plugin.request.auto-approve',
  'plugin.listing.publish', 'plugin.listing.update', 'plugin.listing.unpause', 'plugin.listing.state.change', 'plugin.listing.unlist',
  'plugin.version.yank', 'plugin.version.unyank',
  'publisher.tier.change', 'publisher.verify.approve', 'publisher.verify.reject', 'publisher.suspend', 'publisher.unsuspend',
  'publisher.transfer.approve', 'publisher.transfer.reject', 'publisher.profile-change.approve', 'publisher.profile-change.reject',
  // Only the system org publishes, edits or withdraws an advisory (W8); tenants only submit drafts (plugin.advisory.create).
  'plugin.advisory.publish', 'plugin.advisory.update', 'plugin.advisory.withdraw',
  // Only a system-org decision moves an anonymous submission out of quarantine (§4).
  'plugin.submission.approve', 'plugin.submission.reject', 'plugin.submission.claim',
];

/** The tenant REQUEST / RESTRICT routes (§3.0): each only submits a request or narrows the caller's own reach. */
const TENANT_ECOSYSTEM_ROUTES = new Set([
  'GET /plugins/publisher',
  'POST /plugins/publisher',
  'PATCH /plugins/publisher',
  'POST /plugins/publisher/terms',
  'GET /plugins/publisher/listings',
  'GET /plugins/publisher/insights',
  'POST /plugins/publisher/listings/:listingId/pause',
  'POST /plugins/publisher/listings/:listingId/deprecate',
  'GET /plugins/publisher/advisories',
  'GET /plugins/publisher/incoming-transfers',
  'GET /plugins/publish-requests',
  'GET /plugins/publish-requests/draft',
  'POST /plugins/publish-requests',
  'POST /plugins/publish-requests/:id/withdraw',
  'POST /plugins/publish-requests/:id/transfer-response',
]);

/**
 * Org-LOCAL routes that share an ecosystem audit action but decide nothing in
 * the ecosystem, each with its reason.
 */
const ORG_LOCAL_CARVE_OUTS: Record<string, string> = {
  'POST /plugins/:id/yank': 'W0.4 yank of the org\'s OWN unlisted version (plugins:write); a LISTED version is refused with PLUGIN_VERSION_FROZEN and can only be yanked by the system org.',
};

let table: RouteTableEntry[];

beforeAll(async () => {
  const [{ createApp }, { createQuotaService }, { mountRoutes }] = await Promise.all([
    import('@pipeline-builder/api-server'),
    import('@pipeline-builder/api-core'),
    import('../src/app-routes.js'),
  ]);
  const { app, sseManager } = createApp({ enableOpenApi: false, logStream: true });
  mountRoutes(app, { quotaService: createQuotaService(), sseManager });
  table = buildRouteTable(app);
});

const key = (e: RouteTableEntry) => `${e.method} ${e.path}`;
const perms = (e: RouteTableEntry) => e.permissions.flatMap((g) => g.permissions);

describe('plugin ecosystem governance (§3.0)', () => {
  it('serves the console', () => {
    expect(table.filter((e) => e.path.startsWith('/plugins/ecosystem/')).length).toBeGreaterThanOrEqual(20);
  });

  it('guards every console route to the system org, aal2 and a system-org-only permission', () => {
    const bad = table
      .filter((e) => e.path.startsWith('/plugins/ecosystem'))
      .filter((e) => e.systemOrg !== true || e.minAssurance < 2 || perms(e).length === 0 || !perms(e).every((p) => isSystemOrgOnlyPermission(p)))
      .map(key);
    expect(bad).toEqual([]);
  });

  it('lets no tenant-held permission reach a route that records an ecosystem decision', () => {
    const bad = table
      .filter((e) => e.audit.some((a) => GOVERNANCE_ACTIONS.includes(a) || a.startsWith('ecosystem.')))
      .filter((e) => e.systemOrg !== true || perms(e).some((p) => !isSystemOrgOnlyPermission(p)))
      .map(key)
      .filter((k) => !(k in ORG_LOCAL_CARVE_OUTS));
    expect(bad).toEqual([]);
    // A stale carve-out fails too.
    for (const k of Object.keys(ORG_LOCAL_CARVE_OUTS)) expect(table.map(key)).toContain(k);
  });

  it('lets the anonymous submission API only submit and verify — never decide or publish (§4)', () => {
    const anon = table.filter((e) => e.path.startsWith('/public/plugin-submissions'));
    expect(anon.map(key).sort()).toEqual([
      'GET /public/plugin-submissions/challenge',
      'GET /public/plugin-submissions/status',
      'POST /public/plugin-submissions',
      'POST /public/plugin-submissions/inspect',
      'POST /public/plugin-submissions/verify',
    ]);
    const declared = [...new Set(anon.flatMap((e) => e.audit))].sort();
    expect(declared).toEqual(['plugin.submission.create', 'plugin.submission.verify']);
    // And the only routes that can record an approved submission are the two-person console decisions.
    const approvers = table.filter((e) => e.audit.includes('plugin.submission.approve')).map(key);
    expect(approvers).toEqual(['POST /plugins/ecosystem/requests/:id/second-approve']);
  });

  it('keeps install change requests ORG-LOCAL: members request, the org\'s own approvers decide', () => {
    const route = (k: string) => table.find((e) => key(e) === k)!;
    expect(perms(route('POST /plugins/installs/:id/change-requests'))).toEqual(['plugins:install']);
    expect(route('POST /plugins/installs/:id/change-requests').audit).toEqual(['plugin.install.change-request']);
    for (const k of ['GET /plugins/installs/change-requests', 'POST /plugins/installs/:id/change-requests/approve', 'POST /plugins/installs/:id/change-requests/reject']) {
      expect(perms(route(k))).toEqual(['plugin_installs:manage']);
      expect(route(k).systemOrg).not.toBe(true);
    }
    expect(route('POST /plugins/installs/:id/change-requests/approve').audit).toEqual(['plugin.install.change-approve', 'plugin.install.upgrade']);
    expect(route('POST /plugins/installs/:id/change-requests/reject').audit).toEqual(['plugin.install.change-reject']);
  });

  it('exposes exactly the enumerated tenant request/restrict routes', () => {
    const tenant = table.filter((e) => e.path.startsWith('/plugins/publisher') || e.path.startsWith('/plugins/publish-requests')).map(key);
    expect(new Set(tenant)).toEqual(TENANT_ECOSYSTEM_ROUTES);
    for (const e of table.filter((x) => TENANT_ECOSYSTEM_ROUTES.has(key(x)))) {
      expect(perms(e).some((p) => isSystemOrgOnlyPermission(p))).toBe(false);
    }
  });

  it('requires a step-up for the transfer answer and every console write except request decisions and reserved names', () => {
    expect(table.find((e) => key(e) === 'POST /plugins/publish-requests/:id/transfer-response')!.stepUp).toBe(true);
    const unguarded = table
      .filter((e) => e.path.startsWith('/plugins/ecosystem') && e.method !== 'GET' && !e.stepUp)
      .map(key)
      .sort();
    // Decisions step up per request KIND (stepUpForSensitiveRequest); reserved names are not destructive;
    // review moderation only hides or restores user content (§5a asks no step-up for it).
    expect(unguarded).toEqual([
      'DELETE /plugins/ecosystem/reserved-names/:name',
      'POST /plugins/ecosystem/requests/:id/approve',
      'POST /plugins/ecosystem/requests/:id/reject',
      'POST /plugins/ecosystem/requests/:id/second-approve',
      'POST /plugins/ecosystem/reviews/:id/hold',
      'POST /plugins/ecosystem/reviews/:id/release',
      'POST /plugins/ecosystem/reviews/:id/remove',
      'POST /plugins/ecosystem/reviews/:id/remove-reply',
      'PUT /plugins/ecosystem/reserved-names/:name',
    ]);
  });
});
