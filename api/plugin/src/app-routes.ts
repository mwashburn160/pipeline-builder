// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requireAuth, requirePermission, requireStepUp, type QuotaService } from '@pipeline-builder/api-core';
import { apiCallsQuota, createAuthenticatedWithOrgRoute, type SSEManager } from '@pipeline-builder/api-server';
import type { Express } from 'express';

import { createBulkPluginRoutes } from './routes/bulk-plugin.js';
import { createDeletePluginRoutes } from './routes/delete-plugin.js';
import { createDeployGeneratedPluginRoutes } from './routes/deploy-generated-plugin.js';
import { createEcosystemConsoleRoutes } from './routes/ecosystem-console.js';
import { createGeneratePluginRoutes } from './routes/generate-plugin.js';
import { createInstallRoutes } from './routes/installs.js';
import { createInternalRoutes } from './routes/internal.js';
import { createKeptSetupImageRoutes } from './routes/kept-setup-images.js';
import { createOrgToolchainDefaultRoutes } from './routes/org-toolchain-default.js';
import { createPipelineSecurityRoutes } from './routes/pipeline-security.js';
import { createPublicDirectoryRoutes } from './routes/public-directory.js';
import { createPublicSubmissionRoutes } from './routes/public-submissions.js';
import { createPublisherRoutes } from './routes/publisher.js';
import { createPurgePluginRoutes } from './routes/purge-plugin.js';
import { createQueueStatusRoutes } from './routes/queue-status.js';
import { createReadPluginRoutes } from './routes/read-plugins.js';
import { createRestorePluginRoutes } from './routes/restore-plugin.js';
import { createReviewRoutes } from './routes/reviews.js';
import { createPublicSecurityNotificationRoutes, createSecurityNotificationRoutes } from './routes/security-notifications.js';
import { createStorageRoutes } from './routes/storage.js';
import { createToolchainConsoleRoutes } from './routes/toolchain-console.js';
import { TOOLCHAIN_MOUNT, createToolchainRoutes } from './routes/toolchain.js';
import { createUpdatePluginRoutes } from './routes/update-plugin.js';
import { createUploadPluginRoutes } from './routes/upload-plugin.js';
import { createVersionLifecycleRoutes } from './routes/version-lifecycle.js';
import { initEcosystem } from './services/ecosystem/context.js';

/** Dependencies the route factories need. */
export interface PluginRouteDeps {
  quotaService: QuotaService;
  sseManager: SSEManager;
}

/**
 * Mount every plugin-service route on `app`. Shared by `index.ts` (the running
 * service) and the route-coverage test, so the route table the test checks is
 * the one production serves.
 */
export function mountRoutes(app: Express, { quotaService, sseManager }: PluginRouteDeps): void {
  // The ecosystem services (publishers, publish requests) read the `listings`
  // quota through the same client the routes use.
  initEcosystem({ quotaService });

  // -- Anonymous public directory. Its own prefix, no
  //    auth by design, never behind the authenticated chain below. nginx maps
  //    `/api/public/*` here with credentials stripped.
  // Anonymous plugin submissions — BEFORE the directory so its
  // availability gate and rate limit are its own (flag off ⇒ 404 here, whatever
  // the directory's state). Quarantine only: nothing it does reaches a
  // `plugins` row or `public/*` without two-person moderation.
  app.use('/public/plugin-submissions', createPublicSubmissionRoutes());
  // Confirming an org's external security-notice address (the emailed
  // single-use link's page POSTs here). Before the directory for the same reason.
  app.use('/public/plugin-security-notifications', createPublicSecurityNotificationRoutes());
  app.use('/public', createPublicDirectoryRoutes());

  // -- Service-to-service routes (image-registry → the team parent-pull set).
  //    Each route carries its own `requireInternalService` caller list.
  app.use('/internal', requireAuth, createInternalRoutes());

  // -- apiCalls quota for the whole user surface, ONCE, ahead of every /plugins
  //    router (the upload route included). `apiCallsQuota` meters each 2xx and
  //    arms a check that api-core `requireAuth` runs right after verifying the
  //    caller — so it covers the upload route's hand-wired chain and the shared
  //    chain below alike, without touching the multipart body. No router under
  //    /plugins mounts its own apiCalls meter/check (that would bill twice).
  //    Quotas of OTHER types stay on their routes: upload / deploy-generated
  //    reserve 'plugins', generate reserves 'aiCalls' (one AI generation spends
  //    an apiCall AND an aiCall). Deliberately NOT on /public (anonymous) or
  //    /internal (service principals) — both halves skip those callers anyway.
  app.use('/plugins', ...apiCallsQuota(quotaService));

  // -- Managed toolchain: the D14 initial default. Identity-gated by its own
  //    chain (requireAuth({ acceptServices: ['deploy-bootstrap'] }) +
  //    requireInternalService(['deploy-bootstrap'])) — the only route in this
  //    service that opts in to that signer — so
  //    BEFORE the shared org chain below — that service token carries no
  //    tenant org. The org-default routes are mounted on the same prefix
  //    BEHIND the shared chain below (they act on the caller's own org).
  app.use(TOOLCHAIN_MOUNT, createToolchainRoutes());

  // -- Upload route FIRST — manages its own middleware (auth → orgId →
  //    plugins:write → rate limit → multer → tenant scope). Must be registered
  //    before the shared chain below so no auth/quota middleware runs on a
  //    multipart upload before multer can parse the body. It only matches
  //    `POST /plugins`; everything else falls straight through.
  app.use('/plugins', createUploadPluginRoutes(quotaService, sseManager));

  // -- ONE shared auth + orgId + idempotency + tenant-scope pass ---------------
  // Every remaining /plugins route shares this single prefix chain, and each
  // mount below adds only its own gates. Stacking a separate
  // `createAuthenticatedWithOrgRoute()` / `createProtectedRoute()` in front of
  // each router re-ran the idempotency middleware for every mount a request fell
  // through: the second pass found the FIRST pass's pending reservation under the
  // same key and answered 409 (e.g. `POST /plugins/deploy-generated` with an
  // Idempotency-Key, which falls through the generate mount first).
  //
  // Gates added by a mount are PREFIX layers, so they also run for every request
  // that falls through to a later mount — the order below is load-bearing.
  app.use('/plugins', ...createAuthenticatedWithOrgRoute());

  // -- Plugin ecosystem — BEFORE the read routes so `/:id` can't
  //    catch "ecosystem" / "publisher" / "publish-requests". Each route owns
  //    its gate: the console is system-org only (requireSystemOrgPermission =
  //    system org + plugins:moderate / publishers:verify + aal2); the publisher
  //    routes only submit requests or restrict the caller's own listings.
  app.use('/plugins/ecosystem', createEcosystemConsoleRoutes());
  // The org toolchain default + the eligible-release list — the caller's OWN
  // org, each route owns its gate (pipelines:read to look, toolchain:manage +
  // step-up to change); before the read routes so `/:id` can't catch "toolchain".
  app.use(TOOLCHAIN_MOUNT, createOrgToolchainDefaultRoutes());
  // The Toolchain console (system org only: requireSystemOrgPermission(
  // 'toolchain:operate') on every route, step-up on every write); same prefix,
  // before the read routes for `/:id`.
  app.use(TOOLCHAIN_MOUNT, createToolchainConsoleRoutes());
  app.use('/plugins', createPublisherRoutes());
  // Installs + the org consumption policy + the in-app catalog —
  // org-local, each route owns its gate; before the read routes for `/:id`.
  app.use('/plugins', createInstallRoutes());
  // Reviews and ratings — each route owns its gate (plugins:read or
  // publishers:manage, a human session, per-user/org/IP throttles).
  app.use('/plugins', createReviewRoutes());
  // Per-org plugin security notification settings — each route owns its gate
  // (plugins:read to view, org_settings:write to change); before the read routes for `/:id`.
  app.use('/plugins', createSecurityNotificationRoutes());
  // Kept setup images — gate-refused images from the setup catalog load, listed
  // and promoted by the system org (system org + plugins:moderate + aal2 on each
  // route); before the read routes for `/:id`.
  app.use('/plugins', createKeptSetupImageRoutes());
  // A pipeline's plugin security — per-step resolution / lookup / scan state,
  // exposures + their triage, and the runtime check (each route owns its gate:
  // pipelines:read / pipelines:write / plugins:read); before the read routes
  // for `/:id`.
  app.use('/plugins', createPipelineSecurityRoutes());

  // -- Registry-storage view + the tenant prune (MUST be before the read routes
  //    so `/:id` can't catch "storage"). Each route owns its gate: plugins:read
  //    to look, plugins:write to retire a version's image.
  app.use('/plugins', createStorageRoutes());

  // -- Queue status routes (MUST be before read routes so `/:id` can't catch "queue").
  //    Every route owns its gate (requireSystemAdmin for the cross-org operator
  //    views, plugins:write for the org-scoped ones) so nothing leaks onto reads.
  app.use('/plugins/queue', createQueueStatusRoutes(quotaService));

  // -- AI generation routes (MUST be before read routes). The `ai_generation`
  //    feature gate lives on each generate route inside the router (see
  //    generate-plugin.ts) so it can't leak onto sibling `GET /plugins` reads.
  app.use('/plugins', createGeneratePluginRoutes(quotaService));

  // -- Deploy AI-generated plugin — owns its plugins:write gate + quota reservation.
  app.use('/plugins', createDeployGeneratedPluginRoutes(quotaService, sseManager));

  // -- Read routes (list, find, get-by-id).
  //    `plugins:read` is enforced PER ROUTE inside the router (a prefix-layer
  //    read gate would also run for the write mounts below, which a writer
  //    without:read would then fail).
  app.use('/plugins', createReadPluginRoutes());

  // -- Write routes — + plugins:write, ONE mount so the gate runs once --------
  //   - update / delete: plugins:write (delete's per-row publish gate is in-handler).
  //   - deprecate / yank (version lifecycle): plugins:write.
  //   - bulk: + `bulk_operations`, attached per route inside the router so the
  //     feature gate can't leak onto purge/restore. Mounted BEFORE `requireStepUp`
  //     so bulk calls don't require (and aren't blocked by) a step-up token.
  //   - purge / restore: + step-up (password re-verify). Purge is an irreversible
  //     hard-delete of a tombstone; restore reverses a soft-delete. `requireStepUp`
  //     consumes the step-up token's `jti` ONCE, so both routers sit behind a
  //     SINGLE step-up layer: a separate step-up mount per router made whichever
  //     came second see its own already-consumed jti (401 STEP_UP_REPLAY), and
  //     anything mounted after both (bulk) hit STEP_UP_REQUIRED.
  app.use(
    '/plugins',
    requirePermission('plugins:write'),
    createUpdatePluginRoutes(),
    createVersionLifecycleRoutes(),
    // DELETE /:id layers its OWN step-up, only for `?force=true`, and answers
    // the request itself — so the shared step-up below never re-consumes its jti.
    createDeletePluginRoutes(quotaService),
    createBulkPluginRoutes(quotaService),
    requireStepUp,
    createPurgePluginRoutes(quotaService),
    createRestorePluginRoutes(quotaService),
  );
}
