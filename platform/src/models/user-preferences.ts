// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { EcosystemEmailPreferenceField } from '@pipeline-builder/api-core';
import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Plugin-ecosystem EMAIL opt-outs (docs/plans/plugin-ecosystem.md §5b
 * "Preferences"), keyed by api-core `ECOSYSTEM_EMAIL_PREFERENCE_FIELDS`
 * (`ecosystem.reviews.email` → `reviewsEmail`, …). All default ON. Read by the
 * notification relay when it mails a non-transactional ecosystem notice; the
 * in-app copy is always delivered, and transactional/security notices ignore
 * these entirely.
 */
export type EcosystemEmailPreferences = Record<EcosystemEmailPreferenceField, boolean>;

/** In-app notification preferences. Each one is read by the UI it silences. */
export interface NotificationPreferences {
  /** Hide the quota banner while usage is only nearing a limit (an exceeded
   *  limit still shows). Per org, because quotas are. */
  muteQuotaWarnings: boolean;
  /** Ecosystem email opt-outs, per org (the org whose inbox the notice lands in). */
  ecosystem: EcosystemEmailPreferences;
}

/**
 * Per-user, per-organization personalization — server-persisted so a user's
 * favorites, recently-viewed items and in-app notification preferences follow
 * them across devices instead of
 * living only in a single browser's localStorage. Favorites are per-org (a
 * plugin id means nothing outside its org), so the record is keyed on
 * `(userId, organizationId)`.
 */
export interface UserPreferencesDocument extends Document {
  userId: Types.ObjectId;
  organizationId: string;
  /** Favorited resource ids (e.g. plugin ids), org-scoped. */
  favorites: string[];
  /** Recently-viewed items (service names / resource ids), newest first, capped. */
  recents: string[];
  notifications: NotificationPreferences;
  updatedAt: Date;
}

const userPreferencesSchema = new Schema<UserPreferencesDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    organizationId: { type: String, required: true },
    favorites: { type: [String], default: [] },
    recents: { type: [String], default: [] },
    notifications: {
      type: new Schema<NotificationPreferences>(
        {
          muteQuotaWarnings: { type: Boolean, default: false },
          ecosystem: {
            type: new Schema<EcosystemEmailPreferences>(
              {
                reviewsEmail: { type: Boolean, default: true },
                upgradesEmail: { type: Boolean, default: true },
                installsEmail: { type: Boolean, default: true },
                moderationDigestEmail: { type: Boolean, default: true },
              },
              { _id: false },
            ),
            default: () => ({}),
          },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
  },
  { timestamps: { createdAt: false, updatedAt: true } },
);

// One preferences document per user per org.
userPreferencesSchema.index({ userId: 1, organizationId: 1 }, { unique: true });

export default mongoose.model<UserPreferencesDocument>('UserPreferences', userPreferencesSchema);
