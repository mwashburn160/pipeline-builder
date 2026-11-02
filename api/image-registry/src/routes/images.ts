// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import { registerBlobRoutes } from './images/images-blobs.js';
import { registerCopyRoutes } from './images/images-copy.js';
import { registerDeleteRoutes } from './images/images-delete.js';
import { registerListRoutes } from './images/images-list.js';

/**
 * Image management endpoints. Every route is permission-gated per operation, at
 * the rung its blast radius earns:
 *
 *  - reads (list/tags/manifest/blob) require `registry:read`;
 *  - the copy route (read source + write target) requires `registry:read` AND
 *    `registry:write` — additive, so not the purge rung;
 *  - the DELETEs (manifest, whole repo) require `registry:purge`, the one
 *    registry action with no undo.
 *
 * `registry:read`/`:write` are system-org-only and so carry requireSystemOrg +
 * an MFA-grade session alongside the permission; `registry:purge` stays
 * superadmin-only (in no bundle, so the flag is its only holder) and carries
 * the step-up too. The gates are attached inside the per-concern register*
 * modules below; `requireAuth` runs at mount time (see src/index.ts) so
 * `req.user` is always populated before any gate.
 *
 * A SECOND, independent per-repo ownership filter (`repo-access.ts`) runs after
 * every one of them, so no permission change widens which repositories a caller
 * can reach.
 *
 * These proxy to the underlying registry v2 ops using
 * `pipeline-image-registry`'s own service-account credentials. Customers never
 * reach the underlying registry directly through these routes.
 *
 * Routes:
 *  - GET /api/images (?nonEmpty=true hides zero-tag repos)
 *  - GET /api/images/:name/tags
 *  - GET /api/images/:name/manifests/:reference
 *  - DELETE /api/images/:name/manifests/:reference
 *  - DELETE /api/images/:name (prune a whole repo — deletes all tags)
 *  - GET /api/images/:name/blobs/:digest (5MB cap; config blobs only)
 *  - POST /api/images/copy (cross-repo; multi-arch aware)
 *
 * Note on repo names: the registry treats `library/pipeline-foo` as one repo.
 * Multi-segment names are passed URL-ENCODED (`library%2Fpipeline-foo`) so a
 * single `:name` param captures them — same convention as every route here.
 *
 * The handler bodies live in sibling modules under `./images/`, grouped by
 * concern. Registration ORDER here is load-bearing: the DELETE `/:name`
 * catch-all (registered inside `registerDeleteRoutes`, after
 * `/:name/manifests/:reference`) must stay after the more specific matchers.
 * The register* calls below reproduce the exact original route order:
 * list → delete → blob → copy.
 */
export function createImageRoutes(): Router {
  const router = Router();

  registerListRoutes(router); // GET /, GET /:name/tags, GET /:name/manifests/:reference
  registerDeleteRoutes(router); // DELETE /:name/manifests/:reference, DELETE /:name
  registerBlobRoutes(router); // GET /:name/blobs/:digest
  registerCopyRoutes(router); // POST /copy

  return router;
}
