// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-team usage breakdown (feature `team_usage_analytics`, Enterprise-included).
 *
 * For each org in the account's subtree, reports that org's OWN current-period
 * usage across every quota dimension + seats. USAGE ONLY — limits pool at the
 * root, so per-team caps/percentages would mislead; this surfaces consumption,
 * not caps. It's a point-in-time snapshot (quota counters reset per period), not
 * a trend. See docs/billing-bundles.md.
 *
 * Reads the internal `GET /quotas/:orgId/own-usage` — each org's OWN counters,
 * with NO pooling. NOT `GET /quotas/:orgId`: that read pools every member of an
 * org → team pool (the root's cap against the whole subtree's usage), so using
 * it here printed the account total on every team row. Fan-out is one snapshot
 * per org; when N grows, replace it with a batched read (scale follow-up).
 */

import { createLogger } from '@pipeline-builder/api-core';
import { billingServiceAuth } from './billing-helpers.js';
import { fetchOwnQuotaSnapshot, fetchSeatUsage } from './downstream-client.js';

const logger = createLogger('team-usage');

export interface TeamUsageRow {
  orgId: string;
  name?: string;
  /** Current member count (per-org). `null` when the seat read failed. */
  seats: number | null;
  /** Per quota-type CURRENT usage (that org's own). `null` where the read failed. */
  usage: Record<string, number | null>;
}

/**
 * Assemble each org's own current-period usage (all quota types + seats).
 * Fail-soft per org — a store hiccup yields nulls, never an exception, so one
 * unreadable team can't blank the whole table.
 */
export async function getTeamUsage(orgIds: string[]): Promise<TeamUsageRow[]> {
  return Promise.all(orgIds.map(async (id) => {
    const auth = billingServiceAuth(id);
    const [snapshot, seats] = await Promise.all([
      fetchOwnQuotaSnapshot(id, auth),
      fetchSeatUsage(id, auth),
    ]);
    const usage: Record<string, number | null> = {};
    if (snapshot?.quotas) {
      for (const [type, summary] of Object.entries(snapshot.quotas)) usage[type] = summary?.used ?? null;
    }
    if (!snapshot) logger.debug('Team usage snapshot unavailable', { orgId: id });
    return { orgId: id, name: snapshot?.name, seats: seats?.used ?? null, usage };
  }));
}
