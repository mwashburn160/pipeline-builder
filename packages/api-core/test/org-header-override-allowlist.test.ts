// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0


/**
 * Governance guard for the `allowOrgHeaderOverride` footgun.
 *
 * `requireAuth({ allowOrgHeaderOverride: true })` lets a caller set `x-org-id`
 * to ANY org, overriding the verified JWT — safe ONLY on internal,
 * network-isolated service-to-service routes. If it ever lands on a
 * user-facing route, an end user could impersonate another tenant.
 *
 * This test fails when the flag is enabled in any source file outside the
 * reviewed allowlist below, forcing a deliberate allowlist edit (and the code
 * review that comes with it) before a new use can ship.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from '@jest/globals';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Files allowed to enable the override — all internal/service-to-service. */
const ALLOWLIST = new Set([
  'api/quota/src/middleware/authorize-org.ts',
  'api/billing/src/routes/usage.ts',
  'api/billing/src/routes/admin-subscriptions.ts',
  'api/billing/src/routes/marketplace.ts',
  'api/billing/src/routes/subscriptions.ts',
]);

/** Matches an actual enablement (`allowOrgHeaderOverride: true`), not the
 *  option's declaration (`allowOrgHeaderOverride?: boolean`) or reads. */
const ENABLE_RE = /allowOrgHeaderOverride\s*:\s*true/;

/** Walk up from this test to the monorepo root (dir holding both api + packages). */
function findRepoRoot(): string | null {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'api')) && fs.existsSync(path.join(dir, 'packages'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const SCAN_DIRS = ['api', 'platform', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'lib', '.git', 'coverage']);

function collectTsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(abs, entry.name));
      } else if (
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.d.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !abs.includes(`${path.sep}test`)
      ) {
        out.push(path.join(abs, entry.name));
      }
    }
  };
  for (const d of SCAN_DIRS) {
    const abs = path.join(root, d);
    if (fs.existsSync(abs)) walk(abs);
  }
  return out;
}

describe('allowOrgHeaderOverride governance', () => {
  const root = findRepoRoot();
  // Isolated/published builds won't have the sibling services — skip cleanly.
  const maybe = root ? it : it.skip;

  maybe('is only enabled in reviewed internal route files', () => {
    const offenders: string[] = [];
    for (const file of collectTsFiles(root as string)) {
      if (!ENABLE_RE.test(fs.readFileSync(file, 'utf-8'))) continue;
      const rel = path.relative(root as string, file).split(path.sep).join('/');
      if (!ALLOWLIST.has(rel)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
