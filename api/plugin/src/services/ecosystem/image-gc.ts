// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Collection of `public/*` images nobody can reach any more. A yank only
 * removes the version TAG — deployed pipelines keep pulling by digest — so the
 * content stays until it is both long yanked ({@link PUBLIC_IMAGE_GC_DAYS})
 * and referenced by NO pipeline, by the one rule every removal path asks
 * (pipeline-data `findVersionReferences`): a live pipeline's declared
 * resolution, any deployed step manifest (a soft-deleted pipeline's too — its
 * CodePipeline still runs the image), or an open deployed exposure. This pass
 * selects those digests and asks image-registry to delete them; image-registry
 * adds the last guard it can check (no tag still resolves to the digest).
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { executeRows, findVersionReferences, runWithTenantContext, schema, versionReferencedPredicate } from '@pipeline-builder/pipeline-data';
import { and, eq, sql } from 'drizzle-orm';

import { gcImage, RegistryPublicationError } from './registry.js';
import { elevated } from './store.js';

const logger = createLogger('ecosystem-image-gc');

/** A yanked version's public image is kept at least this long. */
export const PUBLIC_IMAGE_GC_DAYS = 180;
/** Digests collected per pass (the rest wait for the next one). */
const GC_BATCH = 50;

interface Candidate { image_repository: string; image_digest: string; version: string }

/**
 * Digests of versions yanked before `cutoff` and not yet collected, where no
 * OTHER version still needs the same image (unyanked, or yanked more
 * recently) and no pipeline references the digest
 * (`versionReferencedPredicate` — the SQL form of `findVersionReferences`). A
 * soft-deleted pipeline still counts: it can be restored, and would then pull
 * the digest again.
 */
async function candidates(cutoff: Date, limit: number): Promise<Candidate[]> {
  return elevated((tx) => executeRows<Candidate>(tx, sql`
    SELECT DISTINCT ON (v.image_repository, v.image_digest) v.image_repository, v.image_digest, v.version
      FROM plugin_listing_versions v
     WHERE v.yanked_at IS NOT NULL AND v.yanked_at <= ${cutoff}
       AND v.image_collected_at IS NULL
       AND v.image_digest IS NOT NULL AND v.image_repository IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM plugin_listing_versions o
          WHERE o.image_repository = v.image_repository AND o.image_digest = v.image_digest
            AND (o.yanked_at IS NULL OR o.yanked_at > ${cutoff}))
       AND NOT ${versionReferencedPredicate({ digest: sql`v.image_digest`, name: sql`NULL`, version: sql`NULL`, orgId: sql`NULL` })}
     LIMIT ${limit}`));
}

/**
 * Whether a pipeline references the digest NOW — asked again right before the
 * delete, since a deploy can land between the candidate query and the registry
 * call. Fails closed: an unanswerable check keeps the image.
 */
async function stillReferenced(c: Candidate): Promise<boolean> {
  try {
    // Matched by digest (every pipeline that pins this image, any org); the name
    // and version only label the target.
    const refs = await runWithTenantContext({ isSuperAdmin: true }, () => findVersionReferences({
      pluginName: c.image_repository, pluginVersion: c.version, imageDigest: c.image_digest,
    }));
    return refs.length > 0;
  } catch (err) {
    logger.warn('Reference check failed; public image kept', { imageRepository: c.image_repository, digest: c.image_digest, error: errorMessage(err) });
    return true;
  }
}

async function markCollected(c: Candidate, now: Date): Promise<void> {
  const V = schema.pluginListingVersion;
  await elevated(async (tx) => {
    await tx.update(V).set({ imageCollectedAt: now })
      .where(and(eq(V.imageRepository, c.image_repository), eq(V.imageDigest, c.image_digest)));
  });
}

/**
 * One collection pass. Returns how many digests image-registry deleted. A
 * digest a tag still resolves to (409) is left for a later pass; any other
 * failure is logged and the pass moves on.
 */
export async function collectYankedPublicImages(now: Date = new Date(), signal?: AbortSignal): Promise<number> {
  const cutoff = new Date(now.getTime() - PUBLIC_IMAGE_GC_DAYS * 24 * 3_600_000);
  let deleted = 0;
  for (const c of await candidates(cutoff, GC_BATCH)) {
    if (signal?.aborted) break;
    if (await stillReferenced(c)) continue;
    try {
      const out = await gcImage({ imageRepository: c.image_repository, digest: c.image_digest });
      await markCollected(c, now);
      if (out.deleted) deleted++;
    } catch (err) {
      const tagged = err instanceof RegistryPublicationError && err.status === 409;
      logger[tagged ? 'info' : 'warn']('Public image not collected', {
        imageRepository: c.image_repository, digest: c.image_digest, error: errorMessage(err),
      });
    }
  }
  return deleted;
}
