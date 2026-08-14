// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-package drift guard: the frontend's permission catalog must match
 * api-core's source of truth EXACTLY.
 *
 * api-core (`src/types/permissions.ts`, `ALL_PERMISSIONS`) is the canonical
 * permission catalog. The frontend keeps a hand-maintained mirror in
 * `frontend/src/lib/permissions.ts` (`PERMISSION_CATALOG`) — it deliberately
 * does NOT import this package, so the Next.js bundle never pulls in server-only
 * code (express/jwt). That local copy can silently drift: add/rename/remove a
 * permission in api-core and the frontend picker/gating quietly goes stale, and
 * nothing catches it.
 *
 * This test lives in api-core so it can see `ALL_PERMISSIONS` directly. It can't
 * `import` the frontend file at runtime — that package is CommonJS while this
 * package's jest runs ESM, so a cross-package TS import mismatches module
 * formats — so instead it reads the frontend catalog as source text and extracts
 * the `id: '<perm>'` literals. That id set must equal api-core's `ALL_PERMISSIONS`
 * set. A mismatch fails with the exact offending ids, naming which side to fix.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_PERMISSIONS,
  SUPERADMIN_ONLY_PERMISSIONS,
  ORG_ASSIGNABLE_PERMISSIONS,
  ROLE_PERMISSIONS,
  isOrgAssignablePermission,
} from '../src/types/permissions.js';

// Locate frontend/src/lib/permissions.ts relative to this test file.
const here = dirname(fileURLToPath(import.meta.url));
const frontendCatalogPath = resolve(here, '../../../frontend/src/lib/permissions.ts');

/**
 * Extract the permission ids from the frontend PERMISSION_CATALOG source. Every
 * catalog entry is `{ id: 'resource:action', ... }`; the `id:` key appears
 * nowhere else in the file, so this regex captures exactly the catalog set.
 */
function extractFrontendIds(source: string): string[] {
  const ids: string[] = [];
  const re = /\bid:\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) ids.push(m[1]);
  return ids;
}

/**
 * Extract the quoted ids from the frontend `SUPERADMIN_ONLY_PERMISSIONS` array
 * literal. Captures only the `[ ... ]` body of that specific declaration so
 * unrelated string literals elsewhere in the file can't leak in.
 */
function extractSuperadminOnlyIds(source: string): string[] {
  const block = /SUPERADMIN_ONLY_PERMISSIONS\s*:\s*readonly\s+string\[\]\s*=\s*\[([^\]]*)\]/.exec(source);
  if (!block) return [];
  const ids: string[] = [];
  const re = /'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block[1])) !== null) ids.push(m[1]);
  return ids;
}

describe('frontend ↔ api-core permission catalog parity', () => {
  const source = readFileSync(frontendCatalogPath, 'utf8');
  const frontendIds = extractFrontendIds(source);
  const backendIds = [...ALL_PERMISSIONS];
  const frontendSuperadminOnly = extractSuperadminOnlyIds(source);
  // What the authoring picker offers: the catalog minus the superadmin-only
  // mirror — the same derivation the frontend's ORG_ASSIGNABLE_CATEGORIES uses.
  const superadminOnlySet = new Set(frontendSuperadminOnly);
  const frontendPickerIds = frontendIds.filter((id) => !superadminOnlySet.has(id));

  it('reads a non-empty frontend catalog (regex still matches the source shape)', () => {
    // Guards against the extraction silently returning [] if the catalog is
    // refactored to a different literal shape — that would make drift checks
    // vacuously pass.
    expect(frontendIds.length).toBeGreaterThan(0);
  });

  it('frontend catalog has no duplicate ids', () => {
    expect(new Set(frontendIds).size).toBe(frontendIds.length);
  });

  it('frontend catalog id set === api-core ALL_PERMISSIONS (no drift)', () => {
    // Order-independent equality: any missing OR extra id fails and names it.
    expect([...frontendIds].sort()).toEqual([...backendIds].sort());
  });

  it('reports the exact ids missing from the frontend mirror', () => {
    const feSet = new Set(frontendIds);
    expect(backendIds.filter((id) => !feSet.has(id))).toEqual([]);
  });

  it('reports the exact ids the frontend mirror has but api-core does not', () => {
    const beSet = new Set<string>(backendIds);
    expect(frontendIds.filter((id) => !beSet.has(id))).toEqual([]);
  });

  it('frontend SUPERADMIN_ONLY_PERMISSIONS mirror === api-core SUPERADMIN_ONLY_PERMISSIONS', () => {
    // The regex must still match the mirror's array-literal shape (guards against
    // a silent [] that would make the equality vacuous).
    expect(frontendSuperadminOnly.length).toBe(SUPERADMIN_ONLY_PERMISSIONS.length);
    expect([...frontendSuperadminOnly].sort()).toEqual([...SUPERADMIN_ONLY_PERMISSIONS].sort());
  });

  it('the picker offers exactly api-core ORG_ASSIGNABLE_PERMISSIONS (excludes superadmin-only)', () => {
    expect([...frontendPickerIds].sort()).toEqual([...ORG_ASSIGNABLE_PERMISSIONS].sort());
  });

  it('the picker offers none of the superadmin-only ids', () => {
    expect(frontendPickerIds.filter((id) => superadminOnlySet.has(id))).toEqual([]);
  });
});

describe('org:settings split → org:idp / org:kms (C3)', () => {
  const SPLIT: ReadonlyArray<'org:idp' | 'org:kms'> = ['org:idp', 'org:kms'];

  it('adds org:idp and org:kms to the canonical catalog', () => {
    for (const p of SPLIT) expect(ALL_PERMISSIONS).toContain(p);
    // The original general-settings capability is retained (not renamed).
    expect(ALL_PERMISSIONS).toContain('org:settings');
  });

  it('both new caps are org-assignable (not superadmin-only)', () => {
    for (const p of SPLIT) {
      expect(SUPERADMIN_ONLY_PERMISSIONS).not.toContain(p);
      expect(ORG_ASSIGNABLE_PERMISSIONS).toContain(p);
      expect(isOrgAssignablePermission(p)).toBe(true);
    }
  });

  it('seeds org:idp and org:kms into the admin and owner bundles (no admin lockout)', () => {
    for (const p of SPLIT) {
      expect(ROLE_PERMISSIONS.admin).toContain(p);
      expect(ROLE_PERMISSIONS.owner).toContain(p);
    }
  });

  it('does NOT grant the sensitive caps to the member bundle', () => {
    for (const p of SPLIT) expect(ROLE_PERMISSIONS.member).not.toContain(p);
  });
});
