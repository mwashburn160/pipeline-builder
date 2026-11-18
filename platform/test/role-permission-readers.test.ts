// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Guard: a Role's permissions are read ONLY through `effectiveRolePermissions`
 * (services/role-authority.ts).
 *
 * A built-in (`system`) Role stores no permission list — its grant is resolved
 * from the api-core catalog at read time, so a release's catalog change reaches
 * every org on the next token refresh. A reader that goes straight to
 * `role.permissions` would see the empty stored list and silently under-grant
 * (or, for a hand-written document, honour a stale copy), so this walks
 * platform/src and refuses the three shapes that bypass the resolver:
 *
 *   1. a `.select('… permissions …')` literal in a file that queries Role —
 *      it must select `ROLE_PERMISSION_FIELDS`, which carries `system`,
 *      `grantsRole` and `seedBundle` alongside the stored list;
 *   2. a `<something>role<something>.permissions` (or `r.`/`g.`) access in such
 *      a file;
 *   3. a Mongo query that FILTERS Roles by `permissions:` (it cannot see a
 *      built-in Role's catalog grant).
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from '@jest/globals';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const RESOLVER_FILE = path.join('services', 'role-authority.ts');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/** Whether `source` imports the Role model (named from the barrel, or the default export). */
function importsRoleModel(source: string): boolean {
  return /import\s*\{[^}]*\bRole\b[^}]*\}\s*from\s*'[^']*models\/index\.js'/.test(source)
    || /import\s+Role\b[^;]*from\s*'[^']*models\/role\.js'/.test(source);
}

/** The lines of `source` that bypass the resolver, as `line: text`. */
function bypasses(source: string): string[] {
  const hits: string[] = [];
  source.split('\n').forEach((text, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) return; // comments
    const handSelect = /\.select\(\s*(['"`])(?:(?!\1).)*\bpermissions\b/.test(text);
    const directRead = /\b(?:[A-Za-z_$]*[Rr]ole[A-Za-z_$]*|[rg])\??\.permissions\b/.test(text);
    const queryByPermission = /\bRole\.\w+\(\s*\{[^}]*\bpermissions\s*:/.test(text);
    if (handSelect || directRead || queryByPermission) hits.push(`${i + 1}: ${text.trim()}`);
  });
  return hits;
}

describe('Role permissions are read only through effectiveRolePermissions', () => {
  const files = walk(SRC)
    .filter((f) => path.relative(SRC, f) !== RESOLVER_FILE)
    .filter((f) => importsRoleModel(readFileSync(f, 'utf8')));

  it('finds the Role readers', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map((f) => path.relative(SRC, f)))('%s reads no Role permissions directly', (rel) => {
    expect(bypasses(readFileSync(path.join(SRC, rel), 'utf8'))).toEqual([]);
  });

  it('detects each bypass shape (self-check)', () => {
    expect(bypasses("Role.find({}).select('name permissions').lean();")).toHaveLength(1);
    expect(bypasses('assertActorMayAssignRole(role.permissions, actor);')).toHaveLength(1);
    expect(bypasses('assertActorMayAssignRole(adminRole?.permissions, actor);')).toHaveLength(1);
    expect(bypasses('const p = (g.permissions as string[]) ?? [];')).toHaveLength(1);
    expect(bypasses('await Role.find({ organizationId: oid, permissions: p }).lean();')).toHaveLength(1);
    // The sanctioned shapes pass.
    expect(bypasses('Role.find({}).select(`name ${ROLE_PERMISSION_FIELDS}`).lean();')).toEqual([]);
    expect(bypasses('assertActorMayAssignRole(effectiveRolePermissions(role), actor);')).toEqual([]);
    expect(bypasses('const subset = input.permissions ?? actor.permissions;')).toEqual([]);
    expect(importsRoleModel("import { Role, RoleAssignment } from '../models/index.js';")).toBe(true);
    expect(importsRoleModel("import { RoleAssignment } from '../models/index.js';")).toBe(false);
  });
});
