// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The middleware chain an Express router wires for one route, as the `__mw`
 * tags a route-wiring suite gives its stand-in middleware — so a suite asserts
 * WHICH gates a route carries, and in what order.
 */

import { expect } from '@jest/globals';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function routeChain(router: any, method: string, path: string): string[] {
  const layer = router.stack.find((l: { route?: { path: string; methods: Record<string, boolean> } }) =>
    l.route?.path === path && l.route.methods[method]);
  expect(layer).toBeDefined();
  return layer.route.stack.map((s: { handle: { __mw?: string } }) => s.handle.__mw);
}
