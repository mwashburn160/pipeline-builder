// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * An ORG-SCOPED SERVICE ACCOUNT: a non-human principal that belongs to exactly
 * one organization, holds that org's Roles through the normal
 * `role_assignments` machinery, and authenticates ONLY with `pb_sa_…` access
 * keys traded at `POST /auth/token/exchange`.
 *
 * What it deliberately is NOT:
 *   - a User: it has no password, no email login, no sessions and no refresh
 *     tokens, so there is nothing to sign in with and nothing to impersonate;
 *   - a seat: seats count DISTINCT ACTIVE HUMANS (`helpers/seats.ts` counts
 *     `UserOrganization` rows), and a service account creates no membership row,
 *     so it can never consume one;
 *   - its creator's property: `createdBy` is a snapshot for attribution only.
 *     When that person leaves, the account keeps working — automation must not
 *     break because an engineer changed jobs. Only the ORG owns it, and the org
 *     purge/cascade deletes it.
 *
 * Its own quota: a service account carries its OWN per-period token-exchange
 * budget ({@link ServiceAccountDocument.tokenBudget}) rather than drawing on the
 * org's human API allowance — each exchange grants it one short-lived JWT, so
 * this IS its access rate. Entity quotas (pipelines, plugins …) still belong to
 * the org that owns the created entity.
 */
export interface ServiceAccountDocument extends Document {
  /** Owning org/team. One org, for life — a service account is never moved. */
  organizationId: Types.ObjectId | string;
  /** Unique (per org) machine name, e.g. `setup`, `ci-deploy`. */
  name: string;
  description?: string | null;
  /** Who created it, for attribution. Kept even after that user is deleted
   *  (the account is NOT orphaned or removed with them). */
  createdBy?: Types.ObjectId | null;
  /** Email of the creator at creation time — survives the user's deletion, so
   *  the UI can still say who introduced this credential. */
  createdByEmail?: string | null;
  /**
   * Most token exchanges allowed per quota period (`QUOTA_RESET_DAYS`), or `-1`
   * for unlimited. This is the account's OWN quota: it is enforced at the
   * exchange chokepoint, so an automation loop cannot burn the org's human API
   * budget, and a runaway key is bounded without revoking it.
   */
  tokenBudget: number;
  /** Consumption of {@link tokenBudget} in the current period. */
  usage: {
    exchanges: number;
    /** When the period rolls over (usage resets on the next exchange after it). */
    resetAt: Date;
  };
  /** Disabled accounts keep their keys and roles but can no longer exchange —
   *  the reversible off-switch before deletion. */
  disabled: boolean;
  lastUsedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const serviceAccountSchema = new Schema<ServiceAccountDocument>(
  {
    organizationId: { type: Schema.Types.Mixed, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 64 },
    description: { type: String, default: null, maxlength: 256 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdByEmail: { type: String, default: null, maxlength: 254 },
    tokenBudget: { type: Number, required: true, default: -1 },
    usage: {
      exchanges: { type: Number, required: true, default: 0 },
      resetAt: { type: Date, required: true, default: () => new Date() },
    },
    disabled: { type: Boolean, default: false },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'service_accounts' },
);

// One account per name per org: the name is how automation (and init-platform.sh)
// addresses an account idempotently, so it must be unambiguous.
serviceAccountSchema.index({ organizationId: 1, name: 1 }, { unique: true });

export default mongoose.model<ServiceAccountDocument>('ServiceAccount', serviceAccountSchema);
