// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pull the terminal handler for one route out of a mocked Express router, so a
 * suite can invoke it directly with its own `req`/`res` doubles.
 *
 * WHY A FACTORY. Thirteen suites across six services each declared a byte-identical
 * seven-line `getHandler(method, path)` closing over their own `router`. Binding
 * the router here keeps every call site exactly as it was — `getHandler('post',
 * '/:id')` — while the layer-walking lives in one place. It reaches into
 * `router.stack`, which is Express internals, and that is precisely the kind of
 * thing worth having one copy of.
 *
 * The return type is `AnyFn`, deliberately. The thirteen local copies returned
 * an implicit `any` from `layer.route.stack[n].handle`, and every call site
 * invokes the result as `await getHandler('post', '/x')(req, res)`. A tighter
 * `unknown` type-checks here and breaks 281 of those call sites — jest still
 * passes, because jest does not type-check, so the only thing that catches it is
 * the build.
 *
 * Returns the LAST handler in the route's stack: the middleware chain in front of
 * it (auth, permission gates, validation) is what a suite stubs or asserts
 * separately, and the terminal handler is the controller under test.
 */

import type { AnyFn } from './any-fn.js';

interface RouteLayer {
  route?: {
    path?: unknown;
    methods?: Record<string, boolean>;
    stack: Array<{ handle: unknown }>;
  };
}

/** Bind a router; the returned function takes `(method, path)` as before. */
export function handlerGetter(router: unknown) {
  return function getHandler(method: string, path: string): AnyFn {
    const stack = (router as { stack?: RouteLayer[] }).stack ?? [];
    const layer = stack.find((l) => l.route?.path === path && l.route?.methods?.[method]);
    if (!layer?.route) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
    const handlers = layer.route.stack;
    return handlers[handlers.length - 1]!.handle as AnyFn;
  };
}

/**
 * The same lookup, taking the router per call — what the compliance suites' six
 * identical `lastHandler(router, path, method)` copies did. Argument order
 * matches {@link handlerGetter}'s `(method, path)` rather than those copies'
 * `(path, method)`, so a converted call reads the same way everywhere.
 */
export function routeHandler(router: unknown, method: string, path: string): AnyFn {
  return handlerGetter(router)(method, path);
}
