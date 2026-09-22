// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Publication records: which org is billed for each `public/<handle>/<name>`
 * repository (public bytes count toward the
 * PUBLISHER org's `storageBytes` rollup).
 *
 * The authoritative handle → org mapping is the plugin service's
 * `publishers.owner_org_id`, but this service has no database and no client
 * for it, and the storage push-gate runs on the `/token` hot path. So the
 * plugin service hands the publisher org id over on every publish (and on a
 * re-sign after an ownership transfer), and this service persists it IN THE
 * REGISTRY ITSELF — durable wherever the images are, no extra datastore:
 *
 * registry-meta/publications/<handle>/<name>:owner
 *     → an OCI artifact manifest (empty config + one empty layer) whose
 *       annotations carry the publisher org id.
 *
 * One record per public REPOSITORY (not per handle), so a listing that moves to
 * another publisher on an ownership transfer is re-attributed without touching
 * the rest of the old handle's listings. `registry-meta/*` is closed to every
 * external identity at the token service; only the management identity reads
 * or writes it. A record with no org (`publisherOrgId: null`) is unattributed —
 * its bytes are platform-absorbed.
 */

import { createHash } from 'crypto';
import { envInt, createLogger, errorMessage } from '@pipeline-builder/api-core';
import { inPublicNamespace } from './namespaces.js';
import {
  getManifest,
  isNotFound,
  listRepositoriesUnderPrefix,
  putManifest,
  uploadSmallBlob,
} from './registry-client.js';

const logger = createLogger('public-publications');

export const PUBLICATION_RECORD_PREFIX = 'registry-meta/publications/';
const RECORD_TAG = 'owner';
const ARTIFACT_TYPE = 'application/vnd.pipeline-builder.publication.v1';
const ORG_ANNOTATION = 'dev.pipeline-builder.publisher-org-id';
const REPO_ANNOTATION = 'dev.pipeline-builder.repository';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';

/** The OCI 1.1 empty descriptor (`{}`), used as both config and the one layer. */
const EMPTY_BYTES = Buffer.from('{}');
const EMPTY_DESCRIPTOR = {
  mediaType: 'application/vnd.oci.empty.v1+json',
  digest: `sha256:${createHash('sha256').update(EMPTY_BYTES).digest('hex')}`,
  size: EMPTY_BYTES.length,
};

/** Override via `REGISTRY_PUBLICATION_CACHE_TTL_MS` (default 60s, like the storage rollup). */
const CACHE_TTL_MS = envInt('REGISTRY_PUBLICATION_CACHE_TTL_MS', 60_000, { min: 1 });
let cache: { map: Map<string, string | null>; computedAt: number } | null = null;

/** `public/<handle>/<name>` → its record repository. */
export function recordRepository(publicRepository: string): string {
  if (!inPublicNamespace(publicRepository)) throw new Error(`Not a public repository: ${publicRepository}`);
  return `${PUBLICATION_RECORD_PREFIX}${publicRepository.slice('public/'.length)}`;
}

/**
 * Persist (or re-point) the org billed for `publicRepository`. A no-op when
 * the record already says the same thing.
 */
export async function writePublicationRecord(publicRepository: string, publisherOrgId: string | null): Promise<void> {
  const repo = recordRepository(publicRepository);
  const wanted = publisherOrgId ?? '';
  try {
    const current = await getManifest(repo, RECORD_TAG);
    const annotations = (current.body as { annotations?: Record<string, string> }).annotations ?? {};
    if (annotations[ORG_ANNOTATION] === wanted) return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  await uploadSmallBlob(repo, EMPTY_DESCRIPTOR.digest, EMPTY_BYTES);
  const manifest = {
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    artifactType: ARTIFACT_TYPE,
    config: EMPTY_DESCRIPTOR,
    layers: [EMPTY_DESCRIPTOR],
    annotations: { [REPO_ANNOTATION]: publicRepository, [ORG_ANNOTATION]: wanted },
  };
  await putManifest(repo, RECORD_TAG, Buffer.from(JSON.stringify(manifest)), OCI_MANIFEST);
  cache = null;
  logger.info('Recorded public publication owner', { repository: publicRepository, attributed: !!publisherOrgId });
}

/**
 * Every recorded `public/*` repository → its billed org (null = unattributed).
 * Cached for {@link CACHE_TTL_MS}. `complete` is false when any record could
 * not be read — the fail-closed push-gate then treats the rollup as
 * inconclusive rather than under-count the org.
 */
export async function readPublicationOwners(opts: { force?: boolean } = {}): Promise<{ owners: Map<string, string | null>; complete: boolean }> {
  if (!opts.force && cache && Date.now() - cache.computedAt < CACHE_TTL_MS) {
    return { owners: cache.map, complete: true };
  }
  const owners = new Map<string, string | null>();
  let complete = true;
  const repos = await listRepositoriesUnderPrefix(PUBLICATION_RECORD_PREFIX);
  for (const repo of repos) {
    try {
      const { body } = await getManifest(repo, RECORD_TAG);
      const annotations = (body as { annotations?: Record<string, string> }).annotations ?? {};
      const publicRepository = annotations[REPO_ANNOTATION] ?? `public/${repo.slice(PUBLICATION_RECORD_PREFIX.length)}`;
      owners.set(publicRepository, annotations[ORG_ANNOTATION] || null);
    } catch (err) {
      if (isNotFound(err)) continue;
      complete = false;
      logger.warn('Publication record unreadable', { repo, error: errorMessage(err) });
    }
  }
  if (complete) cache = { map: owners, computedAt: Date.now() };
  return { owners, complete };
}

/** The `public/*` repositories billed to `orgId`. */
export async function publicRepositoriesOwnedBy(orgId: string): Promise<{ repositories: string[]; complete: boolean }> {
  const { owners, complete } = await readPublicationOwners();
  const want = orgId.toLowerCase();
  const repositories = [...owners.entries()].filter(([, org]) => org?.toLowerCase() === want).map(([repo]) => repo).sort();
  return { repositories, complete };
}

/** The org billed for `publicRepository`, or null (unrecorded / unattributed). */
export async function publicationOwner(publicRepository: string): Promise<string | null> {
  const { owners } = await readPublicationOwners();
  return owners.get(publicRepository) ?? null;
}

/** @internal Tests only. */
export function _resetPublicationCache(): void {
  cache = null;
}
