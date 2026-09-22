// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Data access for reviews and ratings (docs/plans/plugin-ecosystem.md §5):
 * reviews, their edit history, publisher replies, reports, "helpful" votes and
 * the denormalized `plugin_stats` rows.
 *
 * ELEVATED like the rest of the ecosystem store (see store.ts): these tables
 * are instance-wide with an app-role-only RLS policy, so authorization is the
 * CALLER's job — the review service decides who may touch which row. Plain
 * queries only, so the suite runs the whole layer against the in-memory fake.
 */

import {
  schema,
  type PluginReview,
  type PluginReviewHistoryInsert,
  type PluginReviewInsert,
  type PluginReviewReply,
  type PluginReviewReplyInsert,
  type PluginReviewReport,
  type PluginReviewReportInsert,
  type PluginStats,
  type PluginStatsInsert,
  type ReviewStatus,
} from '@pipeline-builder/pipeline-data';
import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm';

import { elevated } from './store.js';

const first = <T>(rows: T[]): T | null => rows[0] ?? null;
const RV = () => schema.pluginReview;
const RH = () => schema.pluginReviewHistory;
const RR = () => schema.pluginReviewReply;
const RP = () => schema.pluginReviewReport;
const VT = () => schema.pluginReviewVote;
const ST = () => schema.pluginStats;

export const reviews = {
  byId: (id: string): Promise<PluginReview | null> =>
    elevated(async (tx) => first(await tx.select().from(RV()).where(eq(RV().id, id)))),
  byIds: (ids: string[]): Promise<PluginReview[]> =>
    ids.length === 0 ? Promise.resolve([]) : elevated(async (tx) =>
      tx.select().from(RV()).where(inArray(RV().id, ids)).orderBy(desc(RV().updatedAt))),
  /** The caller's own review of a listing (one per user per listing). */
  byAuthor: (listingId: string, userId: string): Promise<PluginReview | null> =>
    elevated(async (tx) => first(await tx.select().from(RV()).where(and(eq(RV().listingId, listingId), eq(RV().authorUserId, userId))))),
  /** A listing's reviews, optionally in some statuses only. */
  forListing: (listingId: string, statuses?: ReviewStatus[]): Promise<PluginReview[]> =>
    elevated(async (tx) => tx.select().from(RV()).where(and(
      eq(RV().listingId, listingId),
      ...(statuses ? [inArray(RV().status, statuses)] : []),
    ))),
  /** Every review in these statuses, newest activity first (the moderation queue; stats). */
  withStatus: (statuses: ReviewStatus[], limit = 10_000): Promise<PluginReview[]> =>
    elevated(async (tx) => tx.select().from(RV()).where(inArray(RV().status, statuses)).orderBy(desc(RV().updatedAt)).limit(limit)),
  /** Reviews an org's members wrote since `since` (the per-org daily cap, G16). */
  countByOrgSince: (orgId: string, since: Date): Promise<number> =>
    elevated(async (tx) => (await tx.select({ id: RV().id }).from(RV())
      .where(and(eq(RV().authorOrgId, orgId), gte(RV().createdAt, since)))).length),
  /** Reviews written on a listing since `since` (burst detection, G16). */
  onListingSince: (listingId: string, since: Date): Promise<PluginReview[]> =>
    elevated(async (tx) => tx.select().from(RV()).where(and(eq(RV().listingId, listingId), gte(RV().createdAt, since)))),
  insert: (values: PluginReviewInsert): Promise<PluginReview> =>
    elevated(async (tx) => (await tx.insert(RV()).values(values).returning())[0] as PluginReview),
  update: (id: string, patch: Partial<PluginReviewInsert>): Promise<PluginReview | null> =>
    elevated(async (tx) => first(await tx.update(RV()).set({ ...patch, updatedAt: new Date() }).where(eq(RV().id, id)).returning())),
  /** Update without touching `updated_at` (the helpful count is not an edit). */
  setHelpfulCount: (id: string, helpfulCount: number): Promise<void> =>
    elevated(async (tx) => { await tx.update(RV()).set({ helpfulCount }).where(eq(RV().id, id)); }),
  /** Delete a review; replies, reports, votes and history cascade. */
  remove: (id: string): Promise<boolean> =>
    elevated(async (tx) => (await tx.delete(RV()).where(eq(RV().id, id)).returning()).length > 0),
};

export const reviewHistory = {
  append: (values: PluginReviewHistoryInsert): Promise<void> =>
    elevated(async (tx) => { await tx.insert(RH()).values(values); }),
};

export const replies = {
  byReview: (reviewId: string): Promise<PluginReviewReply | null> =>
    elevated(async (tx) => first(await tx.select().from(RR()).where(eq(RR().reviewId, reviewId)))),
  byReviews: (reviewIds: string[]): Promise<PluginReviewReply[]> =>
    reviewIds.length === 0 ? Promise.resolve([]) : elevated(async (tx) =>
      tx.select().from(RR()).where(inArray(RR().reviewId, reviewIds))),
  insert: (values: PluginReviewReplyInsert): Promise<PluginReviewReply> =>
    elevated(async (tx) => (await tx.insert(RR()).values(values).returning())[0] as PluginReviewReply),
  update: (reviewId: string, patch: Partial<PluginReviewReplyInsert>): Promise<PluginReviewReply | null> =>
    elevated(async (tx) => first(await tx.update(RR()).set({ ...patch, updatedAt: new Date() }).where(eq(RR().reviewId, reviewId)).returning())),
  remove: (reviewId: string): Promise<boolean> =>
    elevated(async (tx) => (await tx.delete(RR()).where(eq(RR().reviewId, reviewId)).returning()).length > 0),
};

export const reports = {
  forReviews: (reviewIds: string[]): Promise<PluginReviewReport[]> =>
    reviewIds.length === 0 ? Promise.resolve([]) : elevated(async (tx) =>
      tx.select().from(RP()).where(inArray(RP().reviewId, reviewIds)).orderBy(desc(RP().createdAt))),
  byReporter: (reviewId: string, userId: string): Promise<PluginReviewReport | null> =>
    elevated(async (tx) => first(await tx.select().from(RP()).where(and(eq(RP().reviewId, reviewId), eq(RP().reporterUserId, userId))))),
  /** The review ids this user reported, among these. */
  reportedBy: async (userId: string, reviewIds: string[]): Promise<string[]> =>
    reviewIds.length === 0 ? [] : elevated(async (tx) => (await tx.select({ reviewId: RP().reviewId }).from(RP())
      .where(and(eq(RP().reporterUserId, userId), inArray(RP().reviewId, reviewIds)))).map((r) => r.reviewId)),
  /** Every unresolved report (the queue's "reported" half). */
  open: (limit = 5_000): Promise<PluginReviewReport[]> =>
    elevated(async (tx) => tx.select().from(RP()).where(isNull(RP().resolvedAt)).orderBy(desc(RP().createdAt)).limit(limit)),
  insert: (values: PluginReviewReportInsert): Promise<PluginReviewReport> =>
    elevated(async (tx) => (await tx.insert(RP()).values(values).returning())[0] as PluginReviewReport),
  /** Mark a review's open reports handled (release / remove). */
  resolve: (reviewId: string, at: Date = new Date()): Promise<void> =>
    elevated(async (tx) => { await tx.update(RP()).set({ resolvedAt: at }).where(and(eq(RP().reviewId, reviewId), isNull(RP().resolvedAt))); }),
};

export const votes = {
  has: (reviewId: string, userId: string): Promise<boolean> =>
    elevated(async (tx) => (await tx.select({ reviewId: VT().reviewId }).from(VT())
      .where(and(eq(VT().reviewId, reviewId), eq(VT().userId, userId)))).length > 0),
  add: (reviewId: string, userId: string): Promise<void> =>
    elevated(async (tx) => { await tx.insert(VT()).values({ reviewId, userId }); }),
  remove: (reviewId: string, userId: string): Promise<void> =>
    elevated(async (tx) => { await tx.delete(VT()).where(and(eq(VT().reviewId, reviewId), eq(VT().userId, userId))); }),
  count: (reviewId: string): Promise<number> =>
    elevated(async (tx) => (await tx.select({ userId: VT().userId }).from(VT()).where(eq(VT().reviewId, reviewId))).length),
  /** The review ids this user found helpful, among these. */
  votedBy: async (userId: string, reviewIds: string[]): Promise<string[]> =>
    reviewIds.length === 0 ? [] : elevated(async (tx) => (await tx.select({ reviewId: VT().reviewId }).from(VT())
      .where(and(eq(VT().userId, userId), inArray(VT().reviewId, reviewIds)))).map((r) => r.reviewId)),
};

export const listingStats = {
  byListings: (listingIds: string[]): Promise<PluginStats[]> =>
    listingIds.length === 0 ? Promise.resolve([]) : elevated(async (tx) =>
      tx.select().from(ST()).where(inArray(ST().listingId, listingIds))),
  /**
   * Write some of a listing's stats columns. Update first, insert when the row
   * is new; a concurrent insert (the scheduler vs a review write) loses the
   * primary-key race and retries as an update. Separate transactions: a failed
   * insert aborts its own transaction.
   */
  upsert: async (listingId: string, patch: Omit<Partial<PluginStatsInsert>, 'listingId'>): Promise<void> => {
    const values = { ...patch, updatedAt: new Date() };
    const setValues = () => elevated(async (tx) => tx.update(ST()).set(values).where(eq(ST().listingId, listingId)).returning());
    if ((await setValues()).length > 0) return;
    try {
      await elevated(async (tx) => { await tx.insert(ST()).values({ listingId, ...values }); });
    } catch {
      await setValues();
    }
  },
};
