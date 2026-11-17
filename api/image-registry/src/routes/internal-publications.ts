// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  actorId,
  AppError,
  audited,
  contractErrorMessage,
  contractRoute,
  ErrorCode,
  IMAGE_REGISTRY_INTERNAL,
  parseContractQuery,
  requireInternalService,
  sendBadRequest,
  sendError,
  sendSuccess,
  SYSTEM_ORG_ID,
  validateBody,
  recordAudit,
  recordAuthzDenial,
} from '@pipeline-builder/api-core';
import { incCounter, withRoute } from '@pipeline-builder/api-server';
import { type RequestHandler, type Router } from 'express';

import {
  PluginSigningError,
} from '../services/plugin-signing.js';
import { publicationOwner } from '../services/public-publications.js';
import {
  gcPublicImage,
  gcSystemImage,
  invalidateVerifyCache,
  PublicationConflictError,
  PublicationMetrics,
  publishPublicImage,
  reportResignProgress,
  resignPublicImageOp,
  retagPublicVersion,
  verifyPublication,
  yankPublicVersion,
} from '../services/public-publishing.js';

const C = IMAGE_REGISTRY_INTERNAL;
const MOUNT = '/internal';

/** Base path of the public-namespace routes (under `/internal`). */
export const PLUGIN_PUBLICATIONS_PATH = contractRoute(C.publishPublicImage, MOUNT);

/**
 * Socket timeout for every `/internal/plugin-publications*` route, replacing
 * the 25s every service applies by default. A publish copies, verifies, signs
 * and attests a whole image, which takes minutes for a large toolchain image.
 * Equal to the plugin service's client timeout for these calls
 * (api/plugin/src/services/ecosystem/registry.ts); a deploy-contracts test
 * keeps the two equal, because the shorter one cuts the call.
 */
export const PUBLICATION_TIMEOUT_MS = 600_000;

// The request bodies (and their messages) are the contracts' — api-core
// `IMAGE_REGISTRY_INTERNAL` — so the plugin service's client validates against
// exactly what these routes accept.

/** The calling service token's org (lowercased), or '' when the token names none. */
function callerOrg(user: { organizationId?: string } | undefined): string {
  return user?.organizationId?.toLowerCase() ?? '';
}

/**
 * Every `public/*` mutation is a system-org decision (an approval, a tier
 * change, a yank, a collection): the plugin service mints its token for the
 * system org for these calls, so a token minted for any other org — or naming
 * none — is refused here, before the body is read.
 */
function systemOrgOnly(action: string): RequestHandler {
  return (req, res, next) => {
    if (callerOrg(req.user) === SYSTEM_ORG_ID) return next();
    recordAuthzDenial(req, `system org (${action})`);
    return sendError(res, 403, `Forbidden: only the system org may ${action.replace('registry.image.', '')} a public plugin image.`, ErrorCode.ORG_MISMATCH);
  };
}

/**
 * Run one publication operation, counting a failure under `metric` (a
 * conflict as `conflict`). The publishing errors are AppErrors the route
 * wrapper answers (409 / 404); a signing-tool failure answers 502.
 */
async function counted<T>(metric: string, fn: () => Promise<T>, onError?: (err: Error) => void): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    incCounter(metric, { outcome: err instanceof PublicationConflictError ? 'conflict' : 'failure' });
    onError?.(err as Error);
    if (err instanceof PluginSigningError) throw new AppError(502, ErrorCode.SERVICE_UNAVAILABLE, err.message);
    throw err;
  }
}

/** Audit one successful publication change against a `public/*` repository. */
function auditPublication(
  action: 'registry.image.publish' | 'registry.image.resign' | 'registry.image.yank' | 'registry.image.gc',
  affectedOrgId: string | null | undefined,
  repo: string,
  details: Record<string, unknown>,
  onBehalfOfUserId?: string,
): void {
  recordAudit({
    action,
    actorId: actorId({ userId: onBehalfOfUserId }),
    orgId: SYSTEM_ORG_ID,
    ...(affectedOrgId && { affectedOrgId }),
    outcome: 'success',
    targetType: 'registry-image',
    targetId: repo,
    details,
  });
}

/**
 * The public plugin namespace (docs/plugin-publishing.md). Every route is the
 * plugin service's alone: it decides WHAT is published, re-signed, yanked or
 * collected (approval, tier, step-manifest references); this service does the
 * registry side with the management identity — the only identity that may
 * write `public/*`.
 *
 *  - POST /internal/plugin-publications — copy + fresh sign + SBOM attest + tag
 *  - POST /internal/plugin-publications/resign — re-sign with new annotations
 *  - POST /internal/plugin-publications/yank — remove a version tag (content stays)
 *  - POST /internal/plugin-publications/retag — put a yanked version's tag back (unyank)
 *  - POST /internal/plugin-publications/gc — delete one cleared, untagged public digest, or a
 *    retired system version's `system/<name>` build copy (with its own `version` tag)
 *  - GET /internal/plugin-publications/verify — signature + tier/publisher annotations
 *  - POST /internal/plugin-publications/verify-cache/invalidate
 */
export function registerPublicationRoutes(router: Router): void {
  // Every publication contract names the same single caller.
  const pluginOnly = requireInternalService({ callers: [...C.publishPublicImage.callers] }) as RequestHandler;
  const route = (c: (typeof C)[keyof typeof C]): string => contractRoute(c, MOUNT);

  router.use(PLUGIN_PUBLICATIONS_PATH, ((req, res, next) => {
    res.setTimeout(PUBLICATION_TIMEOUT_MS);
    req.setTimeout(PUBLICATION_TIMEOUT_MS);
    next();
  }) as RequestHandler);

  router.post(route(C.publishPublicImage), pluginOnly, systemOrgOnly('registry.image.publish'), audited('registry.image.publish') as RequestHandler, withRoute(async ({ req, res, ctx }) => {
    const v = validateBody(req, C.publishPublicImage.body!);
    if (!v.ok) return sendBadRequest(res, v.error, ErrorCode.VALIDATION_ERROR);
    const body = v.value;

    const result = await counted(PublicationMetrics.PUBLISH, () => publishPublicImage(body), (err) =>
      ctx.log('ERROR', 'Plugin publication failed', { source: body.sourceRepository, digest: body.digest, error: err.message }));

    incCounter(PublicationMetrics.PUBLISH, { outcome: result.alreadyPublished ? 'republished' : 'success' });
    ctx.log('COMPLETED', 'Published plugin image', { target: result.imageRepository, digest: result.digest, version: body.version });
    auditPublication('registry.image.publish', body.publisherOrgId, result.imageRepository, {
      repo: result.imageRepository,
      source: body.sourceRepository,
      digest: result.digest,
      version: body.version,
      tier: body.tier,
      publisher: body.publisherHandle,
      alreadyPublished: result.alreadyPublished,
    }, body.actorId);
    return sendSuccess(res, 200, { imageRepository: result.imageRepository, digest: result.digest });
  }));

  router.post(route(C.resignPublicImage), pluginOnly, systemOrgOnly('registry.image.resign'), audited('registry.image.resign') as RequestHandler, withRoute(async ({ req, res, ctx }) => {
    const v = validateBody(req, C.resignPublicImage.body!);
    if (!v.ok) return sendBadRequest(res, v.error, ErrorCode.VALIDATION_ERROR);
    const body = v.value;

    try {
      await counted(PublicationMetrics.RESIGN, () => resignPublicImageOp(body));
    } finally {
      // Report progress whether this image succeeded or not — a stalled job is
      // one whose progress timestamp stops moving, not one that hit an error.
      if (body.progress) reportResignProgress(body.progress);
    }

    incCounter(PublicationMetrics.RESIGN, { outcome: 'success' });
    ctx.log('COMPLETED', 'Re-signed public plugin image', { repo: body.imageRepository, digest: body.digest, tier: body.tier });
    const affected = body.publisherOrgId ?? await publicationOwner(body.imageRepository).catch(() => null);
    auditPublication('registry.image.resign', affected, body.imageRepository,
      { repo: body.imageRepository, digest: body.digest, tier: body.tier, publisher: body.publisherHandle }, body.actorId);
    return sendSuccess(res, 200, { imageRepository: body.imageRepository, digest: body.digest, tier: body.tier, publisher: body.publisherHandle });
  }));

  router.post(route(C.yankPublicVersion), pluginOnly, systemOrgOnly('registry.image.yank'), audited('registry.image.yank') as RequestHandler, withRoute(async ({ req, res, ctx }) => {
    const v = validateBody(req, C.yankPublicVersion.body!);
    if (!v.ok) return sendBadRequest(res, v.error, ErrorCode.VALIDATION_ERROR);
    const body = v.value;

    const result = await counted(PublicationMetrics.YANK, () => yankPublicVersion(body.imageRepository, body.version, body.digest));

    incCounter(PublicationMetrics.YANK, { outcome: result.alreadyYanked ? 'already_yanked' : 'success' });
    ctx.log('COMPLETED', 'Yanked public plugin version', { ...body, alreadyYanked: result.alreadyYanked });
    if (!result.alreadyYanked) {
      const affected = await publicationOwner(body.imageRepository).catch(() => null);
      auditPublication('registry.image.yank', affected, body.imageRepository,
        { repo: body.imageRepository, version: body.version, digest: body.digest }, body.actorId);
    }
    return sendSuccess(res, 200, { imageRepository: body.imageRepository, version: body.version, digest: body.digest, yanked: true });
  }));

  router.post(route(C.retagPublicVersion), pluginOnly, systemOrgOnly('registry.image.publish'), audited('registry.image.publish') as RequestHandler, withRoute(async ({ req, res, ctx }) => {
    const v = validateBody(req, C.retagPublicVersion.body!);
    if (!v.ok) return sendBadRequest(res, v.error, ErrorCode.VALIDATION_ERROR);
    const body = v.value;

    const result = await counted(PublicationMetrics.PUBLISH, () => retagPublicVersion(body.imageRepository, body.version, body.digest));

    incCounter(PublicationMetrics.PUBLISH, { outcome: result.alreadyTagged ? 'republished' : 'retagged' });
    ctx.log('COMPLETED', 'Re-tagged public plugin version', { ...body, alreadyTagged: result.alreadyTagged });
    if (!result.alreadyTagged) {
      const affected = await publicationOwner(body.imageRepository).catch(() => null);
      auditPublication('registry.image.publish', affected, body.imageRepository,
        { repo: body.imageRepository, version: body.version, digest: body.digest, retag: true }, body.actorId);
    }
    return sendSuccess(res, 200, { imageRepository: body.imageRepository, version: body.version, digest: body.digest, tagged: true });
  }));

  router.post(route(C.collectImage), pluginOnly, systemOrgOnly('registry.image.gc'), audited('registry.image.gc') as RequestHandler, withRoute(async ({ req, res, ctx }) => {
    const v = validateBody(req, C.collectImage.body!);
    if (!v.ok) return sendBadRequest(res, v.error, ErrorCode.VALIDATION_ERROR);
    const body = v.value;
    const system = 'version' in body;
    // Look the owner up BEFORE the delete — the audit names the org it affected.
    // A system/<name> copy is the system org's own.
    const affected = system ? SYSTEM_ORG_ID : await publicationOwner(body.imageRepository).catch(() => null);

    const result = await counted(PublicationMetrics.GC, () => (system
      ? gcSystemImage(body.imageRepository, body.digest, body.version)
      : gcPublicImage(body.imageRepository, body.digest)));

    incCounter(PublicationMetrics.GC, { outcome: result.deleted ? 'success' : 'already_deleted' });
    ctx.log('COMPLETED', system ? 'Collected retired system plugin image' : 'Collected public plugin image', { ...body, deleted: result.deleted });
    if (result.deleted) {
      auditPublication('registry.image.gc', affected, body.imageRepository, {
        repo: body.imageRepository, digest: body.digest, ...(system ? { version: body.version, reason: 'retired' } : {}),
      }, body.actorId);
    }
    return sendSuccess(res, 200, { imageRepository: body.imageRepository, digest: body.digest, deleted: result.deleted });
  }));

  router.get(route(C.verifyPublication), pluginOnly, withRoute(async ({ req, res }) => {
    const q = parseContractQuery(C.verifyPublication, req);
    if (!q.ok) return sendBadRequest(res, contractErrorMessage(q), ErrorCode.VALIDATION_ERROR);
    const { imageRepository, digest: d } = q.value;

    try {
      return sendSuccess(res, 200, await verifyPublication(imageRepository, d));
    } catch (err) {
      if (err instanceof PluginSigningError) throw new AppError(502, ErrorCode.SERVICE_UNAVAILABLE, err.message);
      throw err;
    }
  }));

  router.post(route(C.invalidateVerifyCache), pluginOnly, withRoute(async ({ req, res }) => {
    const v = validateBody(req, C.invalidateVerifyCache.body!);
    if (!v.ok) return sendBadRequest(res, v.error, ErrorCode.VALIDATION_ERROR);
    const invalidated = invalidateVerifyCache(v.value.imageRepository, v.value.digest);
    return sendSuccess(res, 200, { invalidated });
  }));
}
