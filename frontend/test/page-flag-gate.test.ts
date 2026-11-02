// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A page whose NAV gate is a permission must not gate its own body on the
 * superadmin FLAG.
 *
 * THE DEFECT THIS CLOSES, which has now appeared eight times. A nav entry
 * declares `requiredPermission`, so the link resolves for whoever holds it. The
 * page body then checks `isSuperAdmin` — in an early return, or in the `enabled`
 * of its first fetch — and the holder gets either a spinner that never resolves
 * or a page that renders completely empty. Nothing fails: the route is reachable,
 * the component mounts, the request is simply never made.
 *
 * Found this way: registry (a permanent `<LoadingPage />`), billing admin,
 * build-queue purge, QuotasAdmin, discounts, promotions, All organizations, and
 * `triage` — whose nav gate is `plugins:write`, a MEMBER permission, so every
 * ordinary org member could reach a page that never loaded for them.
 *
 * WHY A SOURCE SCAN. The alternative is a render test per page per Role, which
 * is both enormous and easy to leave incomplete — a page added tomorrow would
 * simply not be covered. The flag is legitimate in plenty of places (a
 * cross-tenant filter, a destructive fleet-wide action, a page that really is
 * sysadmin-only), so every exception is listed below WITH ITS REASON. Adding one
 * is cheap and visible; forgetting to is what this prevents.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { resolvePageGate } from '../src/lib/page-access';

const PAGES_DIR = resolve(__dirname, '..', 'pages', 'dashboard');

/** Every page file under pages/dashboard, with its Next.js pathname. */
function dashboardPages(): Array<{ file: string; pathname: string }> {
  const out: Array<{ file: string; pathname: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.tsx')) continue;
      const rel = relative(PAGES_DIR, full).replace(/\.tsx$/, '');
      const pathname = `/dashboard/${rel === 'index' ? '' : rel}`.replace(/\/$/, '');
      out.push({ file: full, pathname });
    }
  };
  walk(PAGES_DIR);
  return out;
}

/**
 * Uses of `isSuperAdmin` that decide whether the PAGE works at all, as opposed
 * to shaping what it shows. Two shapes, both observed in the wild:
 *
 *  - an early return that swaps the whole body for a loader or nothing;
 *  - the `enabled` of a fetch, which leaves the page rendered and empty.
 */
const PAGE_LEVEL_FLAG_USES: Array<{ label: string; re: RegExp }> = [
  // An early return that swaps the whole body. It must return JSX or `null` —
  // requiring that is what separates a page gate from a helper bailing out:
  // the messages page has `if (!isSuperAdmin || !q) return [];` inside its
  // cross-org recipient search, which is correct and which the first draft of
  // this scan reported. Trusting it would have broken that search.
  { label: 'early return', re: /if\s*\([^)]*!isSuperAdmin[^)]*\)\s*return\s*(?:<|null\b)/ },
  { label: 'fetch enable', re: /enabled:\s*[^,\n]*\bisSuperAdmin\b/ },
  { label: 'fetch enable (const)', re: /const\s+enabled\s*=\s*[^;\n]*\bisSuperAdmin\b/ },
];

/**
 * Pages where a page-level flag check is CORRECT, each with the reason.
 * Keyed by pathname. A page whose gate is `systemAdminOnly` needs no entry —
 * the flag IS its gate, and the scan skips those.
 */
const ALLOWED: Record<string, string> = {
  // No current exceptions. A page gated on a permission that still needs the
  // flag for its whole body almost certainly wants `systemAdminOnly` in nav
  // instead, so that nav hides it rather than offering a link that dead-ends.
};

describe('a permission-gated page does not gate its body on the superadmin flag', () => {
  it('finds no page offering a link its own body refuses', () => {
    const offenders: string[] = [];
    for (const { file, pathname } of dashboardPages()) {
      const gate = resolvePageGate(pathname);
      // Only pages whose gate is a PERMISSION are in scope: a `systemAdminOnly`
      // page is allowed to check the flag (that is its gate), and an ungated one
      // has no promise to break.
      if (!gate.permission || gate.systemAdminOnly) continue;
      if (pathname in ALLOWED) continue;

      const src = readFileSync(file, 'utf8');
      for (const { label, re } of PAGE_LEVEL_FLAG_USES) {
        if (re.test(src)) {
          offenders.push(
            `${pathname} (gate: ${gate.permission}) gates its body on isSuperAdmin via a ${label} — `
            + 'the nav link resolves for the permission holder and the page then refuses them. '
            + `Gate on can('${gate.permission}'), or declare the page systemAdminOnly so nav hides it.`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('carries no stale exception', () => {
    const live = new Set(dashboardPages().map((p) => p.pathname));
    expect(Object.keys(ALLOWED).filter((p) => !live.has(p))).toEqual([]);
  });

  // The scan is only worth anything if it can see the shapes it claims to.
  it('detects each page-level shape it is written to catch', () => {
    const samples = [
      'if (!isReady || !isSuperAdmin) return <LoadingPage />;',
      'enabled: isAuthenticated && isSuperAdmin,',
      'const enabled = isReady && isSuperAdmin;',
    ];
    for (const sample of samples) {
      expect({ sample, caught: PAGE_LEVEL_FLAG_USES.some((s) => s.re.test(sample)) })
        .toEqual({ sample, caught: true });
    }
    // And does NOT fire on the legitimate uses: a cross-tenant filter, a
    // conditional sub-view, a badge, or a HELPER bailing out — the last of
    // which is a real line from the messages page's recipient search.
    for (const sample of [
      '...(isSuperAdmin && orgId ? { orgId } : {}),',
      'isSuperAdmin ? <Badge>All</Badge> : <Badge>Mine</Badge>',
      'canBreakglass={isSuperAdmin}',
      'if (!isSuperAdmin || !q) return [];',
    ]) {
      expect({ sample, caught: PAGE_LEVEL_FLAG_USES.some((s) => s.re.test(sample)) })
        .toEqual({ sample, caught: false });
    }
  });
});
