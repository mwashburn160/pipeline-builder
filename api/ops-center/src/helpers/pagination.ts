// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { MAX_PAGE_LIMIT, parsePage } from '@pipeline-builder/api-core';

/** Rows a list route returns when the caller names no `?limit`. */
const DEFAULT_PAGE_LIMIT = 10;

/**
 * The `?limit=&offset=` window for a platform LIST route: api-core's parser
 * (which clamps both bounds) with platform's ONE default page size. Routes
 * whose page size is dictated by something else — the audit dashboards, the log
 * reader, a role list capped by its own maximum — pass their own bounds to
 * `parsePage` directly and say why.
 */
export function listPage(query: unknown): { limit: number; offset: number } {
  return parsePage(query as Record<string, unknown>, { def: DEFAULT_PAGE_LIMIT, max: MAX_PAGE_LIMIT });
}
