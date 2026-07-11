// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose from 'mongoose';

/**
 * Convert a string org ID to ObjectId when valid.
 *
 * Every org-id field (`Organization._id`, `UserOrganization.organizationId`, the
 * configured system-org id) is now a plain `Schema.Types.ObjectId`. This helper
 * is retained as a documented cast helper: a 24-hex string arriving from a route
 * param / JWT claim / cross-service payload is cast to ObjectId (24-hex →
 * ObjectId, anything else → unchanged) so filters match regardless of whether the
 * caller passed a string or an ObjectId. The `parentOrgId` field is still stored
 * as a String, so the pass-through branch keeps those lookups working too.
 *
 * Lives in its own mongoose-only module (no express / api-core imports) so it can
 * be pulled into hot paths and service modules without dragging the request layer.
 */
export function toOrgId(id: string | string[]): string | mongoose.Types.ObjectId {
  const idStr = Array.isArray(id) ? id[0] : id;
  return mongoose.Types.ObjectId.isValid(idStr) && idStr.length === 24
    ? new mongoose.Types.ObjectId(idStr)
    : idStr;
}
