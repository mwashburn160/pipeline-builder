// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The permission contract: a human-stated record of what each gated route
 * requires, checked against the generated route tables.
 *
 * WHY THIS EXISTS. `frontend/src/generated/route-table/<service>.json` is
 * generated from the routes, and each service's route-coverage test rewrites it
 * with `UPDATE_ROUTE_TABLES=1`. That makes permission WEAKENING invisible in
 * review: relax a gate, regenerate, and the diff shows the table agreeing with
 * the code. Nothing anywhere says "this route got easier to reach".
 *
 * `docs/permission-contract.md` is the counterpart a human writes. It has NO
 * regenerate flag on purpose. When a gate changes, this test fails and names the
 * exact line to edit — so the weakening has to be stated, by hand, in the same
 * commit, where a reviewer can see it.
 *
 * The comparison covers the whole authorization posture, not just `permissions`:
 * assurance level, step-up, entitlement, scope and internal-caller list are all
 * things that can be quietly relaxed.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const TABLE_DIR = resolve(ROOT, 'frontend/src/generated/route-table');
const CONTRACT = resolve(ROOT, 'docs/permission-contract.md');

interface PermissionGate { mode: 'any' | 'all'; permissions: string[]; allowService: boolean }
interface RouteEntry {
  method: string; path: string; auth: boolean;
  permissions: PermissionGate[];
  systemAdmin: boolean; servicePrincipal: boolean; internalCallers: string[];
  stepUp: boolean; stepUpMethods: string[]; minAssurance: number;
  /** Named carve-outs the assurance gate allows (see AssuranceOptions.exempt). */
  assuranceExempt?: string[];
  features: string[]; scopes: string[]; orgAdminAssurance?: boolean;
}

/**
 * Canonical one-line rendering of everything a route demands of its caller.
 * Must stay in step with the "Notation" table in docs/permission-contract.md.
 */
function authorizationOf(e: RouteEntry): string {
  const parts: string[] = [];
  if (e.systemAdmin) parts.push('sysadmin');
  for (const g of e.permissions ?? []) {
    parts.push(`${g.mode}(${[...g.permissions].sort().join('|')})${g.allowService ? '+svc' : ''}`);
  }
  if (e.servicePrincipal) parts.push('service-principal');
  if (e.internalCallers?.length) parts.push(`internal(${[...e.internalCallers].sort().join(',')})`);
  if (e.features?.length) parts.push(`feature(${[...e.features].sort().join(',')})`);
  if (e.scopes?.length) parts.push(`scope(${[...e.scopes].sort().join(',')})`);
  if (e.minAssurance > 0) {
    // An exemption is rendered INTO the token, so a route that stops demanding
    // the level from some class of caller cannot pass this test on the old line.
    const except = e.assuranceExempt?.length ? `(except ${[...e.assuranceExempt].sort().join(',')})` : '';
    parts.push(`aal${e.minAssurance}${except}`);
  }
  if (e.stepUp) parts.push(`step-up(${[...(e.stepUpMethods ?? [])].sort().join(',') || 'any'})`);
  if (e.orgAdminAssurance) parts.push('org-admin-assurance');
  if (parts.length === 0) return e.auth ? 'authenticated' : 'public';
  return parts.join(' + ');
}

/** A route is in scope for the contract once it enforces ANY caller identity. */
function isGated(e: RouteEntry): boolean {
  return (e.permissions?.length ?? 0) > 0 || e.systemAdmin || e.servicePrincipal
    || (e.internalCallers?.length ?? 0) > 0;
}

const routeKey = (service: string, method: string, path: string) => `${service} ${method} ${path}`;

/** Every gated route, from the generated tables. */
function actualRoutes(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of readdirSync(TABLE_DIR).sort()) {
    const service = file.replace(/\.json$/, '');
    const table: RouteEntry[] = JSON.parse(readFileSync(resolve(TABLE_DIR, file), 'utf8'));
    for (const e of table) {
      if (isGated(e)) out.set(routeKey(service, e.method, e.path), authorizationOf(e));
    }
  }
  return out;
}

/** Every row of the hand-maintained contract table. */
function contractRoutes(): Map<string, string> {
  const md = readFileSync(CONTRACT, 'utf8');
  const out = new Map<string, string>();
  for (const line of md.split('\n')) {
    // | service | METHOD | `/path` | `authorization` |
    const m = line.match(/^\|\s*([a-z-]+)\s*\|\s*([A-Z]+)\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|$/);
    if (m) out.set(routeKey(m[1], m[2], m[3]), m[4]);
  }
  return out;
}

const FIX = 'Edit docs/permission-contract.md by hand and state the new requirement. '
  + 'There is deliberately no regenerate flag: the hand edit is what makes the change reviewable.';

describe('permission contract ↔ generated route tables', () => {
  const actual = actualRoutes();
  const contract = contractRoutes();

  it('parses a contract with a row for every gated route (guards the regex itself)', () => {
    // If the table format drifts and the regex silently matches nothing, every
    // other assertion here would pass vacuously. Pin a realistic floor.
    expect(contract.size).toBeGreaterThan(300);
    expect(actual.size).toBeGreaterThan(300);
  });

  it('has no gated route missing from the contract', () => {
    const missing = [...actual.keys()].filter((k) => !contract.has(k)).sort();
    expect({ missing, fix: missing.length ? FIX : undefined })
      .toEqual({ missing: [], fix: undefined });
  });

  it('has no contract row for a route that no longer exists', () => {
    const stale = [...contract.keys()].filter((k) => !actual.has(k)).sort();
    expect({ stale, fix: stale.length ? `Remove these rows. ${FIX}` : undefined })
      .toEqual({ stale: [], fix: undefined });
  });

  it('agrees with every route on what it requires — a weakening fails HERE', () => {
    const disagreements = [...actual.entries()]
      .filter(([k]) => contract.has(k))
      .filter(([k, required]) => contract.get(k) !== required)
      .map(([k, required]) => ({ route: k, contractSays: contract.get(k), routeRequires: required }))
      .sort((a, b) => a.route.localeCompare(b.route));

    expect({ disagreements, fix: disagreements.length ? FIX : undefined })
      .toEqual({ disagreements: [], fix: undefined });
  });

  it('documents every notation token it uses', () => {
    // A row whose rendering uses a token the doc never explains is unreviewable.
    const md = readFileSync(CONTRACT, 'utf8');
    const notation = md.slice(0, md.indexOf('| Service |'));
    const tokens = new Set<string>();
    for (const value of actual.values()) {
      for (const part of value.split(' + ')) {
        tokens.add(part.replace(/\([^)]*\)/, '(…)').replace(/aal\d+/, 'aalN'));
      }
    }
    const undocumented = [...tokens].filter((t) => {
      const stem = t.replace(/\(…\)/, '').replace(/\+svc$/, '');
      return !notation.includes(stem);
    }).sort();
    expect(undocumented).toEqual([]);
  });
});
