// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, type Logger } from '@pipeline-builder/api-core';

export const logger: Logger = createLogger('image-routes');

/** Symbolic metric names so all incCounter call-sites stay in sync. */
export const RegistryMetrics = {
  TAG_DELETE: 'registry_tag_delete_total',
  TAG_COPY: 'registry_tag_copy_total',
  /** A copy that threw mid-tree (may have left orphan blobs in the target). */
  TAG_COPY_PARTIAL: 'registry_tag_copy_partial_failure_total',
  TAG_PROMOTE: 'registry_tag_promote_total',
  REPO_DELETE: 'registry_repo_delete_total',
} as const;

// Parallelism budget for cross-repo copy. 3 children × 8 unique blobs per
// child = 24 in-flight registry calls at most. Tuned for a comfortable load
// on the in-cluster registry. Override via `REGISTRY_COPY_PARALLEL_*`.
export const COPY_PARALLEL_CHILDREN = parseInt(process.env.REGISTRY_COPY_PARALLEL_CHILDREN || '3', 10);
export const COPY_PARALLEL_BLOBS = parseInt(process.env.REGISTRY_COPY_PARALLEL_BLOBS || '8', 10);

/**
 * cosign stores a plugin image's signature and SBOM attestation as TAGS beside
 * it — `sha256-<hex>.sig` / `sha256-<hex>.att` (see api/plugin supply-chain).
 * They are metadata about another manifest, not images: hidden from tag
 * listings, and deleted along with the manifest they describe so a delete
 * doesn't strand them (or leave a repo "non-empty" with nothing runnable in it).
 */
const COSIGN_COMPANION_TAG_RE = /^sha256-[0-9a-f]{64}\.(sig|att)$/;

export function isCosignCompanionTag(tag: string): boolean {
  return COSIGN_COMPANION_TAG_RE.test(tag);
}

/** The companion tags cosign would have written for `digest` (`sha256:<hex>`). */
export function cosignCompanionTags(digest: string): string[] {
  const match = /^sha256:([0-9a-f]{64})$/.exec(digest);
  if (!match) return [];
  return [`sha256-${match[1]}.sig`, `sha256-${match[1]}.att`];
}
