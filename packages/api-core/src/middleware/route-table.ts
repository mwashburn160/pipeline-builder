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
import type { Permission } from '../types/permissions.js';

/** One requirement a gate middleware enforces. */
export type RouteGate =
  | { kind: 'auth' }
  | { kind: 'permission'; mode: 'any' | 'all'; permissions: readonly Permission[]; allowService?: boolean }
  | { kind: 'systemAdmin' }
  | { kind: 'servicePrincipal' }
  /** An INTERNAL route: user tokens refused outright, only these services admitted. */
  | { kind: 'internalService'; callers: readonly string[] }
  | { kind: 'stepUp' }
  | { kind: 'feature'; feature: string }
  | { kind: 'scope'; scope: string }
  | { kind: 'audit'; actions: readonly string[] };

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
  /**
   * The services allowed to call this route when it is INTERNAL (`requireInternalService`).
   * An empty array means the route is not internal — a user token may reach it,
   * subject to the other gates. Sorted, so the generated table is stable.
   */
  internalCallers: string[];
  stepUp: boolean;
  features: string[];
  scopes: string[];
  audit: string[];
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
    internalCallers: [],
    stepUp: false,
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
      case 'internalService': for (const c of g.callers) if (!entry.internalCallers.includes(c)) entry.internalCallers.push(c); break;
      case 'stepUp': entry.stepUp = true; break;
      case 'feature': if (!entry.features.includes(g.feature)) entry.features.push(g.feature); break;
      case 'scope': if (!entry.scopes.includes(g.scope)) entry.scopes.push(g.scope); break;
      case 'audit': for (const a of g.actions) if (!entry.audit.includes(a)) entry.audit.push(a); break;
    }
  }
  entry.internalCallers.sort();
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
  const gated = (e: RouteTableEntry): boolean => e.permissions.length > 0 || e.systemAdmin || e.servicePrincipal;
  const writes = table.filter((e) => isWriteMethod(e.method));
  return {
    routes: table.length,
    writes: writes.length,
    ungated: table.filter((e) => !gated(e)).length,
    unaudited: writes.filter((e) => e.audit.length === 0).length,
    internal: table.filter((e) => e.internalCallers.length > 0).length,
  };
}
