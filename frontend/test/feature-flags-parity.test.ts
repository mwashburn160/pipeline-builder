// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-package drift guard: the frontend's feature-flag catalog must match
 * api-core's source of truth EXACTLY.
 *
 * api-core (`src/types/feature-flags.ts`, `ALL_FEATURE_FLAGS`) is the canonical
 * feature-flag catalog. The frontend keeps a hand-maintained mirror in
 * `frontend/src/lib/feature-flags.ts` — it deliberately does NOT import api-core
 * (that package carries Express/JWT server-only code we don't want bundled), so
 * the local copy can silently drift: add/rename/remove a flag in api-core and
 * the frontend override editor / add-on labels / render gates quietly go stale.
 *
 * This mirrors `packages/api-core/test/permission-catalog-parity.test.ts` but in
 * the opposite direction. It can't `import` api-core at runtime (CJS-vs-ESM
 * module-format mismatch across the package boundary), so instead it reads the
 * api-core catalog as source text and extracts the `ALL_FEATURE_FLAGS` array
 * literal. That id set must equal the frontend `ALL_FEATURE_FLAGS` set. A
 * mismatch fails with the exact offending ids, naming which side to fix.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ALL_FEATURE_FLAGS, FEATURE_METADATA } from '../src/lib/feature-flags';

// Locate packages/api-core/src/types/feature-flags.ts relative to this test file.
const apiCoreCatalogPath = resolve(__dirname, '../../packages/api-core/src/types/feature-flags.ts');

/**
 * Extract the flag ids from api-core's `ALL_FEATURE_FLAGS` array literal.
 * Captures only the `[ ... ]` body of that specific `const` declaration so
 * unrelated string literals elsewhere in the file (e.g. the type union or
 * TIER_FEATURES) can't leak in.
 */
function extractApiCoreFlagIds(source: string): string[] {
  const block = /ALL_FEATURE_FLAGS\s*:\s*readonly\s+FeatureFlag\[\]\s*=\s*\[([^\]]*)\]/.exec(source);
  if (!block) return [];
  const ids: string[] = [];
  const re = /'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block[1])) !== null) ids.push(m[1]);
  return ids;
}

describe('frontend ↔ api-core feature-flag catalog parity', () => {
  const source = readFileSync(apiCoreCatalogPath, 'utf8');
  const apiCoreIds = extractApiCoreFlagIds(source);
  const frontendIds = [...ALL_FEATURE_FLAGS];

  it('reads a non-empty api-core catalog (regex still matches the source shape)', () => {
    // Guards against the extraction silently returning [] if the array literal is
    // refactored to a different shape — that would make drift checks vacuously pass.
    expect(apiCoreIds.length).toBeGreaterThan(0);
  });

  it('frontend ALL_FEATURE_FLAGS has no duplicates', () => {
    expect(new Set(frontendIds).size).toBe(frontendIds.length);
  });

  it('frontend flag set === api-core ALL_FEATURE_FLAGS (no drift)', () => {
    // Order-independent equality: any missing OR extra id fails and names it.
    expect([...frontendIds].sort()).toEqual([...apiCoreIds].sort());
  });

  it('reports the exact flags missing from the frontend mirror', () => {
    const feSet = new Set(frontendIds);
    expect(apiCoreIds.filter((id) => !feSet.has(id))).toEqual([]);
  });

  it('reports the exact flags the frontend mirror has but api-core does not', () => {
    const beSet = new Set(apiCoreIds);
    expect(frontendIds.filter((id) => !beSet.has(id))).toEqual([]);
  });

  it('every frontend flag has non-empty label + description metadata', () => {
    for (const id of frontendIds) {
      const meta = FEATURE_METADATA[id];
      expect(meta).toBeDefined();
      expect(meta.label.trim().length).toBeGreaterThan(0);
      expect(meta.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('includes sso (the flag the mirror previously dropped — C6)', () => {
    expect(frontendIds).toContain('sso');
    expect(apiCoreIds).toContain('sso');
  });
});
