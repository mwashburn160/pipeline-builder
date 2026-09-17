// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drive ONE registered Express route through its full per-route middleware chain
 * (e.g. `requireIngestScope` → the withRoute handler), stopping at the first
 * layer that responds instead of calling `next()`. Lets router suites exercise
 * per-route guards without an HTTP server.
 */
export function routeChain(router: any, path: string, method = 'post') {
  const layers: Array<{ handle: (req: any, res: any, next: () => void) => unknown }> =
    router.stack.find((l: any) => l.route?.path === path && l.route?.methods?.[method])?.route?.stack ?? [];
  if (layers.length === 0) throw new Error(`No ${method.toUpperCase()} ${path} route registered`);
  return async (req: any, res: any): Promise<void> => {
    for (const layer of layers) {
      let advanced = false;
      await layer.handle(req, res, () => { advanced = true; });
      if (!advanced) return;
    }
  };
}
