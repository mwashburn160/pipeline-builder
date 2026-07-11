// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';

export const logger = createLogger('image-routes');

/** Symbolic metric names so all incCounter call-sites stay in sync. */
export const RegistryMetrics = {
  TAG_DELETE: 'registry_tag_delete_total',
  TAG_COPY: 'registry_tag_copy_total',
  TAG_PROMOTE: 'registry_tag_promote_total',
  REPO_DELETE: 'registry_repo_delete_total',
} as const;

// Parallelism budget for cross-repo copy. 3 children × 8 unique blobs per
// child = 24 in-flight registry calls at most. Tuned for a comfortable load
// on the in-cluster registry. Override via `REGISTRY_COPY_PARALLEL_*`.
export const COPY_PARALLEL_CHILDREN = parseInt(process.env.REGISTRY_COPY_PARALLEL_CHILDREN || '3', 10);
export const COPY_PARALLEL_BLOBS = parseInt(process.env.REGISTRY_COPY_PARALLEL_BLOBS || '8', 10);
