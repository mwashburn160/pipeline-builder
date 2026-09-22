// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-coverage checks + the generated route table each service publishes.
 *
 * One test per service builds its app's {@link RouteTableEntry} list (see
 * `middleware/route-table.ts`) and runs it through {@link findRouteCoverageViolations}:
 *
 *   - a WRITE route (anything but GET/HEAD/OPTIONS) must carry a permission
 *     gate (or `requireSystemAdmin`, or `requireInternalService`) AND declare
 *     its audit action via `audited()`;
 *   - a READ route must carry one of those gates;
 *   - a route with a permission gate must also run `requireAuth`;
 *   - an `/internal/…` path must be gated by `requireInternalService` (#14),
 *     with no exception list — a peer-service API a browser can reach is the
 *     failure this rule exists to prevent. {@link findInternalRouteViolations}
 *     then checks each service's internal routes against the caller list it
 *     declares (the same list the Istio policies name);
 *   - a route gated on a SYSTEM-ORG-ONLY ecosystem permission must also run
 *     `requireSystemOrg` and require an MFA-grade session
 *     ({@link findSystemOrgGuardViolations}, plugin-ecosystem §3.0).
 *
 * Anything that legitimately can't satisfy a rule — health/metrics probes, signed
 * webhooks, public auth endpoints, internal service-principal hooks, handler-level
 * dynamic authorization — goes in the service's `exceptions` list with an explicit
 * reason. Exceptions are themselves checked: one that no longer waives a real
 * violation fails the test, so the allowlist can't rot into a rubber stamp.
 *
 * `assertRouteTableSnapshot` writes/compares the table the frontend imports
 * (`frontend/src/generated/route-table/<service>.json`), so the UI's `can(...)`
 * checks are tested against the permissions the routes actually require.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isWriteMethod, type RouteTableEntry } from '../middleware/route-table.js';
import { isSystemOrgOnlyPermission } from '../types/permissions.js';

/** A rule a route is allowed not to satisfy, with the reason it is exempt. */
export interface RouteCoverageException {
  /** HTTP method, or '*' for any. */
  method?: string;
  /** Exact route path, or a pattern matched against `METHOD /path`. */
  path: string | RegExp;
  /** Which rule is waived: the permission gate, the audit declaration, or both. */
  waive: 'permission' | 'audit' | 'all';
  /** Why this route can't carry the gate/audit. Required — no silent allowlisting. */
  reason: string;
  /**
   * Skip the staleness check for this entry. Only for the shared
   * {@link INFRA_ROUTE_EXCEPTIONS}, whose routes depend on per-service
   * `createApp` options (OpenAPI docs, log stream) — a service that doesn't
   * enable them would otherwise fail on an "unused" shared exception.
   */
  optional?: boolean;
}

/**
 * Exceptions every service inherits from `createApp`'s infrastructure routes:
 * unauthenticated probes, the service-principal-gated warm-up, the metrics
 * scrape endpoint, the OpenAPI docs, and the ticket-gated SSE log stream.
 */
export const INFRA_ROUTE_EXCEPTIONS: readonly RouteCoverageException[] = [
  { path: '/health', waive: 'all', optional: true, reason: 'Liveness probe — must answer before auth is possible.' },
  { path: '/ready', waive: 'all', optional: true, reason: 'Readiness probe — must answer before dependencies connect.' },
  { path: '/metrics', waive: 'all', optional: true, reason: 'Prometheus scrape; gated by METRICS_SCRAPE_TOKEN when set, never by a user permission.' },
  { path: '/warmup', waive: 'all', optional: true, reason: 'Pool warm-up; verifies a signed service principal inline (404s everyone else).' },
  { path: '/docs/openapi.json', waive: 'all', optional: true, reason: 'Public API description; disabled in production.' },
  { path: /^GET \/docs/, waive: 'all', optional: true, reason: 'Swagger UI assets; disabled in production.' },
  { path: /^(GET|POST) \/logs/, waive: 'all', optional: true, reason: 'Build-log SSE stream + its ticket mint — authorized by a single-use, org-bound ticket.' },
];

function matches(e: RouteCoverageException, entry: RouteTableEntry): boolean {
  if (e.method && e.method !== '*' && e.method.toUpperCase() !== entry.method) return false;
  if (typeof e.path === 'string') return e.path === entry.path;
  return e.path.test(`${entry.method} ${entry.path}`);
}

function isGated(entry: RouteTableEntry): boolean {
  // An INTERNAL route (#14) counts as gated: `requireInternalService` refuses
  // every user token and admits only the named peer services, which is a
  // STRONGER requirement than any user permission — so these routes no longer
  // need a "service principal, no user permission applies" exception.
  return entry.permissions.length > 0 || entry.systemAdmin || entry.internalCallers.length > 0;
}

/** The outcome of a coverage check: what fails, and which exceptions went unused. */
export interface RouteCoverageResult {
  /** One human-readable line per uncovered route (empty ⇒ full coverage). */
  violations: string[];
  /** Exceptions that waived nothing — stale entries to delete. */
  unusedExceptions: string[];
}

/** Check a service's route table against the coverage rules. */
export function findRouteCoverageViolations(
  table: readonly RouteTableEntry[],
  exceptions: readonly RouteCoverageException[] = [],
): RouteCoverageResult {
  const violations: string[] = [];
  const used = new Set<RouteCoverageException>();

  const waived = (entry: RouteTableEntry, rule: 'permission' | 'audit'): boolean => {
    const hit = exceptions.find((e) => (e.waive === rule || e.waive === 'all') && matches(e, entry));
    if (hit) used.add(hit);
    return hit !== undefined;
  };

  for (const entry of table) {
    if (entry.method === 'OPTIONS') continue;
    const where = `${entry.method} ${entry.path}`;
    // An `/internal/…` path is internal by name, so it must be internal by gate
    // too (#14). Checked for EVERY service, with no exception list: a new
    // internal route that forgets `requireInternalService` is a browser-reachable
    // peer-service API, which is the failure mode this rule exists to prevent.
    if (/(^|\/)internal(\/|$)/.test(entry.path) && entry.internalCallers.length === 0) {
      violations.push(`${where}: an /internal route without requireInternalService({ callers: [...] }) — user tokens would reach it`);
    }
    if (!isGated(entry)) {
      if (!waived(entry, 'permission')) {
        violations.push(`${where}: no permission gate (add requirePermission/requireSystemAdmin, or an exception with a reason)`);
      }
    } else if (!entry.auth) {
      violations.push(`${where}: permission gate without requireAuth — the gate can never see a user`);
    }
    if (isWriteMethod(entry.method) && entry.audit.length === 0 && !waived(entry, 'audit')) {
      violations.push(`${where}: write route declares no audit action (wrap the handler chain in audited('<action>'))`);
    }
  }

  const unusedExceptions = exceptions
    .filter((e) => !used.has(e) && e.optional !== true)
    .map((e) => `${e.method ?? '*'} ${String(e.path)} — ${e.reason}`);
  return { violations, unusedExceptions };
}

/** One internal route a service declares, and the services allowed to call it. */
export interface InternalRouteDeclaration {
  method: string;
  path: string;
  /** The `callers` passed to `requireInternalService` — also what the mesh policy names. */
  callers: string[];
}

/**
 * Check a service's INTERNAL routes (#14) against what it declares.
 *
 * The declaration is the single list a service maintains, and it is checked in
 * BOTH directions, so neither side can drift:
 *
 *  - every declared route must exist and be gated by `requireInternalService`
 *    with exactly the declared callers (and `requireAuth` before it);
 *  - every route the table says is internal must be declared — so adding one
 *    forces a visible change here, and the Istio `AuthorizationPolicy` that
 *    names the same callers (`deploy/*​/k8s/istio-internal-routes.yaml`) has
 *    one authoritative list to be reviewed against.
 */
export function findInternalRouteViolations(
  table: readonly RouteTableEntry[],
  declared: readonly InternalRouteDeclaration[],
): string[] {
  const violations: string[] = [];
  const key = (method: string, path: string): string => `${method.toUpperCase()} ${path}`;
  const declaredByKey = new Map(declared.map((d) => [key(d.method, d.path), d]));

  for (const d of declared) {
    const entry = table.find((e) => key(e.method, e.path) === key(d.method, d.path));
    if (!entry) {
      violations.push(`${key(d.method, d.path)}: declared internal but the route does not exist`);
      continue;
    }
    if (!entry.auth) violations.push(`${key(d.method, d.path)}: internal route without requireAuth`);
    const actual = [...entry.internalCallers].sort().join(', ');
    const expected = [...d.callers].sort().join(', ');
    if (actual !== expected) {
      violations.push(`${key(d.method, d.path)}: internal callers are [${actual}] but [${expected}] were declared`);
    }
  }

  for (const entry of table) {
    if (entry.internalCallers.length === 0) continue;
    if (!declaredByKey.has(key(entry.method, entry.path))) {
      violations.push(`${key(entry.method, entry.path)}: gated by requireInternalService but not declared (add it here and to the mesh policy)`);
    }
  }
  return violations;
}

/**
 * The plugin-ecosystem GOVERNANCE check (docs/plans/plugin-ecosystem.md §3.0):
 * only the system org manages or approves the ecosystem, so every route whose
 * permission gate names a system-org-only permission (`plugins:moderate`,
 * `publishers:verify` — api-core `SYSTEM_ORG_ONLY_PERMISSIONS`) must ALSO run
 * `requireSystemOrg` and demand an MFA-grade session (`minAssurance: 2`).
 * `requireEcosystemPermission` provides all three; this catches a hand-rolled
 * chain that forgot one.
 *
 * It has no exception list on purpose: there is no legitimate route that
 * exercises ecosystem-governance authority from a tenant org or a weak session.
 * A table with no such route passes, so a service wires it in before its first
 * governance route exists and the check bites the day one lands.
 */
export function findSystemOrgGuardViolations(table: readonly RouteTableEntry[]): string[] {
  const violations: string[] = [];
  for (const entry of table) {
    const governed = entry.permissions.flatMap((g) => g.permissions).filter((p) => isSystemOrgOnlyPermission(p));
    if (governed.length === 0) continue;
    const where = `${entry.method} ${entry.path}`;
    const perms = [...new Set(governed)].join(', ');
    if (entry.systemOrg !== true) {
      violations.push(`${where}: gated on system-org-only ${perms} without requireSystemOrg — a tenant-org token would reach it (use requireEcosystemPermission)`);
    }
    if (entry.minAssurance < 2) {
      violations.push(`${where}: gated on system-org-only ${perms} without an MFA-grade session (minAssurance 2) — use requireEcosystemPermission`);
    }
  }
  return violations;
}

/** Every audit action declared anywhere in a route table. */
export function declaredAuditActions(table: readonly RouteTableEntry[]): string[] {
  return [...new Set(table.flatMap((e) => e.audit))].sort();
}

/**
 * Compare a service's route table to its checked-in copy under
 * `frontend/src/generated/route-table/` — the file the frontend's `can(...)`
 * tests read. Returns a diff message, or `null` when they match. Set
 * `UPDATE_ROUTE_TABLES=1` to rewrite the file after an intended route change.
 */
export function compareRouteTableSnapshot(table: readonly RouteTableEntry[], file: string): string | null {
  const serialized = `${JSON.stringify(table, null, 2)}\n`;
  if (process.env.UPDATE_ROUTE_TABLES === '1') {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, serialized, 'utf8');
    return null;
  }
  let current: string;
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    return `${file} is missing. Re-run this test with UPDATE_ROUTE_TABLES=1 to generate it.`;
  }
  if (current === serialized) return null;
  const expected: RouteTableEntry[] = JSON.parse(current);
  const key = (e: RouteTableEntry): string => `${e.method} ${e.path}`;
  const before = new Set(expected.map(key));
  const after = new Set(table.map(key));
  const added = [...after].filter((k) => !before.has(k));
  const removed = [...before].filter((k) => !after.has(k));
  const changed = table
    .filter((e) => before.has(key(e)))
    .filter((e) => JSON.stringify(e) !== JSON.stringify(expected.find((x) => key(x) === key(e))))
    .map(key);
  return [
    `${file} is out of date (the frontend reads it to check its can(...) gates).`,
    added.length ? `  added:   ${added.join(', ')}` : '',
    removed.length ? `  removed: ${removed.join(', ')}` : '',
    changed.length ? `  changed: ${changed.join(', ')}` : '',
    '  Re-run with UPDATE_ROUTE_TABLES=1 to refresh it, then review the diff.',
  ].filter(Boolean).join('\n');
}
