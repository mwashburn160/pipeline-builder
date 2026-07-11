// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requireSystemAdmin } from '@pipeline-builder/api-core';
import { Router, type RequestHandler } from 'express';
import { registerBlobRoutes } from './images/images-blobs.js';
import { registerCopyRoutes } from './images/images-copy.js';
import { registerDeleteRoutes } from './images/images-delete.js';
import { registerListRoutes } from './images/images-list.js';

/**
 * Image management endpoints. All system-admin only — these proxy to the
 * underlying registry v2 ops using `pipeline-image-registry`'s own
 * service-account credentials. Customers never reach the underlying
 * registry directly through these routes.
 *
 * Routes:
 *  - GET    /api/images                            (?nonEmpty=true hides zero-tag repos)
 *  - GET    /api/images/:name/tags
 *  - GET    /api/images/:name/manifests/:reference
 *  - DELETE /api/images/:name/manifests/:reference
 *  - DELETE /api/images/:name                      (prune a whole repo — deletes all tags)
 *  - GET    /api/images/:name/blobs/:digest        (5MB cap; config blobs only)
 *  - POST   /api/images/copy                       (cross-repo; multi-arch aware)
 *
 * Note on repo names: the registry treats `library/pipeline-foo` as one repo.
 * Multi-segment names are passed URL-ENCODED (`library%2Fpipeline-foo`) so a
 * single `:name` param captures them — same convention as every route here.
 *
 * The handler bodies live in sibling modules under `./images/`, grouped by
 * concern. Registration ORDER here is load-bearing: `requireSystemAdmin`
 * gates ALL routes, and the DELETE `/:name` catch-all (registered inside
 * `registerDeleteRoutes`, after `/:name/manifests/:reference`) must stay
 * after the more specific matchers. The register* calls below reproduce the
 * exact original route order: list → delete → blob → copy.
 */
export function createImageRoutes(): Router {
  const router = Router();
  router.use(requireSystemAdmin as RequestHandler);

  registerListRoutes(router); // GET /, GET /:name/tags, GET /:name/manifests/:reference
  registerDeleteRoutes(router); // DELETE /:name/manifests/:reference, DELETE /:name
  registerBlobRoutes(router); // GET /:name/blobs/:digest
  registerCopyRoutes(router); // POST /copy

  return router;
}
