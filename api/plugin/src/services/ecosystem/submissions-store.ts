// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Data access for anonymous public submissions (docs/plugin-publishing.md
 * ): the `plugin_submissions` rows, and the directory reads the name gate
 * needs (the most-installed listings, the Official/Verified listing names).
 *
 * ELEVATED like the rest of the ecosystem store (store.ts): `plugin_submissions`
 * is instance-wide and app-role-only, and nothing here is reachable except
 * through the submission service, which owns every authorization decision
 * (an anonymous caller only ever reaches a row through a token hash).
 *
 * Plain queries; time windows are filtered in memory (the table is small and
 * the in-memory test double speaks only the operators store.ts uses).
 */

import {
  executeRows,
  schema,
  type PluginListing,
  type PluginSubmission,
  type PluginSubmissionInsert,
  type SubmissionStatus,
} from '@pipeline-builder/pipeline-data';
import { and, asc, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';

// store.ts's `elevated`: joins an ambient `atomically` block, so a submission
// write commits or rolls back with the moderation writes around it.
import { elevated } from './store.js';
import { first } from './util.js';

const S = () => schema.pluginSubmission;

export const submissions = {
  byId: (id: string): Promise<PluginSubmission | null> =>
    elevated(async (tx) => first(await tx.select().from(S()).where(eq(S().id, id)))),
  byVerifyTokenHash: (hash: string): Promise<PluginSubmission | null> =>
    elevated(async (tx) => first(await tx.select().from(S()).where(eq(S().verifyTokenHash, hash)))),
  byStatusTokenHash: (hash: string): Promise<PluginSubmission | null> =>
    elevated(async (tx) => first(await tx.select().from(S()).where(eq(S().statusTokenHash, hash)))),
  list: (filter: { statuses?: SubmissionStatus[]; listingId?: string; limit?: number } = {}): Promise<PluginSubmission[]> =>
    elevated(async (tx) => {
      const where = [];
      if (filter.statuses?.length) where.push(inArray(S().status, filter.statuses));
      if (filter.listingId) where.push(eq(S().listingId, filter.listingId));
      return tx.select().from(S()).where(and(...where)).orderBy(desc(S().createdAt)).limit(filter.limit ?? 5_000);
    }),
  /** Undecided submissions whose `expires_at` has passed, oldest first (the expiry sweep). */
  dueForExpiry: (now: Date, limit: number): Promise<PluginSubmission[]> =>
    elevated(async (tx) => tx.select().from(S())
      .where(and(inArray(S().status, ['pending_verification', 'pending_review']), lte(S().expiresAt, now)))
      .orderBy(asc(S().expiresAt)).limit(limit)),
  /**
   * Null both email columns of up to `limit` decided submissions whose
   * `email_purge_after` has passed — one statement, the predicate in SQL, so
   * the purge never depends on a row cap. Returns how many rows it cleared.
   */
  purgeEmails: (now: Date, limit: number): Promise<number> =>
    elevated(async (tx) => {
      const rows = await executeRows(tx, sql`
        UPDATE plugin_submissions
           SET email_hash = NULL, email_enc = NULL, updated_at = now()
         WHERE id IN (
           SELECT id FROM plugin_submissions
            WHERE email_purge_after <= ${now}
              AND (email_hash IS NOT NULL OR email_enc IS NOT NULL)
            LIMIT ${limit})
        RETURNING id`);
      return rows.length;
    }),
  insert: (values: PluginSubmissionInsert): Promise<PluginSubmission> =>
    elevated(async (tx) => (await tx.insert(S()).values(values).returning())[0] as PluginSubmission),
  update: (id: string, patch: Partial<PluginSubmissionInsert>): Promise<PluginSubmission | null> =>
    elevated(async (tx) => first(await tx.update(S()).set({ ...patch, updatedAt: new Date() }).where(eq(S().id, id)).returning())),
  /**
   * Move a submission on, but only from `fromStatus` — the optimistic lock
   * that makes verify single-use and stops a gate run and an expiry from both
   * deciding one row. Null when it was no longer in that status.
   */
  transition: (id: string, fromStatus: SubmissionStatus, patch: Partial<PluginSubmissionInsert>): Promise<PluginSubmission | null> =>
    elevated(async (tx) => first(await tx.update(S()).set({ ...patch, updatedAt: new Date() })
      .where(and(eq(S().id, id), eq(S().status, fromStatus))).returning())),
  remove: (id: string): Promise<void> =>
    elevated(async (tx) => { await tx.delete(S()).where(eq(S().id, id)); }),
};

/** Who owns a community listing: the email hash of its first approved submission (null once purged). */
export async function listingOwnerHash(listingId: string): Promise<string | null> {
  const approved = (await submissions.list({ listingId, statuses: ['approved', 'claimed'] }))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return approved[0]?.emailHash ?? null;
}

/** How many of the most-installed listings the confusable-name check compares against. */
export const TOP_LISTINGS_FOR_NAMES = 100;

/**
 * The names of the {@link TOP_LISTINGS_FOR_NAMES} most-installed listings
 * (install_count > 0 — a listing nobody installed isn't a typosquatting
 * target), with their listing and publisher ids so a caller can exclude its own.
 */
export async function topInstalledListings(limit = TOP_LISTINGS_FOR_NAMES): Promise<Array<Pick<PluginListing, 'id' | 'name' | 'publisherId'>>> {
  return elevated(async (tx) => {
    // Ordered and limited in SQL — never the whole stats table in memory.
    const top = await tx.select({ listingId: schema.pluginStats.listingId, installCount: schema.pluginStats.installCount })
      .from(schema.pluginStats)
      .where(gt(schema.pluginStats.installCount, 0))
      .orderBy(desc(schema.pluginStats.installCount))
      .limit(limit);
    if (top.length === 0) return [];
    const rows = await tx.select({ id: schema.pluginListing.id, name: schema.pluginListing.name, publisherId: schema.pluginListing.publisherId })
      .from(schema.pluginListing)
      .where(inArray(schema.pluginListing.id, top.map((s) => s.listingId)));
    const rank = new Map(top.map((s, i) => [s.listingId, i]));
    return rows.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  });
}

/** Listings named `name` under any Official or Verified publisher (they own the name). */
export async function trustedListingsNamed(name: string): Promise<PluginListing[]> {
  return elevated(async (tx) => {
    const rows = await tx.select().from(schema.pluginListing).where(eq(schema.pluginListing.name, name));
    if (rows.length === 0) return [];
    const pubs = await tx.select().from(schema.publisher).where(inArray(schema.publisher.id, [...new Set(rows.map((l) => l.publisherId))]));
    const trusted = new Set(pubs.filter((p) => p.tier === 'official' || p.tier === 'verified').map((p) => p.id));
    return rows.filter((l) => trusted.has(l.publisherId));
  });
}
