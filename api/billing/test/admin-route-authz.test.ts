// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Governance guard for the billing ADMIN surface.
 *
 * Every `/admin/*` billing route is fleet-wide (discounts, promotions, subscription
 * admin, finance backfill) and MUST carry a PLATFORM-level gate at the route layer
 * — not merely in the controller. This scans the route source and fails if a new
 * `/admin/` route ships without one, forcing a deliberate review (and an allowlist
 * edit) rather than a silent privilege hole.
 *
 * THREE SPELLINGS QUALIFY. `requireSystemAdmin` is the superadmin flag.
 * `requirePermission('<system-org-only permission>')` and the composed
 * `requireSystemOrgPermission('<same>')` are the permission form: the permission can only be held inside the system org and only
 * through a seeded Role, so it is a platform-level gate too — and it lets an
 * operator run the finance surfaces without also receiving impersonation and a
 * database shell, which full superadmin would hand over.
 *
 * The check is NOT "has some permission": a tenant-grantable permission here
 * would be a privilege hole, since `billing:manage` is held by ordinary org
 * admins. The permission named must be in `SYSTEM_ORG_ONLY_PERMISSIONS`, which is
 * read from api-core rather than hardcoded so adding one cannot silently widen
 * what this guard accepts.
 *
 * Scoped to billing because its admin routes gate per-line consistently; a naive
 * cross-service "every route has requireAuth" check would false-positive the many
 * services that apply auth at the router-mount level instead.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from '@jest/globals';
import { SYSTEM_ORG_ONLY_PERMISSIONS } from '@pipeline-builder/api-core';

// Each `router.<verb>('/admin/…', <middleware…>, withRoute(...))` — capture the
// middleware chain between the path and the handler (spans line wraps).
const ADMIN_ROUTE_RE = /router\.(?:get|post|put|patch|delete)\(\s*['"`](\/admin\/[^'"`]*)['"`]([\s\S]*?)(?:withRoute|async\s*\()/g;

/** Known, reviewed exceptions (`file: /admin/path`). Empty today — every admin
 *  route carries either `requireSystemAdmin` or a system-org-only permission.
 *  Add here only with a deliberate reason. */
const ALLOWLIST = new Set<string>([]);

describe('billing /admin route authz governance', () => {
  it('every /admin route carries a platform-level gate at the route layer', () => {
    // Derive the routes dir from the test file path (ESM has no __dirname here).
    const ROUTES_DIR = path.join(path.dirname(expect.getState().testPath as string), '..', 'src', 'routes');
    const offenders: string[] = [];
    for (const file of fs.readdirSync(ROUTES_DIR)) {
      if (!file.endsWith('.ts')) continue;
      const src = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf-8');
      let m: RegExpExecArray | null;
      while ((m = ADMIN_ROUTE_RE.exec(src)) !== null) {
        const [, routePath, middleware] = m;
        const key = `${file}: ${routePath}`;
        // Either spelling of the permission form counts, and the second is the
        // one to prefer: `requireSystemOrgPermission(...)` composes
        // requireSystemOrg + the permission + an MFA-grade session, which is
        // what `findSystemOrgGuardViolations` demands of any route gated on a
        // system-org-only permission. A bare `requirePermission` still passes
        // HERE — this guard asks "is there a platform-level gate", not "is it
        // the full chain" — but it will fail that route-coverage check instead.
        const systemOrgOnly = SYSTEM_ORG_ONLY_PERMISSIONS.some(
          (perm) => middleware.includes(`requirePermission('${perm}')`)
            || middleware.includes(`requireSystemOrgPermission('${perm}')`),
        );
        if (!middleware.includes('requireSystemAdmin') && !systemOrgOnly && !ALLOWLIST.has(key)) {
          offenders.push(key);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
