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
