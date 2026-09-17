// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { runConcurrent } from '@pipeline-builder/api-core';
import { COPY_PARALLEL_CHILDREN, COPY_PARALLEL_BLOBS } from './shared.js';
import { isIndex } from '../../services/manifest.js';
import {
  getManifest,
  putManifest,
  mountBlob,
  isNotFound,
  type FetchedManifest,
} from '../../services/registry-client.js';

/**
 * Thrown when a layer or child manifest referenced by the source manifest
 * has gone missing mid-copy. Surfaced to the caller as 409 source-incomplete.
 */
export class SourceIncompleteError extends Error {
  constructor(public missingDigest: string) {
    super(`Source manifest references digest ${missingDigest} which is no longer in the source repo.`);
    this.name = 'SourceIncompleteError';
  }
}

/**
 * Thrown when a manifest is missing the `config.digest` required by the
 * OCI v1 image spec. Pre-OCI / legacy formats sometimes omit it; this
 * registry no longer accepts them. Surface as 400 to the caller — the
 * push tooling needs to be upgraded to emit OCI-compliant manifests.
 */
export class InvalidManifestError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidManifestError';
  }
}

/** Mount each digest from source into target, mapping a 404 to SourceIncompleteError. */
async function mountAll(sourceRepo: string, targetRepo: string, digests: string[]): Promise<void> {
  await runConcurrent(digests, COPY_PARALLEL_BLOBS, async (digest) => {
    try {
      await mountBlob(sourceRepo, targetRepo, digest);
    } catch (err) {
      if (isNotFound(err)) throw new SourceIncompleteError(digest);
      throw err;
    }
  });
}

/** The config + layer blob digests of a single-arch manifest (config is required). */
function blobDigests(body: Record<string, unknown>, label: string): string[] {
  const configDigest = (body.config as { digest?: string } | undefined)?.digest;
  const layerDigests = ((body.layers as Array<{ digest: string }> | undefined) ?? []).map((l) => l.digest);
  // OCI v1 requires config.digest on every single-arch manifest. Reject
  // manifests that omit it — accepting them silently was the legacy path
  // that let pre-OCI tooling smuggle untracked content into the registry.
  if (!configDigest) {
    throw new InvalidManifestError(`${label} is missing config.digest (OCI v1 requires it).`);
  }
  return [configDigest, ...layerDigests];
}

/**
 * Copy a manifest (single-arch or multi-arch index) from source to target.
 * Mounts every unique blob digest referenced by the manifest tree, then
 * PUTs the manifest(s) under the target ref. Idempotent: re-running with
 * the same args is a no-op.
 *
 * Every manifest is PUT with its ORIGINAL bytes + Content-Type
 * ({@link FetchedManifest.raw}), so each target digest equals its source
 * digest — required for the child manifests (PUT by digest, and referenced by
 * digest from the index) and for the copied tag to resolve to the same image.
 *
 * Assumption: every child manifest referenced by a multi-arch index lives
 * in the same `sourceRepo`. Cross-repo manifest references (which the OCI
 * spec permits in principle, but our push pipeline never emits) would
 * throw `SourceIncompleteError` when the child digest isn't resolvable
 * inside `sourceRepo`.
 */
export async function copyManifestTree(
  sourceManifest: FetchedManifest,
  sourceRepo: string,
  targetRepo: string,
  targetRef: string,
): Promise<{ manifests: number; blobs: number }> {
  const body = sourceManifest.body as Record<string, unknown>;
  // Detect multi-arch by media type OR body shape (shared with the GC path) so a
  // mis-typed / Content-Type-less index isn't silently single-arch-copied,
  // dropping its child manifests.
  if (isIndex(sourceManifest.mediaType, body)) {
    const children = (body.manifests as Array<{ digest: string }> | undefined) ?? [];
    // Collect unique blob digests across all child manifests so duplicates
    // (shared base layers across platforms) get mounted once.
    const uniqueBlobs = new Set<string>();
    const childManifests: Array<{ digest: string; manifest: FetchedManifest }> = [];

    await runConcurrent(children, COPY_PARALLEL_CHILDREN, async (child) => {
      let m: FetchedManifest;
      try {
        m = await getManifest(sourceRepo, child.digest);
      } catch (err) {
        if (isNotFound(err)) throw new SourceIncompleteError(child.digest);
        throw err;
      }
      for (const d of blobDigests(m.body as Record<string, unknown>, `Child manifest ${child.digest}`)) {
        uniqueBlobs.add(d);
      }
      childManifests.push({ digest: child.digest, manifest: m });
    });

    await mountAll(sourceRepo, targetRepo, [...uniqueBlobs]);

    // PUT each child manifest under its digest (no tag — addressable by digest from the index).
    for (const { digest, manifest } of childManifests) {
      await putManifest(targetRepo, digest, manifest.raw, manifest.mediaType);
    }

    // PUT the index manifest at the target ref.
    await putManifest(targetRepo, targetRef, sourceManifest.raw, sourceManifest.mediaType);

    return { manifests: 1 + childManifests.length, blobs: uniqueBlobs.size };
  }

  // Single-arch.
  const digests = blobDigests(body, `Source manifest ${sourceManifest.digest ?? '<unknown>'}`);
  await mountAll(sourceRepo, targetRepo, digests);
  await putManifest(targetRepo, targetRef, sourceManifest.raw, sourceManifest.mediaType);

  return { manifests: 1, blobs: digests.length };
}
