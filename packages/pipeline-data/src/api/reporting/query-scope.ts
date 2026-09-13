// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenancy scoping and cache/context policy for reporting reads.
 *
 * These were private methods on ReportingService. They hold no instance state —
 * only the module-level logger and timeseries cache — so they are plain
 * functions here, which is what lets the per-domain query modules (dora.ts)
 * use the identical scoping rules without reaching back into the class.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { sql } from 'drizzle-orm';
import { timeseriesCache } from './caches.js';
import { runWithTenantContext } from '../../database/tenancy.js';

const logger = createLogger('reporting-service');

/**
 * Build the org-scope predicate for a report query. With `orgIds` (the
 * org → team rollup — a parent's `[self, ...descendants]`) it becomes an
 * `IN (...)` over the subtree; otherwise the single-org `= $org`. Returns a
 * `multi` flag so callers can run multi-org reads under sysadmin context
 * (the subtree spans orgs outside the request's RLS scope) and salt the
 * cache key.
 */
export function orgScope(orgId: string, orgIds?: string[]) {
  // Defense-in-depth: the multi-org rollup runs under sysadmin context (RLS
  // OFF, see runReport), so `orgIds` is the ONLY tenancy gate on the read. The
  // route resolves it from the platform's authoritative descendants endpoint as
  // `[self, ...descendants]`, but validate the subtree defensively here before
  // the bypass: the requesting (anchor) org MUST appear in the set. A set that
  // omits the caller's own org is a malformed/spoofed rollup — collapse to the
  // safe single-org scope rather than reading an arbitrary org under sysadmin.
  // (Full descendant-membership validation needs the org tree, which this
  // service does not hold — see the report FLAG.)
  const anchor = orgId.toLowerCase();
  const provided = (orgIds ?? []).filter((id) => typeof id === 'string' && id.length > 0);
  const anchored = provided.some((id) => id.toLowerCase() === anchor);
  if (provided.length > 0 && !anchored) {
    logger.warn('Reporting rollup rejected: requesting org absent from resolved subtree; using single-org scope', {
      orgId: anchor, subtreeSize: provided.length,
    });
  }
  const ids = provided.length > 0 && anchored ? provided : [orgId];
  const multi = ids.length > 1;
  const pred = multi
    ? sql`IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`
    : sql`= ${ids[0]}`;
  return { pred, multi };
}

/**
 * Run a report read. Single-org reads use the per-org cache (invalidated on
 * that org's event ingest). Rollup (multi-org) reads **bypass the cache** and
 * run under sysadmin context: they're admin-only and lower-frequency, and a
 * child org's event ingest can't invalidate a parent's rollup entry (reporting
 * has no org tree), so caching them would serve stale aggregates. Always fresh.
 */
export function runReport<T>(cacheKey: string, multi: boolean, exec: () => Promise<T>): Promise<T> {
  return multi
    ? runWithTenantContext({ isSuperAdmin: true }, exec)
    : timeseriesCache.getOrSet(cacheKey, exec);
}

/** 1.1 Execution count per pipeline with status breakdown. */
