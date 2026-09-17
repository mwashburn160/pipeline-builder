// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose, { Schema, Document, Types } from 'mongoose';

/** In-app notification preferences. Each one is read by the UI it silences. */
export interface NotificationPreferences {
  /** Hide the quota banner while usage is only nearing a limit (an exceeded
   *  limit still shows). Per org, because quotas are. */
  muteQuotaWarnings: boolean;
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
        { muteQuotaWarnings: { type: Boolean, default: false } },
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
