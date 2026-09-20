// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Permission-enforcement coverage.
 *
 * "Is permission X actually enforced?" must be answerable by reading the source,
 * not by running the app. Four call shapes consume a permission id — a route
 * gate (`requirePermission`), a controller branch (`userHasPermission`), and the
 * two visibility helpers (`resolveVisibility`, `requireVisibilityWriteAccess`) —
 * so a grep for route gates alone wrongly reported `templates:publish` as
 * unenforced. `PERMISSION_GATES` is the closed set of those entry points; this
 * test enumerates the catalog against it and fails if any permission has no
 * enforcement site at all.
 *
 * It is deliberately a REPORT as well as an assertion: the failure message names
 * the orphaned permission, and `--verbose` prints each permission's sites.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';
import { ALL_PERMISSIONS, PERMISSION_GATES } from '../src/types/permissions.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/** Where enforcement can live: every service, the platform, and the packages. */
function sourceRoots(): string[] {
  const roots = [join(REPO_ROOT, 'platform', 'src')];
  for (const group of ['api', 'packages']) {
    const dir = join(REPO_ROOT, group);
    for (const entry of readdirSync(dir)) {
      const src = join(dir, entry, 'src');
      try {
        if (statSync(src).isDirectory()) roots.push(src);
      } catch { /* not a source project */ }
    }
  }
  return roots;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const GATE_CALL = new RegExp(`\\b(?:${PERMISSION_GATES.join('|')})\\s*\\(`);

/**
 * Map each permission to the files that enforce it. A site is a permission
 * LITERAL appearing inside an open call to one of the gates — the same argument
 * list, so an unrelated string elsewhere in the file is not counted.
 */
function enforcementSites(): Map<string, string[]> {
  const sites = new Map<string, string[]>(ALL_PERMISSIONS.map((p) => [p, []]));
  for (const root of sourceRoots()) {
    for (const file of walk(root)) {
      // The catalog itself lists every id; it enforces nothing.
      if (file.endsWith(join('types', 'permissions.ts'))) continue;
      const text = readFileSync(file, 'utf8');
      const rel = file.slice(REPO_ROOT.length + 1);
      for (const permission of ALL_PERMISSIONS) {
        const literal = `'${permission}'`;
        let from = text.indexOf(literal);
        while (from !== -1) {
          // Walk back to the start of the statement; a gate call opened in that
          // window means this literal is one of its arguments.
          const stmt = text.slice(Math.max(0, from - 300), from).split(';').pop() ?? '';
          if (GATE_CALL.test(stmt)) {
            const found = sites.get(permission)!;
            if (!found.includes(rel)) found.push(rel);
          }
          from = text.indexOf(literal, from + literal.length);
        }
      }
    }
  }
  return sites;
}

describe('permission enforcement coverage', () => {
  const sites = enforcementSites();

  it('scans real source files (guards the scanner itself)', () => {
    expect(sourceRoots().length).toBeGreaterThan(5);
    // A route-gated permission and a visibility-helper-gated one: if the
    // scanner only understood route gates, the second would come back empty.
    expect(sites.get('dashboards:write')!.length).toBeGreaterThan(0);
    expect(sites.get('templates:publish')!.length).toBeGreaterThan(0);
  });

  it('enforces every permission in the catalog somewhere', () => {
    const orphaned = ALL_PERMISSIONS.filter((p) => sites.get(p)!.length === 0);
    // A permission nobody checks is either dead catalog entry or a missing gate
    // — both are bugs. Grant it somewhere, or delete it from the catalog.
    expect(orphaned).toEqual([]);
  });

  it('reports each permission with its enforcement sites', () => {
    const report = ALL_PERMISSIONS.map((p) => `${p}: ${sites.get(p)!.length} site(s)`);
    expect(report).toHaveLength(ALL_PERMISSIONS.length);
    // Printed on demand (`--verbose`) so the coverage map is inspectable
    // without running the app.
    if (process.env.PERMISSION_COVERAGE_REPORT === '1') {
      for (const permission of ALL_PERMISSIONS) {
        // eslint-disable-next-line no-console
        console.log(`${permission}\n  ${sites.get(permission)!.join('\n  ') || '(none)'}`);
      }
    }
  });
});
