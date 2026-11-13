// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolver coverage (docs/plans/bootstrap-image-versioning.md §2, §13): a
 * managed toolchain name (`pipeline-bootstrap`, `cdk-synth`) resolves through
 * `resolveManagedToolchain` and NOTHING else. The generic resolvers would answer
 * it wrongly — a listing resolution never finds it (D5), and the owner-ranked
 * row query (`pluginResolutionOrderBy`) would hand a system-org caller the
 * HIGHEST unpromoted release (managed rows never set `isDefault`), which D11
 * forbids, or a customer a same-named row.
 *
 * So every call site of `resolveListingReference`, `selectListingVersion` and
 * `pluginResolutionOrderBy` — plus the row branch of `/plugins/lookup`
 * (`pluginService.findFirst`) — is enumerated from the source tree and must be a
 * REVIEWED site below. A new one fails this suite until someone decides how it
 * keeps managed names out, and records it here:
 *
 *   - `guard`: the file routes a managed name to the toolchain resolver (or
 *     refuses it) before the generic call — it must contain one of the guard
 *     tokens;
 *   - `excludes`: the query filters managed names out (must contain the token);
 *   - `unreachable`: the call can't see a managed name, for the stated reason.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, expect } from '@jest/globals';
import { REPO_ROOT, read } from '../src/index.js';

/** The generic resolution entry points a managed name must never reach. */
const CALLS = ['resolveListingReference', 'selectListingVersion', 'pluginResolutionOrderBy', 'pluginService.findFirst', 'this.findFirst'] as const;
type Call = typeof CALLS[number];

/** What proves a file routes managed names to the toolchain resolver first. */
const GUARD_TOKENS = ['isManagedToolchainPlugin(', 'managedToolchainRefName(', 'assertNotManaged('];

interface ReviewedSite {
  file: string;
  call: Call;
  /** Call sites of `call` in `file`. */
  count: number;
  how: 'guard' | 'excludes' | 'unreachable';
  /** For `excludes`: the token the exclusion uses. */
  token?: string;
  reason: string;
}

const REVIEWED: ReviewedSite[] = [
  // pipeline-data: the listing resolver itself.
  {
    file: 'packages/pipeline-data/src/api/plugin-resolution.ts',
    call: 'selectListingVersion',
    count: 2,
    how: 'unreachable',
    reason: 'inside the LISTING resolver (resolveListingReference / orgListingStates): managed names are never listed (D5, PLUGIN_MANAGED_NOT_LISTABLE), so no listing version of one exists',
  },

  // /plugins/lookup + /plugins/find: the managed branch returns before the row and listing branches.
  {
    file: 'api/plugin/src/routes/read-plugins.ts',
    call: 'pluginService.findFirst',
    count: 2,
    how: 'guard',
    reason: 'respondWithSinglePlugin answers a managed name from resolveManagedToolchain and returns before the row branch',
  },
  {
    file: 'api/plugin/src/services/ecosystem/lookup.ts',
    call: 'resolveListingReference',
    count: 2,
    how: 'unreachable',
    reason: 'resolveListedLookup / shadowedListing are called only from read-plugins.ts after its managed branch returned',
  },
  {
    file: 'api/plugin/src/services/plugin-service.ts',
    call: 'pluginResolutionOrderBy',
    count: 1,
    how: 'unreachable',
    reason: 'findFirstOrderBy: the ranking behind pluginService.findFirst, whose callers are reviewed here (each guards managed names first)',
  },
  {
    file: 'api/plugin/src/services/plugin-service.ts',
    call: 'this.findFirst',
    count: 1,
    how: 'guard',
    reason: 'assertRemovable suggests a version for delete / purge, which refuse managed names first (assertNotManaged, TOOLCHAIN_USE_CONSOLE)',
  },

  // Declared-resolution refresh (api/plugin).
  {
    file: 'api/plugin/src/services/declared-resolution-refresh.ts',
    call: 'pluginService.findFirst',
    count: 1,
    how: 'guard',
    reason: 'resolveAsLookup routes a managed name to resolveManagedToolchainHalf with the pipeline\'s toolchain.release',
  },
  {
    file: 'api/plugin/src/services/declared-resolution-refresh.ts',
    call: 'resolveListingReference',
    count: 1,
    how: 'guard',
    reason: 'same function, after the managed branch returned',
  },

  // Similar-plugin lookup (AI generator hint).
  {
    file: 'api/plugin/src/services/similar-plugin-lookup.ts',
    call: 'pluginResolutionOrderBy',
    count: 1,
    how: 'excludes',
    token: 'MANAGED_TOOLCHAIN_PLUGINS',
    reason: 'the candidate query filters out both managed names',
  },

  // Pipeline contract check (api/pipeline) — also plugin upgrades and the declared side at save.
  {
    file: 'api/pipeline/src/helpers/plugin-contract-check.ts',
    call: 'pluginResolutionOrderBy',
    count: 1,
    how: 'guard',
    reason: 'resolveOwnRow is called only by resolveContractPlugin, which routes a managed name to resolveManagedToolchainHalf first',
  },
  {
    file: 'api/pipeline/src/helpers/plugin-contract-check.ts',
    call: 'resolveListingReference',
    count: 1,
    how: 'guard',
    reason: 'resolveContractPlugin, after its managed branch returned',
  },

  // Compliance step facts (api/compliance): row path and listing path.
  {
    file: 'api/compliance/src/helpers/pipeline-step-facts.ts',
    call: 'pluginResolutionOrderBy',
    count: 1,
    how: 'guard',
    reason: 'resolveStepPlugin routes a managed name to resolveManagedToolchainHalf before the row query',
  },
  {
    file: 'api/compliance/src/helpers/pipeline-step-facts.ts',
    call: 'resolveListingReference',
    count: 1,
    how: 'guard',
    reason: 'resolveStepPlugin, after its managed branch returned',
  },
];

/** Source roots that hold service / library code (tests, builds and bundles excluded). */
const ROOTS = ['api', 'packages', 'platform'];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'lib' || entry === 'dist' || entry === 'test' || entry === 'coverage' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) sourceFiles(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.d.ts') && full.includes(`${'/'}src${'/'}`)) out.push(full);
  }
  return out;
}

/** Call sites of `call` in `text`: invocations, not definitions, imports or comments. */
function callSites(text: string, call: Call): number {
  const escaped = call.replace(/\./g, '\\.');
  // `foo(` not preceded by an identifier char or a member access (`x.foo(`,
  // so `this.findFirst` and `pluginService.findFirst` match only as written);
  // a spread (`...foo(`) counts.
  const re = new RegExp(`(?<![\\w\\])]\\.)(?<!\\w)${escaped}\\s*\\(`, 'g');
  let n = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    if (/\bfunction\s+\w+\s*[(<]/.test(trimmed) && new RegExp(`function\\s+${escaped}\\b`).test(trimmed)) continue;
    if (/^(async\s+)?\w+\s*\(.*\)\s*(:\s*[^=]+)?\{\s*$/.test(trimmed) && trimmed.startsWith(call)) continue;
    n += (line.match(re) ?? []).length;
  }
  return n;
}

function enumerate(): Map<string, number> {
  const found = new Map<string, number>();
  for (const root of ROOTS) {
    for (const file of sourceFiles(join(REPO_ROOT, root))) {
      const rel = relative(REPO_ROOT, file);
      const text = read(rel);
      for (const call of CALLS) {
        const n = callSites(text, call);
        if (n > 0) found.set(`${rel} :: ${call}`, n);
      }
    }
  }
  return found;
}

describe('toolchain resolver coverage: generic resolution never answers a managed name', () => {
  const found = enumerate();

  it('finds the known call sites (the scan itself works)', () => {
    expect(found.size).toBeGreaterThanOrEqual(10);
    expect(found.get('api/plugin/src/routes/read-plugins.ts :: pluginService.findFirst')).toBeGreaterThan(0);
  });

  it('every call site is a reviewed site, with the reviewed count', () => {
    const reviewed = new Map(REVIEWED.map((r) => [`${r.file} :: ${r.call}`, r.count]));
    const unreviewed = [...found].filter(([key, n]) => reviewed.get(key) !== n)
      .map(([key, n]) => `${key} (${n} call site${n === 1 ? '' : 's'}; reviewed: ${reviewed.get(key) ?? 'none'})`);
    const gone = [...reviewed.keys()].filter((key) => !found.has(key));
    // A new or changed site: route managed names to resolveManagedToolchain
    // (or exclude them), then record the site in REVIEWED with its reason.
    expect(unreviewed).toEqual([]);
    expect(gone).toEqual([]);
  });

  it.each(REVIEWED.filter((r) => r.how !== 'unreachable').map((r) => [`${r.file} :: ${r.call}`, r] as const))('%s keeps managed names out', (_key, site) => {
    const text = read(site.file);
    if (site.how === 'excludes') {
      expect(text).toContain(site.token);
      return;
    }
    expect(GUARD_TOKENS.some((t) => text.includes(t))).toBe(true);
  });

  it('the guarded callers route to the toolchain resolver, not just a name test', () => {
    for (const file of [
      'api/plugin/src/routes/read-plugins.ts',
      'api/plugin/src/services/declared-resolution-refresh.ts',
      'api/pipeline/src/helpers/plugin-contract-check.ts',
      'api/compliance/src/helpers/pipeline-step-facts.ts',
    ]) {
      expect(read(file)).toMatch(/resolveManagedToolchain(Half)?\(/);
    }
  });

  it('plugin upgrades never offer a managed step', () => {
    const text = read('api/pipeline/src/helpers/plugin-upgrades.ts');
    expect(text).toMatch(/if \(managedToolchainRefName\(step\)\) continue;/);
  });

  it('the AI catalog and similar-plugin lookup never offer the build image', () => {
    expect(read('api/pipeline/src/services/plugin-catalog.ts')).toMatch(/BUILD_IMAGE/);
    expect(read('api/plugin/src/services/similar-plugin-lookup.ts')).toMatch(/notInArray\(schema\.plugin\.name, \[\.\.\.MANAGED_TOOLCHAIN_PLUGINS\]\)/);
  });
});
