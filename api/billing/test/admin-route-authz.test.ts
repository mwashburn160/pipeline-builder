// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Governance guard for the billing ADMIN surface.
 *
 * Every `/admin/*` billing route is fleet-wide (discounts, promotions, subscription
 * admin, finance backfill) and MUST be gated by `requireSystemAdmin` at the route
 * layer — not merely in the controller. This scans the route source and fails if a
 * new `/admin/` route ships without that gate, forcing a deliberate review (and an
 * allowlist edit) rather than a silent privilege hole.
 *
 * Scoped to billing because its admin routes gate per-line consistently; a naive
 * cross-service "every route has requireAuth" check would false-positive the many
 * services that apply auth at the router-mount level instead.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from '@jest/globals';

// Each `router.<verb>('/admin/…', <middleware…>, withRoute(...))` — capture the
// middleware chain between the path and the handler (spans line wraps).
const ADMIN_ROUTE_RE = /router\.(?:get|post|put|patch|delete)\(\s*['"`](\/admin\/[^'"`]*)['"`]([\s\S]*?)(?:withRoute|async\s*\()/g;

/** Known, reviewed exceptions (`file: /admin/path`). Empty today — every admin
 *  route is `requireSystemAdmin`-gated. Add here only with a deliberate reason. */
const ALLOWLIST = new Set<string>([]);

describe('billing /admin route authz governance', () => {
  it('every /admin route is gated by requireSystemAdmin at the route layer', () => {
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
        if (!middleware.includes('requireSystemAdmin') && !ALLOWLIST.has(key)) {
          offenders.push(key);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
