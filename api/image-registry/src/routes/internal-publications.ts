// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  actorId,
  audited,
  ErrorCode,
  requireInternalService,
  sendBadRequest,
  sendError,
  sendSuccess,
  SYSTEM_ORG_ID,
  validateBody,
} from '@pipeline-builder/api-core';
import { incCounter, withRoute } from '@pipeline-builder/api-server';
import { type RequestHandler, type Response, type Router } from 'express';
import { z } from 'zod';

import { repoOwnerOrgId } from './images/repo-access.js';
import { emitImageRegistryAudit } from '../services/audit.js';
import {
  isPluginRepository,
  isPublicRepository,
  isQuarantineRepository,
  PluginSigningError,
  PUBLISHER_HANDLE_RE,
} from '../services/plugin-signing.js';
import { publicationOwner } from '../services/public-publications.js';
import {
  gcPublicImage,
  invalidateVerifyCache,
  PublicationConflictError,
  PublicationMetrics,
  PublicationNotFoundError,
  publishPublicImage,
  reportResignProgress,
  resignPublicImageOp,
  retagPublicVersion,
  SourceVerificationError,
  TRUST_TIERS,
  verifyPublication,
  yankPublicVersion,
} from '../services/public-publishing.js';

/** Base path of the public-namespace routes (under `/internal`). */
export const PLUGIN_PUBLICATIONS_PATH = '/plugin-publications';

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'digest must be sha256:<64 hex>');
const handle = z.string().max(64).regex(PUBLISHER_HANDLE_RE, 'publisherHandle must be one lowercase registry path component');
const pluginName = z.string().max(128).regex(/^[a-z0-9][a-z0-9._-]*$/, 'name must be a lowercase plugin name');
/** A Distribution tag — and never a cosign companion (`sha256-….sig`). */
const version = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/, 'version must be a registry tag')
  .refine((v) => !/^sha256-/.test(v), 'version must not look like a cosign signature tag');
const tier = z.enum(TRUST_TIERS);
const orgId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/i, 'publisherOrgId must be an org id');
const publicRepository = z.string().refine(isPublicRepository, 'imageRepository must be public/<publisherHandle>/<name>');

const PublishSchema = z.object({
  // `quarantine/<submissionId>` is an approved anonymous submission (plugin
  // ecosystem §4.2 / W5). Its owner is the system org (repoOwnerOrgId), so the
  // org check below admits only a system-org token for it — and the route is
  // plugin-only — i.e. only the plugin service executing a moderation approval.
  sourceRepository: z.string().refine(
    (r) => isPluginRepository(r) && !isPublicRepository(r) && (!r.startsWith('quarantine/') || isQuarantineRepository(r)),
    'sourceRepository must be org-<orgId>/<name>, system/<name> or quarantine/<submissionId>',
  ),
  digest,
  publisherHandle: handle,
  name: pluginName,
  version,
  tier,
  publisherOrgId: orgId.nullable(),
});

const ResignSchema = z.object({
  imageRepository: publicRepository,
  digest,
  publisherHandle: handle,
  tier,
  /** Optional: re-point storage attribution (ownership transfer). */
  publisherOrgId: orgId.nullable().optional(),
  /** Optional progress hook for the plugin service's resumable re-sign job. */
  progress: z.object({
    completed: z.number().int().min(0),
    total: z.number().int().min(0),
  }).optional(),
});

const YankSchema = z.object({ imageRepository: publicRepository, version, digest });
const GcSchema = z.object({ imageRepository: publicRepository, digest });
const InvalidateSchema = z.object({
  imageRepository: publicRepository.optional(),
  digest: digest.optional(),
}).refine((b) => !b.digest || b.imageRepository, 'digest requires imageRepository');

/** The org the audit records the action under: the calling service token's, else the system org. */
function callerOrg(user: { organizationId?: string } | undefined): string {
  return user?.organizationId?.toLowerCase() || SYSTEM_ORG_ID;
}

/** Map the publishing service's typed failures onto HTTP. Returns true when handled. */
function sendPublicationError(res: Response, err: unknown): boolean {
  if (err instanceof PublicationConflictError) {
    sendError(res, 409, err.message, ErrorCode.CONFLICT);
    return true;
  }
  if (err instanceof PublicationNotFoundError) {
    sendError(res, 404, err.message, ErrorCode.NOT_FOUND);
    return true;
  }
  if (err instanceof SourceVerificationError) {
    sendError(res, 409, err.message, ErrorCode.IMAGE_VERIFICATION_FAILED);
    return true;
  }
  if (err instanceof PluginSigningError) {
    sendError(res, 502, err.message, ErrorCode.SERVICE_UNAVAILABLE);
    return true;
  }
  return false;
}

/**
 * The public plugin namespace (plugin ecosystem §3.3). Every route is the
 * plugin service's alone: it decides WHAT is published, re-signed, yanked or
 * collected (approval, tier, step-manifest references); this service does the
 * registry side with the management identity — the only identity that may
 * write `public/*`.
 *
 *  - POST /internal/plugin-publications                        — copy + fresh sign + SBOM attest + tag
 *  - POST /internal/plugin-publications/resign                 — re-sign with new annotations
 *  - POST /internal/plugin-publications/yank                   — remove a version tag (content stays)
 *  - POST /internal/plugin-publications/retag                  — put a yanked version's tag back (unyank)
 *  - POST /internal/plugin-publications/gc                     — delete one cleared, untagged digest
 *  - GET  /internal/plugin-publications/verify                 — signature + tier/publisher annotations
 *  - POST /internal/plugin-publications/verify-cache/invalidate
 */
export function registerPublicationRoutes(router: Router): void {
  const pluginOnly = requireInternalService({ callers: ['plugin'] }) as RequestHandler;

  router.post(PLUGIN_PUBLICATIONS_PATH, pluginOnly, audited('registry.image.publish') as RequestHandler, withRoute(async ({ req, res, ctx }) => {
    const v = validateBody(req, PublishSchema);
    if (!v.ok) return sendBadRequest(res, v.error, ErrorCode.VALIDATION_ERROR);
    const body = v.value;

    // Publishing is a system-org decision (approval) about the SOURCE org's
    // image: the service token must be minted for one of those two orgs.
    const org = callerOrg(req.user);
    if (org !== SYSTEM_ORG_ID && org !== repoOwnerOrgId(body.sourceRepository)) {
      return sendError(res, 403, `Forbidden: the requesting org may not publish from "${body.sourceRepository}".`, ErrorCode.ORG_MISMATCH);
    }

    let result;
    try {
      result = await publishPublicImage(body);
    } catch (err) {
      incCounter(PublicationMetrics.PUBLISH, { outcome: err instanceof PublicationConflictError ? 'conflict' : 'failure' });
      if (sendPublicationError(res, err)) {
        ctx.log('ERROR', 'Plugin publication failed', { source: body.sourceRepository, digest: body.digest, error: (err as Error).message });
        return;
      }
      throw err;
    }

    incCounter(PublicationMetrics.PUBLISH, { outcome: result.alreadyPublished ? 'republished' : 'success' });
    ctx.log('COMPLETED', 'Published plugin image', { target: result.imageRepository, digest: result.digest, version: body.version });
    emitImageRegistryAudit({
      action: 'registry.image.publish',
      actorId: actorId({}),
      orgId: org,
      ...(body.publisherOrgId && { affectedOrgId: body.publisherOrgId }),
      outcome: 'success',
      targetType: 'registry-image',
      targetId: result.imageRepository,
      details: {
        repo: result.imageRepository,
        source: body.sourceRepository,
        digest: result.digest,
        version: body.version,
        tier: body.tier,
        publisher: body.publisherHandle,
        alreadyPublished: result.alreadyPublished,
      },
    });
    return sendSuccess(res, 200, { imageRepository: result.imageRepository, digest: result.digest });
  }));

  router.post(`${PLUGIN_PUBLICATIONS_PATH}/resign`, pluginOnly, audited('registry.image.resign') as RequestHandler, withRoute(async ({ req, res, ctx }) => {
    const v = validateBody(req, ResignSchema);
    if (!v.ok) return sendBadRequest(res, v.error, ErrorCode.VALIDATION_ERROR);
    const body = v.value;

    try {
      await resignPublicImageOp(body);
    } catch (err) {
      incCounter(PublicationMetrics.RESIGN, { outcome: 'failure' });
      if (sendPublicationError(res, err)) return;
      throw err;
    } finally {
      // Report progress whether this image succeeded or not — a stalled job is
      // one whose progress timestamp stops moving, not one that hit an error.
      if (body.progress) reportResignProgress(body.progress);
    }

    incCounter(PublicationMetrics.RESIGN, { outcome: 'success' });
    ctx.log('COMPLETED', 'Re-signed public plugin image', { repo: body.imageRepository, digest: body.digest, tier: body.tier });
    const affected = body.publisherOrgId ?? await publicationOwner(body.imageRepository).catch(() => null);
    emitImageRegistryAudit({
      action: 'registry.image.resign',
      actorId: actorId({}),
      orgId: callerOrg(req.user),
      ...(affected && { affectedOrgId: affected }),
      outcome: 'success',
      targetType: 'registry-image',
      targetId: body.imageRepository,
      details: { repo: body.imageRepository, digest: body.digest, tier: body.tier, publisher: body.publisherHandle },
    });
    return sendSuccess(res, 200, { imageRepository: body.imageRepository, digest: body.digest, tier: body.tier, publisher: body.publisherHandle });
  }));

  router.post(`${PLUGIN_PUBLICATIONS_PATH}/yank`, pluginOnly, audited('registry.image.yank') as RequestHandler, withRoute(async ({ req, res, ctx }) => {
    const v = validateBody(req, YankSchema);
    if (!v.ok) return sendBadRequest(res, v.error, ErrorCode.VALIDATION_ERROR);
    const body = v.value;

    let result;
    try {
      result = await yankPublicVersion(body.imageRepository, body.version, body.digest);
    } catch (err) {
      incCounter(PublicationMetrics.YANK, { outcome: err instanceof PublicationConflictError ? 'conflict' : 'failure' });
      if (sendPublicationError(res, err)) return;
      throw err;
    }

    incCounter(PublicationMetrics.YANK, { outcome: result.alreadyYanked ? 'already_yanked' : 'success' });
    ctx.log('COMPLETED', 'Yanked public plugin version', { ...body, alreadyYanked: result.alreadyYanked });
    if (!result.alreadyYanked) {
      const affected = await publicationOwner(body.imageRepository).catch(() => null);
      emitImageRegistryAudit({
        action: 'registry.image.yank',
        actorId: actorId({}),
        orgId: callerOrg(req.user),
        ...(affected && { affectedOrgId: affected }),
        outcome: 'success',
        targetType: 'registry-image',
        targetId: body.imageRepository,
        details: { repo: body.imageRepository, version: body.version, digest: body.digest },
      });
    }
    return sendSuccess(res, 200, { imageRepository: body.imageRepository, version: body.version, digest: body.digest, yanked: true });
  }));

  router.post(`${PLUGIN_PUBLICATIONS_PATH}/retag`, pluginOnly, audited('registry.image.publish') as RequestHandler, withRoute(async ({ req, res, ctx }) => {
    const v = validateBody(req, YankSchema);
    if (!v.ok) return sendBadRequest(res, v.error, ErrorCode.VALIDATION_ERROR);
    const body = v.value;

    let result;
    try {
      result = await retagPublicVersion(body.imageRepository, body.version, body.digest);
    } catch (err) {
      incCounter(PublicationMetrics.PUBLISH, { outcome: err instanceof PublicationConflictError ? 'conflict' : 'failure' });
      if (sendPublicationError(res, err)) return;
      throw err;
    }

    incCounter(PublicationMetrics.PUBLISH, { outcome: result.alreadyTagged ? 'republished' : 'retagged' });
    ctx.log('COMPLETED', 'Re-tagged public plugin version', { ...body, alreadyTagged: result.alreadyTagged });
    if (!result.alreadyTagged) {
      const affected = await publicationOwner(body.imageRepository).catch(() => null);
      emitImageRegistryAudit({
        action: 'registry.image.publish',
        actorId: actorId({}),
        orgId: callerOrg(req.user),
        ...(affected && { affectedOrgId: affected }),
        outcome: 'success',
        targetType: 'registry-image',
        targetId: body.imageRepository,
        details: { repo: body.imageRepository, version: body.version, digest: body.digest, retag: true },
      });
    }
    return sendSuccess(res, 200, { imageRepository: body.imageRepository, version: body.version, digest: body.digest, tagged: true });
  }));

  router.post(`${PLUGIN_PUBLICATIONS_PATH}/gc`, pluginOnly, audited('registry.image.gc') as RequestHandler, withRoute(async ({ req, res, ctx }) => {
    const v = validateBody(req, GcSchema);
    if (!v.ok) return sendBadRequest(res, v.error, ErrorCode.VALIDATION_ERROR);
    const body = v.value;
    // Look the owner up BEFORE the delete — the audit names the org it affected.
    const affected = await publicationOwner(body.imageRepository).catch(() => null);

    let result;
    try {
      result = await gcPublicImage(body.imageRepository, body.digest);
    } catch (err) {
      incCounter(PublicationMetrics.GC, { outcome: err instanceof PublicationConflictError ? 'conflict' : 'failure' });
      if (sendPublicationError(res, err)) return;
      throw err;
    }

    incCounter(PublicationMetrics.GC, { outcome: result.deleted ? 'success' : 'already_deleted' });
    ctx.log('COMPLETED', 'Collected public plugin image', { ...body, deleted: result.deleted });
    if (result.deleted) {
      emitImageRegistryAudit({
        action: 'registry.image.gc',
        actorId: actorId({}),
        orgId: callerOrg(req.user),
        ...(affected && { affectedOrgId: affected }),
        outcome: 'success',
        targetType: 'registry-image',
        targetId: body.imageRepository,
        details: { repo: body.imageRepository, digest: body.digest },
      });
    }
    return sendSuccess(res, 200, { imageRepository: body.imageRepository, digest: body.digest, deleted: result.deleted });
  }));

  router.get(`${PLUGIN_PUBLICATIONS_PATH}/verify`, pluginOnly, withRoute(async ({ req, res }) => {
    const imageRepository = typeof req.query.imageRepository === 'string' ? req.query.imageRepository : '';
    const d = typeof req.query.digest === 'string' ? req.query.digest : '';
    if (!isPublicRepository(imageRepository)) {
      return sendBadRequest(res, 'imageRepository must be public/<publisherHandle>/<name>', ErrorCode.VALIDATION_ERROR);
    }
    if (!digest.safeParse(d).success) return sendBadRequest(res, 'digest must be sha256:<64 hex>', ErrorCode.VALIDATION_ERROR);

    try {
      return sendSuccess(res, 200, await verifyPublication(imageRepository, d));
    } catch (err) {
      if (sendPublicationError(res, err)) return;
      throw err;
    }
  }));

  router.post(`${PLUGIN_PUBLICATIONS_PATH}/verify-cache/invalidate`, pluginOnly, withRoute(async ({ req, res }) => {
    const v = validateBody(req, InvalidateSchema);
    if (!v.ok) return sendBadRequest(res, v.error, ErrorCode.VALIDATION_ERROR);
    const invalidated = invalidateVerifyCache(v.value.imageRepository, v.value.digest);
    return sendSuccess(res, 200, { invalidated });
  }));
}
