// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ONE ROW PER ROOT ORG PER PERIOD, APPEND-ONLY (docs/plans/sales-agent.md,
 * Phase 0).
 *
 * **This is the plan's cheapest irreversible decision, and the reason it is
 * append-only rather than one mutable row per org.** Overwriting costs nothing
 * today and makes four things impossible LATER rather than merely harder:
 * trajectory (D4 Class 2), self-relative baselines (D16), cohort comparison
 * (D19) and calibration from history (D12). You cannot reconstruct what an
 * account looked like six months ago from a row that was overwritten, so the
 * only chance to start keeping the history is before the first cycle runs.
 *
 * Retention is a separate question from existence: rows can be rolled up or
 * aged out once their period is long past, but they have to have existed.
 *
 * **Persisted rather than computed on demand**, because the promotion
 * evaluator's loop walks every active subscription and cannot afford
 * cross-service reads per account. It is also what makes the rules testable: a
 * rule is a pure function of a profile, so the test shape is a set of golden
 * profiles asserted against the offer each should produce — including the ones
 * that should produce none.
 *
 * **Staleness is a first-class field, not an assumption.** A profile older than
 * its own period is not a profile; D8 says skip the account rather than offer
 * against figures that may predate a tier change.
 */

import type { QuotaTier, QuotaType } from '@pipeline-builder/api-core';
import mongoose, { Schema } from 'mongoose';

/** One quota dimension's state in a period. */
export interface ProfileDimension {
  /** Units consumed in the period. */
  used: number;
  /** The cap in force, `-1` for unlimited. */
  limit: number;
  /** `used / limit`, or null when there is no finite limit to divide by. */
  ratio: number | null;
  /** Where the counter was PACING to finish (api-core `projectUsage`). */
  projected: number | null;
  /** Highest notice threshold crossed in the period (80 / 90 / 100), if any. */
  crossed: number | null;
}

/**
 * Class 3 — VALUE: whether the product is working for them.
 *
 * The disqualifier that keeps the seat offer from backfiring. An account at 95%
 * of a cap that is quietly disengaging is a CHURN SAVE, not an expansion, and
 * offering it an upgrade is the worst available outcome — a pressure-only
 * profile cannot tell those two accounts apart.
 */
export interface ProfileValue {
  /** Members with any activity in the period, against seats paid for. */
  activeMembers: number;
  seatsHeld: number;
  /** Successful pipeline executions in the period. */
  successfulRuns: number;
  /** Builds that failed permanently — frustration rather than usage. */
  failedBuilds: number;
}

export interface UsageProfileDocument extends mongoose.Document {
  /** The ACCOUNT root. Limits pool at the root, so the root is the unit. */
  orgId: string;
  /**
   * The period this row describes, as the ISO date its window ENDED
   * (`resetAt`). The natural key with `orgId`, and the reason a cycle cannot
   * write two rows for one period.
   */
  period: string;
  tier: QuotaTier;
  /** Per-dimension pressure and trajectory (D4 Classes 1–2). */
  dimensions: Record<string, ProfileDimension>;
  value: ProfileValue;
  /** Add-on bundle ids held when the row was computed (D4 Class 4). */
  addonsHeld: string[];
  /** Whole-account recurring spend for the period, in cents (D4 Class 4). */
  spendCents: number;
  /** Days since the subscription began — young accounts are not expansion cases. */
  subscriptionAgeDays: number;
  /**
   * Whether every read behind this row succeeded.
   *
   * A profile assembled from partial reads is WORSE than no profile: it looks
   * like an account with low usage on whichever dimension failed, which is
   * exactly the shape that suppresses an offer the account should have had — or
   * worse, argues for one it should not. D8 fails CLOSED on it.
   */
  complete: boolean;
  /** Which reads failed, so a persistent gap is diagnosable rather than silent. */
  incompleteReasons: string[];
  computedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const dimensionSchema = new Schema<ProfileDimension>({
  used: { type: Number, required: true, min: 0 },
  limit: { type: Number, required: true },
  ratio: { type: Number, default: null },
  projected: { type: Number, default: null },
  crossed: { type: Number, default: null },
}, { _id: false });

const usageProfileSchema = new Schema<UsageProfileDocument>(
  {
    orgId: { type: String, required: true },
    period: { type: String, required: true },
    tier: { type: String, required: true },
    // A map rather than fixed keys: `QuotaType` grows, and a profile that
    // silently dropped a new dimension would make the rules blind to it.
    dimensions: { type: Map, of: dimensionSchema, default: {} },
    value: {
      activeMembers: { type: Number, default: 0, min: 0 },
      seatsHeld: { type: Number, default: 0, min: 0 },
      successfulRuns: { type: Number, default: 0, min: 0 },
      failedBuilds: { type: Number, default: 0, min: 0 },
    },
    addonsHeld: { type: [String], default: [] },
    spendCents: { type: Number, default: 0, min: 0 },
    subscriptionAgeDays: { type: Number, default: 0, min: 0 },
    complete: { type: Boolean, default: false },
    incompleteReasons: { type: [String], default: [] },
    computedAt: { type: Date, required: true },
  },
  { collection: 'usage_profiles', timestamps: true },
);

/**
 * ONE ROW PER (ORG, PERIOD) — the append-only guarantee, enforced by the index
 * rather than by the writer.
 *
 * Unique so a re-run of a cycle cannot double-write a period, and so a second
 * scheduler replica racing the first loses on insert instead of appending a
 * duplicate the trajectory would then read as two periods.
 */
usageProfileSchema.index({ orgId: 1, period: 1 }, { unique: true });

/** The trajectory read: this account's rows, newest first. */
usageProfileSchema.index({ orgId: 1, computedAt: -1 });

/** The retention sweep's read: everything older than a cut-off. */
usageProfileSchema.index({ computedAt: 1 });

export const UsageProfile =
  (mongoose.models.UsageProfile as mongoose.Model<UsageProfileDocument>) ||
  mongoose.model<UsageProfileDocument>('UsageProfile', usageProfileSchema);

/** The dimensions a profile carries, as the quota service names them. */
export type ProfileDimensionKey = QuotaType;
