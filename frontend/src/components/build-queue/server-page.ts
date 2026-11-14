// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { QueuePagination } from '@/lib/api/domains/plugins';

/**
 * Normalize a build-queue page (`/plugins/queue/failed`, `/dlq`) for
 * `useServerPagination`. The server's `total` is exact only for a system-org
 * queue operator; a tenant-scoped caller gets none, so fall back to "what we've
 * seen, plus one more page when the server says there is one" and the pager
 * still offers Next.
 */
export function toServerPage<T>(jobs: T[] | undefined, p: QueuePagination | undefined, offset: number, limit: number) {
  const items = jobs ?? [];
  const total = p?.total ?? offset + items.length + (p?.hasMore ? 1 : 0);
  return { items, pagination: { offset: p?.offset ?? offset, limit: p?.limit ?? limit, total } };
}
