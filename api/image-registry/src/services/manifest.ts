// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Media types that identify a multi-arch INDEX (a.k.a. manifest list) — the
 * shared source of truth for the copy path AND the GC path, which previously
 * kept two parallel copies of this set.
 */
export const INDEX_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);

/** Body shape of a manifest, as far as index-detection cares. */
export interface ManifestLikeBody {
  /** Present on a multi-arch index / manifest list — child references by digest. */
  manifests?: unknown;
}

/**
 * True when a manifest is a multi-arch index. Detects BOTH by media type AND by
 * body shape (`manifests[]` present) so a manifest whose `Content-Type` is
 * missing/misreported is still dispatched as multi-arch — the copy path used to
 * key off media type alone and would silently single-arch-copy a mis-typed
 * index, dropping its child manifests. Mirrors the GC path's detection.
 */
export function isIndex(mediaType: string | undefined, body: ManifestLikeBody | undefined): boolean {
  return (mediaType !== undefined && INDEX_MEDIA_TYPES.has(mediaType)) || Array.isArray(body?.manifests);
}
