// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose from 'mongoose';

/**
 * Convert a string org ID to ObjectId when valid.
 *
 * `Organization._id` (and `UserOrganization.organizationId`) are `Schema.Types.Mixed`
 * to support both ObjectId values and well-known string IDs (e.g. the 'system'
 * org). Mongoose does NOT auto-cast a hex string to ObjectId on a Mixed field,
 * so a raw-string `findById`/filter silently misses an ObjectId-stored id. Route
 * every org-id lookup through this: 24-hex → ObjectId, anything else → unchanged
 * (so 'system' still matches its string `_id`).
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
