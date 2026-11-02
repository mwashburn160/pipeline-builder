// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Introspectable route table.
 *
 * Authorization is split between router mounts (`app.use('/x', gate, router)`)
 * and individual routes, so grepping source can't prove that every route is
 * gated. Instead, every gate middleware in this package carries METADATA (what it
 * requires), and {@link buildRouteTable} walks an assembled Express app and
 * resolves, per method + path, the full chain of gates Express would run before
 * the handler: permissions, system-admin, service principal, step-up, feature,
 * token scope, and the audit actions the route declares via {@link audited}.
 *
 * Express 5 (router@2) does not keep a mount's path string on its layer, so this
 * module records it: on import it wraps `Router.prototype.use` to stamp each new
 * layer with the path it was mounted at. api-core is imported before any route
 * module registers a route, so every layer an app builds is stamped. The wrap
 * only adds a symbol property; routing behaviour is unchanged.
 */

import express from 'express';
import { isQuotaExemptRoute } from './quota-exempt-routes.js';
import type { Permission } from '../types/permissions.js';

/**
 * What a MACHINE credential (PAT, service account) meets on a route gated by
 * `requireOrgAdminAssurance` while the org's admin-MFA policy is on:
 *   - `allow`  — the route is legitimately machine-callable (automation that
 *                manages members, roles, billing…); the policy is about how
 *                strongly a PERSON's session was opened, so it does not apply;
 *   - `refuse` — only a person may do this while the policy is on (403
 *                `HUMAN_SESSION_REQUIRED`), e.g. minting another credential.
 */
export type OrgAdminAssuranceMachines = 'allow' | 'refuse';

/**
 * The CLOSED set of principal kinds a `dynamicAuthz` rule may admit.
 *
 * A route whose authority is resolved in the handler still has to say WHO can
 * get through it. These are the kinds, deliberately coarse — the precise
 * predicate lives in the prose rule and in the code:
 *
 *  - `superadmin`    — the `User.isSuperAdmin` flag (`isSystemAdmin(req)`).
 *  - `system-org`    — a member of the system org holding a named permission;
 *                      list the ids in `permissions` so the coverage scan and
 *                      the contract can see them.
 *  - `tenant-admin`  — an admin or owner of the target's own org, or of an
 *                      ancestor of it. NOT a superadmin by virtue of the flag:
 *                      several of these rules refuse the flag on purpose.
 *  - `tenant-member` — any member of the target's org, admin or not.
 *  - `subject`       — the very user the request is about (self-service).
 *  - `service`       — a service principal / internal caller.
 *  - `gateway`       — the ingress itself supplies the fact (the console
 *                      `auth_request` passes the console class in a header).
 */
export const DYNAMIC_PRINCIPALS = [
  'superadmin', 'system-org', 'tenant-admin', 'tenant-member', 'subject', 'service', 'gateway',
] as const;
export type DynamicPrincipal = typeof DYNAMIC_PRINCIPALS[number];

/** One requirement a gate middleware enforces. */
export type RouteGate =
  | { kind: 'auth' }
  | { kind: 'permission'; mode: 'any' | 'all'; permissions: readonly Permission[]; allowService?: boolean }
  | { kind: 'systemAdmin' }
  /**
   * Authorization the route CANNOT express statically, resolved in the handler.
   *
   * Some authority depends on the request: impersonation asks whether the caller
   * is a sysadmin OR an admin of an ancestor of the TARGET user's org, which is
   * only answerable once the target is known. Those gates were correct but
   * invisible — the route table showed no requirement, and
   * `docs/permission-contract.md` is derived from the table, so the artifact the
   * repo calls its review surface read blank for the strongest privilege in the
   * system.
   *
   * This records the requirement in prose AND as a closed set of principal
   * kinds. It authorizes NOTHING; the handler still does the work. Its value is
   * that a reviewer reading the contract sees a stated rule instead of an empty
   * cell, and that removing the real check leaves a declaration behind that no
   * longer matches.
   *
   * WHY `reachableBy` EXISTS BESIDE THE PROSE. Prose is unreviewable by a test,
   * and one of these rules was wrong: the impersonation `decide` route declared
   * "a DIFFERENT sysadmin than the requester (two-person rule)", which is only
   * its break-glass branch — the ordinary branch is the tenant's named approver
   * or a genuine tenant admin, and a sysadmin alone is explicitly REFUSED there.
   * Nothing could notice, because the only machine-readable fields said
   * `systemAdmin: false, permissions: []`. A closed set makes the author
   * enumerate principals, lets the coverage scan assert the declaration exists,
   * and lets "which routes can the superadmin flag reach?" be answered by a
   * query instead of by reading six paragraphs.
   */
  | { kind: 'dynamicAuthz'; rule: string; reachableBy: readonly DynamicPrincipal[]; permissions?: readonly Permission[] }
  | { kind: 'servicePrincipal' }
  /** An INTERNAL route: user tokens refused outright, only these services admitted. */
  | { kind: 'internalService'; callers: readonly string[] }
  | { kind: 'stepUp'; methods?: readonly string[] }
  /** The whole SESSION must be MFA-grade (`requireAuth({ minAssurance })`), and
   *  optionally no older than `maxAge` seconds. `exempt` names a carve-out the
   *  gate applies to a narrow class of request (see `AssuranceOptions.exempt`),
   *  so a route whose level is conditional says so on the table. */
  | { kind: 'assurance'; minAssurance: 1 | 2; maxAge?: number; exempt?: string }
  /** The session must be MFA-grade WHEN the org's `adminActionsRequireMfa`
   *  policy is on (`requireOrgAdminAssurance`). `machines` says what a machine
   *  credential meets on the route while the policy is on. */
  | { kind: 'orgAdminAssurance'; machines: OrgAdminAssuranceMachines }
  /** The caller's ACTIVE org must be the system org (`requireSystemOrg`) — the
   *  plugin-ecosystem governance boundary (docs/runbooks/ecosystem-moderation.md). */
  | { kind: 'systemOrg' }
  | { kind: 'feature'; feature: string }
  | { kind: 'scope'; scope: string }
  | { kind: 'audit'; actions: readonly string[] }
  /** A quota middleware: `meter` increments the type once per 2xx
   *  (`meterQuotaOnSuccess`), `check` 429s when the type is spent (`checkQuota`).
   *  Recorded so the quota coverage check can see an unmetered user route — and a
   *  route metered TWICE, which double-bills every call. */
  | { kind: 'quota'; mode: 'meter' | 'check'; quotaType: string };

// Symbol.for, not Symbol(): a test that loads api-core twice (ESM + a
// requireActual copy) must still see tags set by the other copy.
const GATES = Symbol.for('pipeline-builder.route-gates');
const LAYER_PATH = Symbol.for('pipeline-builder.layer-path');
const RECORDER_INSTALLED = Symbol.for('pipeline-builder.route-recorder');

type Tagged = { [GATES]?: RouteGate[] };

/**
 * Attach gate metadata to a middleware function (appends to any existing tags)
 * and return the same function. Use it for a service-local gate so the route
 * table knows what it enforces — e.g. a handler-level `requireComplianceWrite`
 * tagged `{ kind: 'permission', mode: 'any', permissions: ['compliance:write'] }`.
 */
export function tagRouteGate<T extends object>(fn: T, ...gates: RouteGate[]): T {
  const t = fn as T & Tagged;
  Object.defineProperty(t, GATES, { value: [...(t[GATES] ?? []), ...gates], configurable: true, enumerable: false, writable: true });
  return fn;
}

/** The gate metadata attached to a middleware function (empty when untagged). */
export function getRouteGates(fn: unknown): readonly RouteGate[] {
  if (typeof fn !== 'function') return [];
  return (fn as Tagged)[GATES] ?? [];
}

/**
 * Declare the audit action(s) a route emits. A no-op middleware whose only job
 * is to put the action on the route table, so the coverage test can require an
 * audit declaration on every write route. Place it in the route's chain:
 * `router.post('/', audited('pipeline.create'), handler)`. The handler still
 * emits the event itself.
 */
/**
 * Declare authorization that the handler resolves (see the `dynamicAuthz` gate).
 * A no-op middleware, exactly like {@link audited}: it records the rule on the
 * route table so the contract can print it.
 *
 * `rule` is read by a human, so it should name the real predicate — e.g.
 * `'sysadmin, or an admin of an ancestor org of the target user'`.
 */
export function dynamicAuthz(
  rule: string,
  opts: { reachableBy: readonly DynamicPrincipal[]; permissions?: readonly Permission[] },
): (req: unknown, res: unknown, next: () => void) => void {
  if (opts.reachableBy.length === 0) {
    throw new Error(`dynamicAuthz("${rule}") must name at least one principal kind in reachableBy`);
  }
  for (const p of opts.reachableBy) {
    if (!DYNAMIC_PRINCIPALS.includes(p)) {
      throw new Error(`dynamicAuthz("${rule}"): unknown principal "${p}" — one of ${DYNAMIC_PRINCIPALS.join(', ')}`);
    }
  }
  return tagRouteGate(
    function dynamicAuthzRoute(_req: unknown, _res: unknown, next: () => void) { next(); },
    { kind: 'dynamicAuthz', rule, reachableBy: [...opts.reachableBy], ...(opts.permissions && { permissions: [...opts.permissions] }) },
  );
}

export function audited(...actions: string[]): (req: unknown, res: unknown, next: () => void) => void {
  return tagRouteGate(function auditedRoute(_req: unknown, _res: unknown, next: () => void) { next(); }, { kind: 'audit', actions });
}

// ---------------------------------------------------------------------------
// Mount-path recording
// ---------------------------------------------------------------------------

interface Layer {
  handle: unknown;
  route?: { path: string | string[]; methods: Record<string, boolean>; stack: Array<{ method?: string; handle: unknown }> };
  matchers: Array<(path: string) => unknown>;
  /** router@2's "mounted at '/' with end:false" fast path — matches ANY path. */
  slash?: boolean;
  [LAYER_PATH]?: string;
}

interface RouterLike { stack: Layer[] }

function installRouteRecorder(): void {
  const proto = (express.Router as unknown as { prototype: Record<string | symbol, unknown> }).prototype;
  if (proto[RECORDER_INSTALLED]) return;
  const originalUse = proto.use as (this: RouterLike, ...args: unknown[]) => unknown;
  proto.use = function recordingUse(this: RouterLike, ...args: unknown[]): unknown {
    const before = this.stack.length;
    const result = originalUse.apply(this, args);
    // Same path disambiguation as router@2's `use`: a leading non-function
    // (possibly nested in arrays) is the path; otherwise the mount is '/'.
    let first: unknown = args[0];
    while (Array.isArray(first) && first.length > 0) first = first[0];
    const path = typeof first === 'function' ? '/' : String(args[0]);
    for (let i = before; i < this.stack.length; i++) {
      Object.defineProperty(this.stack[i], LAYER_PATH, { value: path, enumerable: false, configurable: true });
    }
    return result;
  };
  Object.defineProperty(proto, RECORDER_INSTALLED, { value: true, enumerable: false });
}

installRouteRecorder();

// ---------------------------------------------------------------------------
// Table construction
// ---------------------------------------------------------------------------

/** Resolved requirements for one method + path. */
export interface RouteTableEntry {
  method: string;
  path: string;
  /** Authentication runs before the handler (requireAuth). */
  auth: boolean;
  /** Each permission gate in the chain (all must pass; each is any-of or all-of). */
  permissions: Array<{ mode: 'any' | 'all'; permissions: Permission[]; allowService: boolean }>;
  systemAdmin: boolean;
  servicePrincipal: boolean;
  /** Authorization the HANDLER resolves, in prose — see the `dynamicAuthz` gate.
   *  Empty when the route's authority is fully expressed by the gates above. */
  dynamicAuthz: string[];
  /** The principal kinds those dynamic rules admit, deduped and sorted. Absent
   *  when the route declares no dynamic rule, so tables without one are
   *  unchanged. This is the machine-readable half of `dynamicAuthz`: it is how
   *  "which routes can the superadmin flag reach?" is answerable without
   *  reading prose. */
  dynamicReachableBy?: DynamicPrincipal[];
  /** Permission ids a dynamic rule consults inside the handler, deduped and
   *  sorted. Absent when none does. These are REAL enforcement — the coverage
   *  scan counts a `userHasPermission(req, 'x')` in a controller — so the
   *  contract should not read as though the route asked for nothing. */
  dynamicPermissions?: Permission[];
  /**
   * The services allowed to call this route when it is INTERNAL (`requireInternalService`).
   * An empty array means the route is not internal — a user token may reach it,
   * subject to the other gates. Sorted, so the generated table is stable.
   */
  internalCallers: string[];
  stepUp: boolean;
  /** When the step-up gate names the factors that may earn it (`['webauthn',
   *  'totp']` on the most dangerous routes), the allowed methods. Empty means
   *  any factor satisfies it. Sorted, so the generated table is stable. */
  stepUpMethods: string[];
  /** Highest `minAssurance` any gate in the chain demands; 0 when none does. */
  minAssurance: 0 | 1 | 2;
  /** Tightest `maxAge` (seconds) any assurance gate in the chain demands. */
  maxAge?: number;
  /**
   * The named carve-outs the chain's assurance gates allow (sorted). Absent when
   * there are none, so a table of routes without one is unchanged. A reviewer
   * reading `minAssurance: 2` next to `assuranceExempt: ["bootstrap-setup"]`
   * knows the level is required of everyone EXCEPT that named case.
   */
  assuranceExempt?: string[];
  /**
   * Present when the route requires an MFA-grade session WHEN the org's
   * `adminActionsRequireMfa` policy is on (`requireOrgAdminAssurance`), with
   * what a machine credential meets there. Absent (not `false`) otherwise, so
   * the table of a service that uses no such gate is unchanged.
   */
  orgAdminAssurance?: { machines: OrgAdminAssuranceMachines };
  /**
   * Present (always `true`) when the chain runs `requireSystemOrg`: only a
   * caller whose active org is the system org gets through. Absent otherwise,
   * so the table of a service with no ecosystem-governance route is unchanged.
   */
  systemOrg?: true;
  features: string[];
  scopes: string[];
  audit: string[];
  /**
   * The quota middleware in the chain: the types metered (once per 2xx) and
   * checked (429 when spent). `metered` is NOT deduped — a type listed twice is
   * metered twice, which the coverage check flags. `exempt` marks a route on the
   * fleet-wide `QUOTA_EXEMPT_ROUTES` list, where the `apiCalls` meter and check
   * are no-ops at runtime (so `apiCalls` is left out of both lists). Absent when
   * the chain has no quota middleware and the route is not exempt.
   */
  quota?: { metered: string[]; checked: string[]; exempt?: true };
}

interface Candidate { layer: Layer; prefix: string }

function joinPath(prefix: string, path: string): string {
  const joined = `${prefix.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  return joined.length > 1 ? joined.replace(/\/+$/, '') : '/';
}

function isRouter(handle: unknown): handle is RouterLike {
  return typeof handle === 'function' && Array.isArray((handle as Partial<RouterLike>).stack);
}

/**
 * Whether a middleware layer (mounted under `prefix`) runs for `fullPath`.
 * Mirrors `Layer.prototype.match`, including its fast path: a layer added with
 * no path (`router.use(gate)`) matches EVERY path under its router — which is
 * exactly how the shared `requirePermission` gates between two `router.use(...)`
 * mounts reach the routers registered after them.
 */
function applies(c: Candidate, fullPath: string): boolean {
  const base = c.prefix === '/' ? '' : c.prefix;
  if (base && fullPath !== base && !fullPath.startsWith(`${base}/`)) return false;
  if (c.layer.slash) return true;
  const rel = fullPath.slice(base.length) || '/';
  return c.layer.matchers.some((m) => m(rel) !== false);
}

function collectGates(fns: unknown[]): RouteGate[] {
  return fns.flatMap((fn) => getRouteGates(fn));
}

function toEntry(method: string, path: string, gates: RouteGate[]): RouteTableEntry {
  const entry: RouteTableEntry = {
    method,
    path,
    auth: false,
    permissions: [],
    systemAdmin: false,
    servicePrincipal: false,
    dynamicAuthz: [],
    internalCallers: [],
    stepUp: false,
    stepUpMethods: [],
    minAssurance: 0,
    features: [],
    scopes: [],
    audit: [],
  };
  for (const g of gates) {
    switch (g.kind) {
      case 'auth': entry.auth = true; break;
      case 'permission': entry.permissions.push({ mode: g.mode, permissions: [...g.permissions], allowService: g.allowService === true }); break;
      case 'systemAdmin': entry.systemAdmin = true; break;
      case 'servicePrincipal': entry.servicePrincipal = true; break;
      case 'dynamicAuthz':
        if (!entry.dynamicAuthz.includes(g.rule)) entry.dynamicAuthz.push(g.rule);
        entry.dynamicReachableBy = [...new Set([...(entry.dynamicReachableBy ?? []), ...g.reachableBy])].sort();
        if (g.permissions?.length) {
          entry.dynamicPermissions = [...new Set([...(entry.dynamicPermissions ?? []), ...g.permissions])].sort();
        }
        break;
      case 'internalService': for (const c of g.callers) if (!entry.internalCallers.includes(c)) entry.internalCallers.push(c); break;
      case 'stepUp':
        entry.stepUp = true;
        for (const m of g.methods ?? []) if (!entry.stepUpMethods.includes(m)) entry.stepUpMethods.push(m);
        break;
      case 'assurance':
        // Several gates may apply; the STRICTEST wins, since every one of them runs.
        if (g.minAssurance > entry.minAssurance) entry.minAssurance = g.minAssurance;
        if (g.maxAge !== undefined) entry.maxAge = entry.maxAge === undefined ? g.maxAge : Math.min(entry.maxAge, g.maxAge);
        if (g.exempt !== undefined) {
          entry.assuranceExempt = [...new Set([...(entry.assuranceExempt ?? []), g.exempt])].sort();
        }
        break;
      case 'orgAdminAssurance':
        // Strictest wins: one `refuse` in the chain refuses machines.
        entry.orgAdminAssurance = {
          machines: entry.orgAdminAssurance?.machines === 'refuse' || g.machines === 'refuse' ? 'refuse' : 'allow',
        };
        break;
      case 'systemOrg': entry.systemOrg = true; break;
      case 'feature': if (!entry.features.includes(g.feature)) entry.features.push(g.feature); break;
      case 'scope': if (!entry.scopes.includes(g.scope)) entry.scopes.push(g.scope); break;
      case 'audit': for (const a of g.actions) if (!entry.audit.includes(a)) entry.audit.push(a); break;
      case 'quota': {
        const quota = entry.quota ?? (entry.quota = { metered: [], checked: [] });
        if (g.mode === 'meter') quota.metered.push(g.quotaType);
        else if (!quota.checked.includes(g.quotaType)) quota.checked.push(g.quotaType);
        break;
      }
    }
  }
  // An exempt route's apiCalls meter + check skip it at runtime, so the table
  // says what actually happens rather than what is mounted.
  if (isQuotaExemptRoute(method, path)) {
    const quota = entry.quota ?? { metered: [], checked: [] };
    entry.quota = {
      metered: quota.metered.filter((t) => t !== 'apiCalls'),
      checked: quota.checked.filter((t) => t !== 'apiCalls'),
      exempt: true,
    };
  }
  entry.internalCallers.sort();
  entry.stepUpMethods.sort();
  return entry;
}

function walk(stack: Layer[], prefix: string, inherited: Candidate[], out: RouteTableEntry[], seen: Set<string>): void {
  const local: Candidate[] = [];
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      const methods = Object.keys(layer.route.methods).map((m) => (m === '_all' ? '*' : m.toUpperCase()));
      for (const routePath of paths) {
        const full = joinPath(prefix, String(routePath));
        const chain = [...inherited, ...local].filter((c) => applies(c, full)).map((c) => c.layer.handle);
        for (const method of methods) {
          const key = `${method} ${full}`;
          // First registration wins, as in Express: a later duplicate is unreachable.
          if (seen.has(key)) continue;
          seen.add(key);
          const routeFns = layer.route.stack
            .filter((l) => l.method === undefined || l.method.toUpperCase() === method || method === '*')
            .map((l) => l.handle);
          out.push(toEntry(method, full, collectGates([...chain, ...routeFns])));
        }
      }
    } else if (isRouter(layer.handle)) {
      const mountPath = joinPath(prefix, layer[LAYER_PATH] ?? '/');
      // Middleware that runs before this router (ancestors + earlier siblings)
      // is inherited; applicability is re-checked against each full route path.
      walk(layer.handle.stack, mountPath, [...inherited, ...local], out, seen);
    } else {
      local.push({ layer, prefix });
    }
  }
}

/**
 * Build the route table of an assembled Express app (or router): one entry per
 * reachable method + path with every gate that runs before its handler.
 * HEAD is folded into GET, as Express does.
 */
export function buildRouteTable(app: unknown): RouteTableEntry[] {
  const root = (app as { router?: RouterLike }).router ?? (app as RouterLike);
  const out: RouteTableEntry[] = [];
  if (!root || !Array.isArray(root.stack)) return out;
  walk(root.stack, '/', [], out, new Set());
  return out.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
}

/** Whether a method mutates state (everything except GET/HEAD/OPTIONS). */
export function isWriteMethod(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

/** Summary counts for a startup log line. */
export function summarizeRouteTable(table: readonly RouteTableEntry[]): { routes: number; writes: number; ungated: number; unaudited: number; internal: number } {
  const gated = (e: RouteTableEntry): boolean => e.permissions.length > 0 || e.systemAdmin || e.servicePrincipal || e.dynamicAuthz.length > 0;
  const writes = table.filter((e) => isWriteMethod(e.method));
  return {
    routes: table.length,
    writes: writes.length,
    ungated: table.filter((e) => !gated(e)).length,
    unaudited: writes.filter((e) => e.audit.length === 0).length,
    internal: table.filter((e) => e.internalCallers.length > 0).length,
  };
}
