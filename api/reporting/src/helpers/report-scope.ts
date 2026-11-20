// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Request } from 'express';
import { rollupIds } from './report-helpers.js';
import { cutRange, resolveOrgRetentionWindow, retentionOrgIdFor, type RetentionKind } from './retention-cap.js';

/** What a per-org report reads: its retention-bounded window and rollup org set. */
export interface ReportScope {
  range: { from: string; to: string };
  /** `[self, ...descendants]` for an authorized rollup; undefined = single-org. */
  orgIds: string[] | undefined;
  /**
   * The retention floor the range was cut against (epoch ms; `0` = unlimited), so
   * a route that also reads a comparison window can test it without re-reading
   * the settings row.
   */
  minFromMs: number;
}

/**
 * Resolve a per-org report's scope in one step: the `?from&to` window capped and
 * floored to the account root's `kind` retention (see {@link cutRange}) and the
 * `?includeDescendants` rollup set (see {@link rollupIds}). The two lookups are
 * independent, so they run concurrently.
 * A bad range comes back as `{ error }` for the route to 400.
 *
 * The platform-operator error/failure routes deliberately don't use this — they
 * keep the absolute range ceiling and no retention floor.
 */
export async function resolveReportScope(
  req: Request,
  orgId: string,
  kind: RetentionKind,
): Promise<ReportScope | { error: string }> {
  const [win, orgIds] = await Promise.all([
    resolveOrgRetentionWindow(orgId, kind, retentionOrgIdFor(req, orgId)),
    rollupIds(req, orgId),
  ]);
  const range = cutRange(req.query, win);
  if ('error' in range) return range;
  return { range, orgIds, minFromMs: win.minFromMs };
}
