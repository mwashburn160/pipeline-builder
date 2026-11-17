// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal endpoints SERVED BY image-registry (router mounted at `/internal`,
 * behind `requireAuth`).
 *
 *  - plugin → sign a pushed plugin image / discard a refused one;
 *  - plugin → the public namespace (`/internal/plugin-publications*`);
 *  - plugin → anonymous submissions' quarantine repos (delete, build credential);
 *  - quota / plugin → per-org storage reads and a tenant prune;
 *  - platform → purge a deleted org's private namespace.
 *
 * The repository-name rules every body is validated against live HERE (and
 * image-registry's `services/namespaces.ts` re-exports them), so the caller's
 * idea of a valid repository and the registry's are one definition.
 */

import { z } from 'zod';
import { defineInternalEndpoint } from './define.js';
import { PUBLISHER_TIERS } from '../types/wire-vocabulary.js';

// ---------------------------------------------------------------------------
// Registry repository names
// ---------------------------------------------------------------------------

/**
 * A publisher handle / org id as ONE registry path component (Distribution's
 * component grammar): `public/<handle>/…`, and the org id in `org-<id>/…`.
 */
export const PUBLISHER_HANDLE_RE = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const PLUGIN_NAME_PATTERN = '[a-z0-9][a-z0-9._-]*';
const PLUGIN_REPO_RE = new RegExp(
  `^(system|org-[a-z0-9][a-z0-9-]*|quarantine|public/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)/${PLUGIN_NAME_PATTERN}$`,
);
const QUARANTINE_REPO_RE = /^quarantine\/[a-z0-9][a-z0-9-]{0,127}$/;
const PUBLIC_REPO_RE = new RegExp(`^public/([a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)/(${PLUGIN_NAME_PATTERN})$`);
const SYSTEM_PLUGIN_REPO_RE = new RegExp(`^system/(${PLUGIN_NAME_PATTERN})$`);
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
/** An anonymous submission id: one lowercase path component (`quarantine/<id>`). */
export const QUARANTINE_SUBMISSION_ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;

/** A plugin image repository: `system/<name>`, `org-<orgId>/<name>`, `quarantine/<id>` or `public/<handle>/<name>`. */
export function isPluginRepository(repository: string): boolean {
  return PLUGIN_REPO_RE.test(repository);
}
/** Exactly `quarantine/<submissionId>`. */
export function isQuarantineRepository(repository: string): boolean {
  return QUARANTINE_REPO_RE.test(repository);
}
/** Exactly `public/<publisherHandle>/<name>`. */
export function isPublicRepository(repository: string): boolean {
  return PUBLIC_REPO_RE.test(repository);
}
/** `system/<name>` for a plugin (never a `-base` image). */
export function isSystemPluginRepository(repository: string): boolean {
  const m = SYSTEM_PLUGIN_REPO_RE.exec(repository);
  return m !== null && !m[1]!.endsWith('-base');
}
/** `public/<handle>/<name>` split into its parts, or null. */
export function parsePublicRepository(repository: string): { handle: string; name: string } | null {
  const m = PUBLIC_REPO_RE.exec(repository);
  return m ? { handle: m[1]!, name: m[2]! } : null;
}
/** `sha256:<64 lowercase hex>`. */
export function isSha256Digest(digest: string): boolean {
  return DIGEST_RE.test(digest);
}
const inQuarantine = (r: string): boolean => r.startsWith('quarantine/');

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

const DIGEST_MESSAGE = 'digest must be sha256:<64 hex>';
/** A digest in a publication body (zod's own message when it is missing). */
const digest = z.string().regex(DIGEST_RE, DIGEST_MESSAGE);
/** A digest the route hand-checked before: ONE message for missing and malformed alike. */
const requiredDigest = z.string({ error: DIGEST_MESSAGE }).regex(DIGEST_RE, DIGEST_MESSAGE);
const handle = z.string().max(64).regex(PUBLISHER_HANDLE_RE, 'publisherHandle must be one lowercase registry path component');
const pluginName = z.string().max(128).regex(/^[a-z0-9][a-z0-9._-]*$/, 'name must be a lowercase plugin name');
/** A Distribution tag — and never a cosign companion (`sha256-….sig`). */
const version = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/, 'version must be a registry tag')
  .refine((v) => !/^sha256-/.test(v), 'version must not look like a cosign signature tag');
const tier = z.enum(PUBLISHER_TIERS);
const publisherOrgId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/i, 'publisherOrgId must be an org id');
const PUBLIC_REPO_MESSAGE = 'imageRepository must be public/<publisherHandle>/<name>';
const publicRepository = z.string().refine(isPublicRepository, PUBLIC_REPO_MESSAGE);
const requiredPublicRepository = z.string({ error: PUBLIC_REPO_MESSAGE }).refine(isPublicRepository, PUBLIC_REPO_MESSAGE);
/** The user whose decision this call executes (the registry's audit actor). */
const onBehalfOf = z.string().min(1).max(128).optional();

const NoParams = z.object({});

const ORG_COMPONENT_MESSAGE = 'orgId must be one registry path component';
/** `:orgId` as one registry path component, lowercased (repository names are). */
const OrgComponentParams = z.object({
  orgId: z.string({ error: ORG_COMPONENT_MESSAGE })
    .transform((s) => s.toLowerCase())
    .refine((s) => PUBLISHER_HANDLE_RE.test(s), ORG_COMPONENT_MESSAGE),
});

const SUBMISSION_ID_MESSAGE = 'submissionId must be one lowercase path component (the submission id)';
const SubmissionParams = z.object({
  submissionId: z.string({ error: SUBMISSION_ID_MESSAGE }).regex(QUARANTINE_SUBMISSION_ID_RE, SUBMISSION_ID_MESSAGE),
});

/** Every `public/*` mutation: a SYSTEM-org service token (a governance decision). */
const SYSTEM_ORG_AUTH = 'Service token minted for the SYSTEM org (403 ORG_MISMATCH otherwise). Writes audited on image-registry.';
/** The storage routes: a service token for the org named in the path. */
const OWN_ORG_AUTH = 'Service token minted for the org in the path — any other org is refused 403 ORG_MISMATCH and recorded as an authz denial.';

// ---------------------------------------------------------------------------
// Signing: metadata rides in headers, the SPDX document is the raw body
// ---------------------------------------------------------------------------

/** The header names of a signing request (the body is the raw SPDX JSON, streamed to disk). */
export const PLUGIN_SIGNATURE_HEADERS = { repository: 'x-pb-repository', digest: 'x-pb-digest' } as const;

const SIGNABLE_REPO_MESSAGE = 'x-pb-repository must be system/<name>, org-<orgId>/<name> or quarantine/<submissionId>';
const SIGNATURE_DIGEST_MESSAGE = 'x-pb-digest must be sha256:<64 hex>';

/**
 * The signing request's headers. `public/*` is signed only by the publish /
 * resign routes; `quarantine/*` only as exactly `quarantine/<submissionId>`.
 */
export const PluginSignatureHeadersSchema = z.object({
  [PLUGIN_SIGNATURE_HEADERS.repository]: z.string({ error: SIGNABLE_REPO_MESSAGE }).refine(
    (r) => isPluginRepository(r) && !isPublicRepository(r) && (!inQuarantine(r) || isQuarantineRepository(r)),
    SIGNABLE_REPO_MESSAGE,
  ),
  [PLUGIN_SIGNATURE_HEADERS.digest]: z.string({ error: SIGNATURE_DIGEST_MESSAGE }).regex(DIGEST_RE, SIGNATURE_DIGEST_MESSAGE),
});

// ---------------------------------------------------------------------------
// Public-namespace bodies
// ---------------------------------------------------------------------------

const PublishBody = z.object({
  // `quarantine/<submissionId>` is an approved anonymous submission.
  sourceRepository: z.string().refine(
    (r) => isPluginRepository(r) && !isPublicRepository(r) && (!inQuarantine(r) || isQuarantineRepository(r)),
    'sourceRepository must be org-<orgId>/<name>, system/<name> or quarantine/<submissionId>',
  ),
  digest,
  publisherHandle: handle,
  name: pluginName,
  version,
  tier,
  publisherOrgId: publisherOrgId.nullable(),
  actorId: onBehalfOf,
});

const ResignBody = z.object({
  imageRepository: publicRepository,
  digest,
  publisherHandle: handle,
  tier,
  /** Optional: re-point storage attribution (ownership transfer). */
  publisherOrgId: publisherOrgId.nullable().optional(),
  /** Optional progress hook for the plugin service's resumable re-sign job. */
  progress: z.object({
    completed: z.number().int().min(0),
    total: z.number().int().min(0),
  }).optional(),
  actorId: onBehalfOf,
});

const VersionTagBody = z.object({ imageRepository: publicRepository, version, digest, actorId: onBehalfOf });

/**
 * A collection: a long-yanked `public/*` digest, or — with the retired
 * version's own tag — the `system/<name>` build copy of a retired system version.
 */
const GcBody = z.union([
  z.object({ imageRepository: publicRepository, digest, actorId: onBehalfOf }),
  z.object({
    imageRepository: z.string().refine(isSystemPluginRepository, 'imageRepository must be public/<publisherHandle>/<name> or system/<name> (never a -base image)'),
    digest,
    version,
    actorId: onBehalfOf,
  }),
]);

const InvalidateBody = z.object({
  imageRepository: publicRepository.optional(),
  digest: digest.optional(),
}).refine((b) => !b.digest || b.imageRepository, 'digest requires imageRepository');

// ---------------------------------------------------------------------------
// Storage replies
// ---------------------------------------------------------------------------

const StorageBreakdownResponse = z.object({
  orgId: z.string(),
  bytes: z.number(),
  entries: z.array(z.object({
    repo: z.string(),
    tag: z.string(),
    totalBytes: z.number(),
    marginalBytes: z.number(),
    published: z.boolean(),
  })),
  computedAt: z.number(),
  incomplete: z.boolean(),
});

const RetentionBreakdownResponse = z.object({
  entries: z.array(z.object({
    name: z.string(),
    version: z.string(),
    totalBytes: z.number(),
    marginalBytes: z.number(),
  })),
  computedAt: z.number(),
  incomplete: z.boolean(),
});

const STORAGE_PRUNE_QUERY_MESSAGE = 'repo and tag query parameters are required';

// ---------------------------------------------------------------------------
// The contracts
// ---------------------------------------------------------------------------

export const IMAGE_REGISTRY_INTERNAL = {
  /**
   * Sign a pushed plugin image digest and attach its SBOM as a signed
   * attestation. NOT a JSON body: the raw SPDX document is the body (streamed
   * to disk, 413 past `REGISTRY_SBOM_MAX_BYTES`) and the metadata rides in the
   * {@link PLUGIN_SIGNATURE_HEADERS} ({@link PluginSignatureHeadersSchema}), so
   * it is refused before a byte of the document is read.
   */
  signPluginImage: defineInternalEndpoint({
    id: 'image-registry.signPluginImage',
    service: 'image-registry',
    method: 'POST',
    path: '/internal/plugin-signatures',
    callers: ['plugin'],
    auth: 'Service token minted for the org that owns the repository (system org for system/* and quarantine/*); 403 ORG_MISMATCH otherwise.',
    params: NoParams,
    response: z.object({ repository: z.string(), digest: z.string(), signed: z.literal(true) }),
  }),
  /**
   * Delete a pushed, signed image the scan gates / compliance refused, with
   * its cosign companions. Idempotent (`deleted: 0` when already gone).
   * `context` is the plugin service's why-and-whose; the registry keeps only
   * the known string fields of it (≤128 chars) for its audit row.
   */
  discardPluginImage: defineInternalEndpoint({
    id: 'image-registry.discardPluginImage',
    service: 'image-registry',
    method: 'POST',
    path: '/internal/plugin-images/discard',
    callers: ['plugin'],
    auth: 'Service token minted for the org that owns the repository; 403 ORG_MISMATCH otherwise.',
    params: NoParams,
    body: z.object({
      repository: z.string({ error: 'repository must be system/<name> or org-<orgId>/<name>' }).refine(
        (r) => isPluginRepository(r) && !isPublicRepository(r) && !inQuarantine(r),
        'repository must be system/<name> or org-<orgId>/<name>',
      ),
      digest: requiredDigest,
      context: z.unknown().optional(),
    }),
    response: z.object({ repository: z.string(), digest: z.string(), deleted: z.number() }),
  }),
  /** Copy the pinned digest into `public/<publisher>/<name>`, sign it fresh with the tier, tag the version. */
  publishPublicImage: defineInternalEndpoint({
    id: 'image-registry.publishPublicImage',
    service: 'image-registry',
    method: 'POST',
    path: '/internal/plugin-publications',
    callers: ['plugin'],
    auth: SYSTEM_ORG_AUTH,
    params: NoParams,
    body: PublishBody,
    response: z.object({ imageRepository: z.string(), digest: z.string() }),
  }),
  /** Replace a public image's signature with new trust/publisher annotations. */
  resignPublicImage: defineInternalEndpoint({
    id: 'image-registry.resignPublicImage',
    service: 'image-registry',
    method: 'POST',
    path: '/internal/plugin-publications/resign',
    callers: ['plugin'],
    auth: SYSTEM_ORG_AUTH,
    params: NoParams,
    body: ResignBody,
    response: z.object({ imageRepository: z.string(), digest: z.string(), tier, publisher: z.string() }),
  }),
  /** Remove a public version TAG (content stays). Idempotent. */
  yankPublicVersion: defineInternalEndpoint({
    id: 'image-registry.yankPublicVersion',
    service: 'image-registry',
    method: 'POST',
    path: '/internal/plugin-publications/yank',
    callers: ['plugin'],
    auth: SYSTEM_ORG_AUTH,
    params: NoParams,
    body: VersionTagBody,
    response: z.object({ imageRepository: z.string(), version: z.string(), digest: z.string(), yanked: z.literal(true) }),
  }),
  /** Put a yanked version's tag back on its published digest (unyank). Idempotent. */
  retagPublicVersion: defineInternalEndpoint({
    id: 'image-registry.retagPublicVersion',
    service: 'image-registry',
    method: 'POST',
    path: '/internal/plugin-publications/retag',
    callers: ['plugin'],
    auth: SYSTEM_ORG_AUTH,
    params: NoParams,
    body: VersionTagBody,
    response: z.object({ imageRepository: z.string(), version: z.string(), digest: z.string(), tagged: z.literal(true) }),
  }),
  /** Delete one cleared public digest, or a retired system version's build copy. 409 while a tag resolves to it. */
  collectImage: defineInternalEndpoint({
    id: 'image-registry.collectImage',
    service: 'image-registry',
    method: 'POST',
    path: '/internal/plugin-publications/gc',
    callers: ['plugin'],
    auth: SYSTEM_ORG_AUTH,
    params: NoParams,
    body: GcBody,
    response: z.object({ imageRepository: z.string(), digest: z.string(), deleted: z.boolean() }),
  }),
  /** A public image's signature and its signed `pb.trust` / `pb.publisher` annotations. 502 when cosign fails. */
  verifyPublication: defineInternalEndpoint({
    id: 'image-registry.verifyPublication',
    service: 'image-registry',
    method: 'GET',
    path: '/internal/plugin-publications/verify',
    callers: ['plugin'],
    auth: 'Any plugin service token (read-only).',
    params: NoParams,
    query: z.object({ imageRepository: requiredPublicRepository, digest: requiredDigest }),
    response: z.object({ signed: z.boolean(), tier: tier.nullable(), publisher: z.string().nullable() }),
  }),
  /** Drop the verify cache for one repository/digest, one repository, or all of it. */
  invalidateVerifyCache: defineInternalEndpoint({
    id: 'image-registry.invalidateVerifyCache',
    service: 'image-registry',
    method: 'POST',
    path: '/internal/plugin-publications/verify-cache/invalidate',
    callers: ['plugin'],
    auth: 'Any plugin service token.',
    params: NoParams,
    body: InvalidateBody,
    response: z.object({ invalidated: z.number() }),
  }),
  /** Drop an anonymous submission's quarantined build. Idempotent (`deleted: 0`). */
  deleteQuarantineRepository: defineInternalEndpoint({
    id: 'image-registry.deleteQuarantineRepository',
    service: 'image-registry',
    method: 'DELETE',
    path: '/internal/quarantine/:submissionId',
    callers: ['plugin'],
    auth: SYSTEM_ORG_AUTH,
    params: SubmissionParams,
    response: z.object({ repository: z.string(), deleted: z.number() }),
  }),
  /**
   * The registry-only credential a quarantined build pushes with. `ttlSeconds`
   * is clamped by the registry (and read leniently: anything non-numeric is
   * the minimum).
   */
  mintQuarantineCredential: defineInternalEndpoint({
    id: 'image-registry.mintQuarantineCredential',
    service: 'image-registry',
    method: 'POST',
    path: '/internal/quarantine/:submissionId/credential',
    callers: ['plugin'],
    auth: SYSTEM_ORG_AUTH,
    params: SubmissionParams,
    body: z.object({ ttlSeconds: z.number().optional() }),
    response: z.object({ username: z.string(), password: z.string(), expiresAt: z.string() }),
  }),
  /** One org's registry storage in bytes (the push gate's own measurement). 500 when the scan fails. */
  orgStorageUsage: defineInternalEndpoint({
    id: 'image-registry.orgStorageUsage',
    service: 'image-registry',
    method: 'GET',
    path: '/internal/storage-usage/:orgId',
    callers: ['quota'],
    auth: OWN_ORG_AUTH,
    params: OrgComponentParams,
    response: z.object({ bytes: z.number() }),
  }),
  /**
   * Per-version storage attribution. `?scope=retention` (system org only)
   * answers the retention view instead (any other `scope` is ignored).
   */
  orgStorageBreakdown: defineInternalEndpoint({
    id: 'image-registry.orgStorageBreakdown',
    service: 'image-registry',
    method: 'GET',
    path: '/internal/storage-breakdown/:orgId',
    callers: ['plugin'],
    auth: OWN_ORG_AUTH,
    params: OrgComponentParams,
    query: z.object({ scope: z.string().optional() }),
    response: z.union([StorageBreakdownResponse, RetentionBreakdownResponse]),
  }),
  /**
   * Drop one version TAG in the org's own namespace (never `public/*` or
   * `quarantine/*`). `repo` and `tag` ride the QUERY: a DELETE carries no body.
   * Idempotent (`pruned: false` when the tag is already gone).
   */
  pruneOrgStorage: defineInternalEndpoint({
    id: 'image-registry.pruneOrgStorage',
    service: 'image-registry',
    method: 'DELETE',
    path: '/internal/storage-prune/:orgId',
    callers: ['plugin'],
    auth: OWN_ORG_AUTH,
    params: OrgComponentParams,
    query: z.object({
      repo: z.string({ error: STORAGE_PRUNE_QUERY_MESSAGE }).min(1).max(255),
      // A tag, never a digest: deleting by digest would take any second tag with it.
      tag: z.string({ error: STORAGE_PRUNE_QUERY_MESSAGE }).min(1).max(128).regex(/^[\w][\w.-]*$/, 'tag must be a Docker tag'),
    }),
    response: z.object({ repo: z.string(), tag: z.string(), pruned: z.boolean() }),
  }),
  /**
   * Purge a deleted org's PRIVATE `org-<id>/*` namespace (`public/*` copies are
   * kept). A non-empty `failed` means bytes remain.
   */
  purgeOrgNamespace: defineInternalEndpoint({
    id: 'image-registry.purgeOrgNamespace',
    service: 'image-registry',
    method: 'DELETE',
    path: '/internal/org-namespace/:orgId',
    callers: ['platform'],
    auth: 'Platform service token (the org is already deleted, so the caller list is the authorization).',
    params: OrgComponentParams,
    response: z.object({ repositories: z.number(), deleted: z.number(), failed: z.array(z.string()) }),
  }),
} as const;
