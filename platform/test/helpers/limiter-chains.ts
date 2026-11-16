// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * For every route an assembled Express app serves, the middleware functions that
 * run before its handler — so a test can ask "which rate-limit buckets does this
 * request spend?" without sending it.
 *
 * Mirrors api-core's `buildRouteTable` walk (route-table.ts): a router mounted
 * with `use(path, …)` carries its mount path on the layer (api-core installs the
 * recorder that writes it on import), earlier sibling middleware is inherited by
 * every later route it matches, and the first registration of a method + path
 * wins, as in Express.
 */

const LAYER_PATH = Symbol.for('pipeline-builder.layer-path');

interface Layer {
  handle: unknown;
  route?: { path: string | string[]; methods: Record<string, boolean>; stack: Array<{ method?: string; handle: unknown }> };
  matchers: Array<(path: string) => unknown>;
  slash?: boolean;
  [LAYER_PATH]?: string;
}
interface RouterLike { stack: Layer[] }
interface Candidate { layer: Layer; prefix: string }

function joinPath(prefix: string, path: string): string {
  const joined = `${prefix.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  return joined.length > 1 ? joined.replace(/\/+$/, '') : '/';
}

function isRouter(handle: unknown): handle is RouterLike {
  return typeof handle === 'function' && Array.isArray((handle as Partial<RouterLike>).stack);
}

function applies(c: Candidate, fullPath: string): boolean {
  const base = c.prefix === '/' ? '' : c.prefix;
  if (base && fullPath !== base && !fullPath.startsWith(`${base}/`)) return false;
  if (c.layer.slash) return true;
  const rel = fullPath.slice(base.length) || '/';
  return c.layer.matchers.some((m) => m(rel) !== false);
}

function walk(stack: Layer[], prefix: string, inherited: Candidate[], out: Map<string, unknown[]>): void {
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
          if (out.has(key)) continue;
          const routeFns = layer.route.stack
            .filter((l) => l.method === undefined || l.method.toUpperCase() === method || method === '*')
            .map((l) => l.handle);
          out.set(key, [...chain, ...routeFns]);
        }
      }
    } else if (isRouter(layer.handle)) {
      walk(layer.handle.stack, joinPath(prefix, layer[LAYER_PATH] ?? '/'), [...inherited, ...local], out);
    } else {
      local.push({ layer, prefix });
    }
  }
}

/** `"METHOD /path"` → every function that runs before (and including) its handler. */
export function middlewareChains(app: unknown): Map<string, unknown[]> {
  const root = (app as { router?: RouterLike }).router ?? (app as RouterLike);
  const out = new Map<string, unknown[]>();
  walk(root.stack, '/', [], out);
  return out;
}
