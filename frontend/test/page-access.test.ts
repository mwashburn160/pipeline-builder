// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deep-link read gates.
 *
 * The sidebar hides a link the viewer can't use, but a bookmark, a shared URL or
 * a post-login redirect goes straight to the page, which must not render the
 * full chrome and then 403 panel by panel. `src/lib/page-access.ts` declares what every dashboard route requires — derived from the SAME nav entry
 * the sidebar filters on — and `useAuthGuard` applies it.
 *
 * Two things have to stay true for that to hold, and neither is visible in a
 * diff, so they are asserted here:
 *
 *   1. EVERY page under `pages/dashboard/` is declared (a page nobody declared
 *      would silently fall back to "any signed-in user"), and
 *   2. every page whose gate is not open actually RENDERS the denial — a page
 *      that reads `accessDenied` but never renders it would sit on a spinner
 *      forever, which is worse than the bug this replaced.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { resolvePageGate, isOpenGate, declaredPagePaths } from '../src/lib/page-access';

const FRONTEND_DIR = resolve(__dirname, '..');
const PAGES_DIR = resolve(FRONTEND_DIR, 'pages/dashboard');

/** Every page file under pages/dashboard, as {file, pathname}. */
function dashboardPages(): { file: string; pathname: string }[] {
  const out: { file: string; pathname: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!name.endsWith('.tsx')) continue;
      const rel = relative(FRONTEND_DIR, full);
      const pathname = `/${rel.replace(/^pages\//, '').replace(/\.tsx$/, '').replace(/\/index$/, '')}`;
      out.push({ file: rel, pathname });
    }
  };
  walk(PAGES_DIR);
  return out.sort((a, b) => a.pathname.localeCompare(b.pathname));
}

const PAGES = dashboardPages();

describe('every dashboard page declares a read gate', () => {
  it('finds the pages at all (the walker still matches the tree)', () => {
    expect(PAGES.length).toBeGreaterThan(40);
    expect(PAGES.map((p) => p.pathname)).toContain('/dashboard/pipelines');
    expect(PAGES.map((p) => p.pathname)).toContain('/dashboard/pipelines/[id]');
  });

  it('declares every page (nav entry or explicit table entry)', () => {
    const declared = new Set(declaredPagePaths());
    const undeclared = PAGES.filter((p) => !declared.has(p.pathname)).map((p) => p.pathname);
    expect({
      undeclared,
      fix: 'Add the page to NAV_SECTIONS (if it has a nav entry) or to EXTRA_PAGE_GATES in '
        + 'src/lib/page-access.ts — use OPEN when it really is available to any signed-in user.',
    }).toEqual({ undeclared: [], fix: expect.any(String) });
  });

  it('declares no pathname that has no page behind it', () => {
    const real = new Set(PAGES.map((p) => p.pathname));
    // Nav can legitimately point outside pages/dashboard (nothing does today).
    const orphans = declaredPagePaths().filter((p) => !real.has(p));
    expect(orphans).toEqual([]);
  });
});

describe('gated pages render the denial instead of stalling', () => {
  const gated = PAGES.filter((p) => !isOpenGate(resolvePageGate(p.pathname)));

  it('there are gated pages to check', () => {
    expect(gated.length).toBeGreaterThan(20);
  });

  it.each(gated.map((p) => [p.pathname, p.file] as const))('%s renders <AccessDenied>', (_pathname, file) => {
    const source = readFileSync(resolve(FRONTEND_DIR, file), 'utf8');
    expect(source).toContain('accessDenied');
    expect(source).toContain('<AccessDenied denial={accessDenied} />');
  });

  it('open pages do not pretend to be gated', () => {
    // An open page rendering a denial it can never receive is dead code, and a
    // sign someone meant to declare a gate and didn't.
    const open = PAGES.filter((p) => isOpenGate(resolvePageGate(p.pathname)));
    const pretenders = open.filter((p) => readFileSync(resolve(FRONTEND_DIR, p.file), 'utf8').includes('<AccessDenied'));
    expect(pretenders.map((p) => p.pathname)).toEqual([]);
  });
});

describe('explicit useAuthGuard options agree with the declared gate', () => {
  it.each(PAGES.map((p) => [p.pathname, p.file] as const))('%s', (pathname, file) => {
    const source = readFileSync(resolve(FRONTEND_DIR, file), 'utf8');
    const call = /useAuthGuard\(\{([^}]*)\}\)/.exec(source);
    if (!call) return; // no options — the page rides the declared gate alone
    const options = call[1];
    const gate = resolvePageGate(pathname);
    const permission = /requirePermission:\s*'([^']+)'/.exec(options)?.[1];
    // A page may ask for MORE than its nav entry (never less by omission — the
    // guard falls back to the gate), but it must not ask for something DIFFERENT:
    // two disagreeing declarations is exactly the drift this file exists to stop.
    if (permission && gate.permission) expect({ pathname, permission }).toEqual({ pathname, permission: gate.permission });
    if (/requireSystemAdmin:\s*true/.test(options)) expect({ pathname, systemAdminOnly: gate.systemAdminOnly }).toEqual({ pathname, systemAdminOnly: true });
    if (/requireAdmin:\s*true/.test(options)) expect({ pathname, adminOnly: gate.adminOnly }).toEqual({ pathname, adminOnly: true });
  });
});
