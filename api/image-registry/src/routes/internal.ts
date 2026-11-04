// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  actorId,
  audited,
  ErrorCode,
  getParam,
  requireInternalService,
  sendBadRequest,
  sendError,
  sendSuccess,
  SYSTEM_ORG_ID,
  recordAudit,
  recordAuthzDenial,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import express, { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';

import { registerPublicationRoutes } from './internal-publications.js';
import { cosignCompanionTags } from '../services/cosign-tags.js';
import { PUBLISHER_HANDLE_RE, QUARANTINE_PREFIX, inQuarantineNamespace, isPluginRepository, isPublicRepository, isQuarantineRepository, isSha256Digest, repoOwnerOrgId } from '../services/namespaces.js';
import {
  PluginSigningError,
  signPluginImage,
} from '../services/plugin-signing.js';
import { isQuarantineSubmissionId, mintQuarantineCredential } from '../services/quarantine-credential.js';
import { deleteManifest, deleteTag, getManifest, headManifest, isNotFound } from '../services/registry-client.js';
import { deleteOrgNamespace, deleteQuarantineRepository } from '../services/registry-gc.js';
import { computeOrgStorageBreakdown, computeOrgStorageUsage, invalidateOrgStorageCache } from '../services/storage-usage.js';

/** Path of the signing route — also excluded from the app's global 1mb JSON parser. */
export const PLUGIN_SIGNATURES_PATH = '/internal/plugin-signatures';

/** Base path (under `/internal`) of the quarantine-namespace delete hook. */
export const QUARANTINE_PATH = '/quarantine';

/** Path (under `/internal`) of the refused-build discard hook. */
export const PLUGIN_IMAGE_DISCARD_PATH = '/plugin-images/discard';

/**
 * Base path (under `/internal`) of the per-org storage reading. The quota
 * service's client (api/quota `REGISTRY_STORAGE_USAGE_PATH`) calls
 * `/internal/storage-usage/<orgId>` on this service directly — keep the two in step.
 */
export const STORAGE_USAGE_PATH = '/storage-usage';

/**
 * Per-version storage attribution for an org — what each image version costs
 * and what deleting it would actually free. Read by the PLUGIN service, which
 * owns plugin versions and knows which ones a pipeline still references, so it
 * can join these byte figures to eligibility before showing a tenant anything.
 *
 * Separate from {@link STORAGE_USAGE_PATH} because the cost differs in kind:
 * the rollup is a cached single number on the push-gate's path, while this is an
 * on-demand catalog walk with a HEAD per blob. Nothing latency-sensitive may
 * call it.
 */
export const STORAGE_BREAKDOWN_PATH = '/storage-breakdown';

/**
 * Tenant-driven reclaim of ONE image version's storage: drop the version tag so
 * the org's measured usage stops counting its layers.
 *
 * WHY A TAG DELETE IS ENOUGH, which is not obvious. An org's `storageBytes` is
 * measured by walking `listTags` → manifest → blobs (see `storage-usage.ts`), so
 * usage is REFERENCE-based, not disk-based: the moment the tag is gone its
 * layers leave the org's total, and the cap stops refusing pushes. Reclaiming
 * the bytes ON DISK is a separate, operator-driven `garbage-collect` — as this
 * service's own GC notes record — and nothing a tenant action should trigger.
 *
 * So this route deliberately does NOT run GC. Driving a namespace GC from a
 * tenant request would move a destructive registry-wide operation inside the
 * tenant boundary to achieve something the tenant cannot observe, while the
 * thing it CAN observe — its quota — is already freed.
 *
 * It deletes the TAG rather than the manifest, which is the conservative
 * choice twice over: a digest-pinned pipeline keeps working (pipelines pin by
 * digest — the same reason the public yank uses a tag delete), and a manifest
 * shared by a second tag cannot be removed out from under it.
 */
export const STORAGE_PRUNE_PATH = '/storage-prune';

/**
 * An organization's PRIVATE namespace teardown, called by the platform's
 * org-delete cascade. Published (`public/*`) copies are deliberately kept —
 * see {@link deleteOrgNamespace} for why each excluded namespace is excluded.
 */
export const ORG_NAMESPACE_PATH = '/org-namespace';

/** The private-namespace prefix: `org-<id>/…`. */
const ORG_NAMESPACE_PREFIX = 'org-';

/** Which version to drop: a repo in the caller's namespace, and a tag. */
const storagePruneSchema = z.object({
  repo: z.string().min(1).max(255),
  // A tag, never a digest: deleting by digest would take any second tag
  // pointing at the same manifest with it.
  tag: z.string().min(1).max(128).regex(/^[\w][\w.-]*$/, 'tag must be a Docker tag'),
});

/**
 * Delete one manifest by digest plus the cosign `.sig` / `.att` companion tags
 * signed for it. Companions first: a signature with no image is litter, an
 * image with a signature but no catalog row is the thing being removed. Every
 * step tolerates 404, so a retried discard converges. Returns manifests deleted.
 */
async function deleteSignedManifest(repository: string, digest: string): Promise<number> {
  let deleted = 0;
  for (const tag of cosignCompanionTags(digest)) {
    try {
      const companion = await getManifest(repository, tag);
      await deleteManifest(repository, companion.digest);
      deleted++;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  try {
    await deleteManifest(repository, digest);
    deleted++;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  return deleted;
}

/**
 * Refuse a service call whose token's org does not own `repository` (403
 * ORG_MISMATCH) and put the attempt on the `authz.denied` trail: a plugin
 * token minted for one org asking to sign/discard another org's image is
 * either a bug or a forgery, and an error response alone leaves no record.
 */
function denyOrgMismatch(req: Request, res: Response, repository: string, action: string): void {
  recordAuthzDenial(req, `owner org of ${repository} (${action})`);
  sendError(res, 403, `Forbidden: repo "${repository}" is not owned by the requesting org.`, ErrorCode.ORG_MISMATCH);
}

/** The plugin service's optional `context` on a discard: why, which build, whose. Unknown/oversized fields are dropped. */
const DISCARD_CONTEXT_KEYS = ['refusalCode', 'pluginVersion', 'jobId', 'requestId', 'userId', 'scope', 'reason', 'keptSetupImageId'] as const;
type DiscardContext = Partial<Record<typeof DISCARD_CONTEXT_KEYS[number], string>>;

function discardContext(raw: unknown): DiscardContext {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: DiscardContext = {};
  for (const key of DISCARD_CONTEXT_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.length > 0 && v.length <= 128) out[key] = v;
  }
  return out;
}

/**
 * An SPDX document for a large image (thousands of packages) runs to several MB;
 * this route parses its own body with a limit sized for that, instead of the
 * app-wide 1mb.
 */
const SBOM_BODY_LIMIT = '32mb';

/**
 * Internal (service-to-service) routes. Mounted after `requireAuth`.
 *
 *  - POST /internal/plugin-signatures — plugin → sign a pushed plugin image
 *    digest and attach its SBOM as a signed attestation.
 *  - /internal/plugin-publications* — plugin → the public namespace
 *    (publish / resign / yank / gc / verify); see internal-publications.ts.
 *  - POST /internal/plugin-images/discard — plugin → delete a pushed, signed
 *    image its scan gates / compliance refused, with its signature.
 *  - DELETE /internal/quarantine/:submissionId — plugin → drop an anonymous
 *    submission's quarantined build (`quarantine/<submissionId>`) once it is
 *    decided or expired.
 *  - POST /internal/quarantine/:submissionId/credential — plugin → the
 *    registry-only credential that submission's build pushes with.
 *  - GET /internal/storage-usage/:orgId — quota → one org's registry storage in
 *    bytes, so the quota dashboard's `storageBytes.used` shows a real number.
 */
export function createInternalRoutes(): Router {
  const router: Router = Router();

  router.post(
    '/plugin-signatures',
    // Only the plugin build worker asks for signatures — never a user token,
    // however privileged (the key is what synth trusts). Gated BEFORE the large
    // body is parsed, so no other caller can make this route buffer 32mb.
    requireInternalService({ callers: ['plugin'] }) as RequestHandler,
    audited('registry.image.sign') as RequestHandler,
    express.json({ limit: SBOM_BODY_LIMIT }) as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const { repository, digest, sbom } = (req.body ?? {}) as { repository?: unknown; digest?: unknown; sbom?: unknown };
      // `public/*` is signed only by the publish/resign routes (fresh, annotated).
      // `quarantine/<submissionId>` is signed so its SBOM attestation survives into
      // the approved public copy; it is owned by the system org (repoOwnerOrgId).
      if (typeof repository !== 'string' || !isPluginRepository(repository) || isPublicRepository(repository)
        || (inQuarantineNamespace(repository) && !isQuarantineRepository(repository))) {
        return sendBadRequest(res, 'repository must be system/<name>, org-<orgId>/<name> or quarantine/<submissionId>', ErrorCode.VALIDATION_ERROR);
      }
      if (typeof digest !== 'string' || !isSha256Digest(digest)) {
        return sendBadRequest(res, 'digest must be sha256:<64 hex>', ErrorCode.VALIDATION_ERROR);
      }
      if (!sbom || typeof sbom !== 'object' || Array.isArray(sbom) || typeof (sbom as { spdxVersion?: unknown }).spdxVersion !== 'string') {
        return sendBadRequest(res, 'sbom must be an SPDX JSON document', ErrorCode.VALIDATION_ERROR);
      }

      // The plugin service mints its token for the org whose build this is — it
      // may only get that org's images signed (the system org owns `system/*`).
      const ownerOrgId = repoOwnerOrgId(repository);
      const callerOrgId = req.user?.organizationId?.toLowerCase();
      if (!ownerOrgId || ownerOrgId !== callerOrgId) {
        return denyOrgMismatch(req, res, repository, 'registry.image.sign');
      }

      // Sign only what is actually in the registry, in THIS repository.
      if (!await headManifest(repository, digest)) {
        return sendError(res, 404, `No manifest ${digest} in ${repository}`, ErrorCode.NOT_FOUND);
      }

      try {
        await signPluginImage({ repository, digest, sbom: sbom as Record<string, unknown> });
      } catch (err) {
        if (err instanceof PluginSigningError) {
          ctx.log('ERROR', 'Plugin image signing failed', { repository, digest, error: err.message });
          return sendError(res, 502, err.message, ErrorCode.SERVICE_UNAVAILABLE);
        }
        throw err;
      }

      ctx.log('COMPLETED', 'Signed plugin image', { repository, digest });
      recordAudit({
        action: 'registry.image.sign',
        actorId: actorId({}),
        orgId: ownerOrgId,
        affectedOrgId: ownerOrgId,
        outcome: 'success',
        targetType: 'registry-image',
        targetId: repository,
        details: { repo: repository, digest, sbom: 'spdx-json' },
      });
      return sendSuccess(res, 200, { repository, digest, signed: true });
    }),
  );

  // A build the plugin service's scan gates or compliance REFUSED after the
  // image was already pushed and signed (the gates read the signed SBOM, so
  // they cannot run earlier). Left alone the manifest sits in the org's
  // namespace with a valid platform signature — pullable, verifiable, and
  // marked as refused by nothing but a missing catalog row. Deletes the
  // manifest (Distribution drops the tag pointing at it with it) and its cosign
  // companions. The caller has checked that no stored version references the
  // digest; this route cannot (the catalog is the plugin service's), which is
  // why it is the plugin service's alone. Idempotent: a gone manifest is
  // `deleted: 0`.
  router.post(
    PLUGIN_IMAGE_DISCARD_PATH,
    requireInternalService({ callers: ['plugin'] }) as RequestHandler,
    audited('registry.image.delete') as RequestHandler,
    express.json({ limit: '16kb' }) as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const { repository, digest, context } = (req.body ?? {}) as { repository?: unknown; digest?: unknown; context?: unknown };
      // The org's own namespaces only: `public/*` is append-only and
      // `quarantine/*` has its own lifecycle (DELETE /internal/quarantine).
      if (typeof repository !== 'string' || !isPluginRepository(repository) || isPublicRepository(repository) || inQuarantineNamespace(repository)) {
        return sendBadRequest(res, 'repository must be system/<name> or org-<orgId>/<name>', ErrorCode.VALIDATION_ERROR);
      }
      if (typeof digest !== 'string' || !isSha256Digest(digest)) {
        return sendBadRequest(res, 'digest must be sha256:<64 hex>', ErrorCode.VALIDATION_ERROR);
      }
      // Same binding as signing: the plugin service's token carries the org
      // whose build this was, and may only discard that org's images.
      const ownerOrgId = repoOwnerOrgId(repository);
      if (!ownerOrgId || ownerOrgId !== req.user?.organizationId?.toLowerCase()) {
        return denyOrgMismatch(req, res, repository, 'registry.image.delete');
      }
      const why = discardContext(context);

      const deleted = await deleteSignedManifest(repository, digest);
      ctx.log('COMPLETED', 'Discarded refused plugin image', { repository, digest, deleted });
      if (deleted > 0) {
        recordAudit({
          action: 'registry.image.delete',
          // The user whose build was refused (the plugin worker acts for them).
          actorId: actorId({ userId: why.userId }),
          orgId: ownerOrgId,
          affectedOrgId: ownerOrgId,
          outcome: 'success',
          targetType: 'registry-image',
          targetId: repository,
          details: {
            // A lapsed/superseded kept setup image is its own scope, so a
            // reviewer can tell the sweep from a build refusal.
            scope: why.scope === 'kept-setup-image' ? 'kept-setup-image' : 'refused-build',
            repo: repository,
            digest,
            manifestsDeleted: deleted,
            refusalCode: why.refusalCode ?? null,
            pluginVersion: why.pluginVersion ?? null,
            jobId: why.jobId ?? null,
            requestId: why.requestId ?? null,
            ...(why.reason && { reason: why.reason }),
            ...(why.keptSetupImageId && { keptSetupImageId: why.keptSetupImageId }),
          },
        });
      }
      return sendSuccess(res, 200, { repository, digest, deleted });
    }),
  );

  // Anonymous plugin submissions: the plugin
  // service's hook for a submission that reached a terminal state (rejected,
  // gate_failed, expired, or approved once the publish copied it out). Deletes
  // every manifest in `quarantine/<submissionId>`; idempotent (a gone repo →
  // `deleted: 0`). The 30-day age sweep (startQuarantineGcScheduler) is the
  // backstop. Audited as `registry.gc` — a destructive namespace prune.
  router.delete(
    `${QUARANTINE_PATH}/:submissionId`,
    requireInternalService({ callers: ['plugin'] }) as RequestHandler,
    audited('registry.gc') as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const submissionId = getParam(req.params, 'submissionId');
      const repository = `${QUARANTINE_PREFIX}${submissionId ?? ''}`;
      if (!submissionId || !isQuarantineRepository(repository)) {
        return sendBadRequest(res, 'submissionId must be one lowercase path component (the submission id)', ErrorCode.VALIDATION_ERROR);
      }
      // Moderation state is the system org's: the plugin mints this call's token for it.
      if (req.user?.organizationId?.toLowerCase() !== SYSTEM_ORG_ID) {
        recordAuthzDenial(req, `system org for ${repository} (registry.gc)`);
        return sendError(res, 403, 'Forbidden: quarantine repositories are managed under the system org.', ErrorCode.ORG_MISMATCH);
      }
      const result = await deleteQuarantineRepository(repository, 'requested');
      ctx.log('COMPLETED', 'Deleted quarantine repository', { repository, deleted: result.deleted });
      if (result.deleted > 0) {
        recordAudit({
          action: 'registry.gc',
          actorId: actorId({}),
          orgId: SYSTEM_ORG_ID,
          affectedOrgId: SYSTEM_ORG_ID,
          outcome: 'success',
          targetType: 'registry-namespace',
          targetId: repository,
          details: { prefix: QUARANTINE_PREFIX, repo: repository, manifestsDeleted: result.deleted, reason: 'requested' },
        });
      }
      return sendSuccess(res, 200, result);
    }),
  );

  // The credential an anonymous submission's build runs with: push/pull on
  // `quarantine/<submissionId>` only, accepted by no platform service. It
  // changes no durable state (it expires on its own; the token endpoint
  // re-checks it on every use), but it is a write grant, so each mint is audited.
  router.post(
    `${QUARANTINE_PATH}/:submissionId/credential`,
    requireInternalService({ callers: ['plugin'] }) as RequestHandler,
    audited('registry.quarantine.credential.mint') as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const submissionId = getParam(req.params, 'submissionId');
      if (!submissionId || !isQuarantineSubmissionId(submissionId)) {
        return sendBadRequest(res, 'submissionId must be one lowercase path component (the submission id)', ErrorCode.VALIDATION_ERROR);
      }
      if (req.user?.organizationId?.toLowerCase() !== SYSTEM_ORG_ID) {
        recordAuthzDenial(req, `system org for quarantine/${submissionId} (registry.quarantine.credential.mint)`);
        return sendError(res, 403, 'Forbidden: quarantine repositories are managed under the system org.', ErrorCode.ORG_MISMATCH);
      }
      const ttlSeconds = Number((req.body as { ttlSeconds?: unknown } | undefined)?.ttlSeconds ?? 0);
      const credential = await mintQuarantineCredential(submissionId, ttlSeconds);
      ctx.log('COMPLETED', 'Minted quarantine build credential', { submissionId, expiresAt: credential.expiresAt });
      // A push credential for one quarantine repo: short-lived and accepted by
      // nothing but this registry's token endpoint, yet still a write grant
      // handed out on a service's say-so — so each mint is on the trail (expiry
      // + TTL, never the secret).
      recordAudit({
        action: 'registry.quarantine.credential.mint',
        actorId: actorId({}),
        orgId: SYSTEM_ORG_ID,
        affectedOrgId: SYSTEM_ORG_ID,
        outcome: 'success',
        targetType: 'registry-namespace',
        targetId: `${QUARANTINE_PREFIX}${submissionId}`,
        details: { submissionId, repo: `${QUARANTINE_PREFIX}${submissionId}`, expiresAt: credential.expiresAt, ttlSeconds },
      });
      return sendSuccess(res, 200, credential);
    }),
  );

  // One org's registry storage, for the quota service's READS (the dashboard and
  // the at-risk view fill `storageBytes.used` from it — nothing increments that
  // quota, because this service measures it live). Same measurement the push
  // gate enforces with (`computeOrgStorageUsage`: the org's namespace plus the
  // public copies it published, blobs deduplicated, 60s cached), so the number a
  // tenant sees is the number it is refused at. Only `bytes` crosses the wire:
  // the repo count is a fact about the org's layout the quota service has no use
  // for. An `incomplete` scan still answers with what it measured — the consumer
  // is display-only (the push gate keeps failing closed on its own), and an
  // under-count is a better number than the 0 it would otherwise show. A failed
  // scan throws → 500, which the quota client reads as "unknown" (fail-soft).
  // Read-only, so not audited.
  router.get(
    `${STORAGE_USAGE_PATH}/:orgId`,
    requireInternalService({ callers: ['quota'] }) as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      // Registry repository names are lowercase, so the namespace is too; the id
      // must be ONE path component or `org-<id>/` would reach past its own prefix.
      const orgId = getParam(req.params, 'orgId')?.toLowerCase();
      if (!orgId || !PUBLISHER_HANDLE_RE.test(orgId)) {
        return sendBadRequest(res, 'orgId must be one registry path component', ErrorCode.VALIDATION_ERROR);
      }
      // The quota service mints this call's token for the org it is asking about;
      // a token for one org reading another's footprint is a bug or a forgery.
      if (req.user?.organizationId?.toLowerCase() !== orgId) {
        recordAuthzDenial(req, `storage usage of org ${orgId}`);
        return sendError(res, 403, 'Forbidden: storage usage can only be read for the token\'s own org.', ErrorCode.ORG_MISMATCH);
      }
      const usage = await computeOrgStorageUsage(orgId);
      ctx.log('COMPLETED', 'Read org storage usage', { orgId, bytes: usage.bytes, incomplete: usage.incomplete });
      return sendSuccess(res, 200, { bytes: usage.bytes });
    }),
  );

  // Per-version attribution, for the plugin service's prune surface and the
  // "what is consuming my storage" view. Read-only, so not audited — the PRUNE
  // it informs is the audited action, in the plugin service.
  //
  // Carries `incomplete` to the caller rather than swallowing it: an
  // under-stated breakdown must be labelled partial, because a tenant reading
  // it is about to decide what to delete.
  router.get(
    `${STORAGE_BREAKDOWN_PATH}/:orgId`,
    requireInternalService({ callers: ['plugin'] }) as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const orgId = getParam(req.params, 'orgId')?.toLowerCase();
      if (!orgId || !PUBLISHER_HANDLE_RE.test(orgId)) {
        return sendBadRequest(res, 'orgId must be one registry path component', ErrorCode.VALIDATION_ERROR);
      }
      // Same confinement as the usage route: a token for one org reading
      // another's per-version footprint is a bug or a forgery.
      if (req.user?.organizationId?.toLowerCase() !== orgId) {
        recordAuthzDenial(req, `storage breakdown of org ${orgId}`);
        return sendError(res, 403, 'Forbidden: a storage breakdown can only be read for the token\'s own org.', ErrorCode.ORG_MISMATCH);
      }
      const breakdown = await computeOrgStorageBreakdown(orgId);
      ctx.log('COMPLETED', 'Read org storage breakdown', {
        orgId, bytes: breakdown.bytes, versions: breakdown.entries.length, incomplete: breakdown.incomplete,
      });
      return sendSuccess(res, 200, breakdown);
    }),
  );

  // Reclaim one version's storage for a tenant. The PLUGIN service decides
  // eligibility (no pipeline references it, it is not a published copy) and
  // audits the tenant-facing action; this route enforces the registry-side
  // invariant that only the org's OWN namespace can be touched.
  router.delete(
    `${STORAGE_PRUNE_PATH}/:orgId`,
    requireInternalService({ callers: ['plugin'] }) as RequestHandler,
    // Body parsers are per-route in this router, not router-wide. A `{repo,tag}`
    // body is tiny, so the limit is tight.
    express.json({ limit: '4kb' }) as RequestHandler,
    audited('registry.image.delete') as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const orgId = getParam(req.params, 'orgId')?.toLowerCase();
      if (!orgId || !PUBLISHER_HANDLE_RE.test(orgId)) {
        return sendBadRequest(res, 'orgId must be one registry path component', ErrorCode.VALIDATION_ERROR);
      }
      if (req.user?.organizationId?.toLowerCase() !== orgId) {
        recordAuthzDenial(req, `storage prune for org ${orgId}`);
        return sendError(res, 403, 'Forbidden: storage can only be pruned for the token\'s own org.', ErrorCode.ORG_MISMATCH);
      }
      const parsed = storagePruneSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendBadRequest(res, 'repo and tag are required', ErrorCode.VALIDATION_ERROR);
      }
      const { repo, tag } = parsed.data;
      // The ONLY namespace a tenant may prune is its own, decided by the same
      // ownership helper the rest of the service uses rather than by a prefix
      // comparison written here. `public/*` is excluded on purpose and not as
      // an oversight: a published copy's bytes stay billed to the publisher,
      // and removing them is an unlist/withdraw decision in the ecosystem flow,
      // not a storage cleanup. `system/*`, `library/*` and `quarantine/*`
      // belong to the platform — `repoOwnerOrgId` maps those to the system org,
      // so they can never match a tenant's id.
      if (repoOwnerOrgId(repo)?.toLowerCase() !== orgId) {
        recordAuthzDenial(req, `storage prune of ${repo} by org ${orgId}`);
        return sendError(res, 403, `Forbidden: ${repo} is not in this organization's namespace.`, ErrorCode.ORG_MISMATCH);
      }
      await deleteTag(repo, tag);
      // The org's figure is measured, not metered, so evicting the cached
      // reading is what makes the freed space visible promptly.
      invalidateOrgStorageCache(orgId);
      ctx.log('COMPLETED', 'Pruned image version for storage', { orgId, repo, tag });
      recordAudit({
        // `registry.image.delete` is the declared remote action for an explicit
        // image/tag delete; `registry.tag.delete` exists only as this service's
        // local operator-log event, not in the remote trail's vocabulary.
        action: 'registry.image.delete',
        actorId: actorId({}),
        orgId,
        affectedOrgId: orgId,
        outcome: 'success',
        targetType: 'registry-tag',
        targetId: `${repo}:${tag}`,
        details: { repo, tag, reason: 'storage_prune' },
      });
      return sendSuccess(res, 200, { repo, tag, pruned: true });
    }),
  );

  // Reclaim a DELETED org's private images. Before this the cascade purged
  // Postgres, Mongo and message attachment blobs but left every `org-<id>/*`
  // repository on disk — billed to nobody, with no tenant left to prune it and
  // scheduled GC off by default.
  //
  // The caller is the PLATFORM service (it owns org lifecycle), and the org is
  // already deleted by the time this runs, so the token cannot be checked
  // against the org the way the storage routes' tokens are — the caller list IS
  // the authorization, and the namespace rule is enforced inside
  // `deleteOrgNamespace`.
  router.delete(
    `${ORG_NAMESPACE_PATH}/:orgId`,
    requireInternalService({ callers: ['platform'] }) as RequestHandler,
    audited('registry.gc') as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const orgId = getParam(req.params, 'orgId')?.toLowerCase();
      if (!orgId || !PUBLISHER_HANDLE_RE.test(orgId)) {
        return sendBadRequest(res, 'orgId must be one registry path component', ErrorCode.VALIDATION_ERROR);
      }
      const result = await deleteOrgNamespace(orgId);
      ctx.log('COMPLETED', 'Purged an org\'s private registry namespace', { orgId, ...result });
      if (result.repositories > 0 || result.failed.length > 0) {
        recordAudit({
          action: 'registry.gc',
          actorId: actorId({}),
          orgId: SYSTEM_ORG_ID,
          affectedOrgId: orgId,
          // A partial purge leaves bytes behind, so it must not read as clean.
          outcome: result.failed.length > 0 ? 'failure' : 'success',
          targetType: 'registry-namespace',
          targetId: `${ORG_NAMESPACE_PREFIX}${orgId}/`,
          details: {
            prefix: `${ORG_NAMESPACE_PREFIX}${orgId}/`,
            repositories: result.repositories,
            manifestsDeleted: result.deleted,
            failed: result.failed,
            reason: 'org_deleted',
            // Said in the trail because it is the part someone will ask about.
            keptPublished: 'public/* copies are retained: other organizations install them',
          },
        });
      }
      return sendSuccess(res, 200, result);
    }),
  );

  registerPublicationRoutes(router);

  return router;
}
