// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose from 'mongoose';

/**
 * Cast a 24-hex org id to ObjectId so `_id` lookups match the shared
 * `organizations` collection (platform writes ObjectId `_id`s; the well-known
 * `'system'` org and other string ids pass through unchanged). Mirrors the
 * platform service's `toOrgId`. The org model's `_id` is Mixed, so both forms
 * coexist; without the cast `findById('<24hex>')` never matched an ObjectId doc.
 *
 * Lives in its own config-free module so the hierarchy helpers can use it
 * without dragging in the service config (which requires MONGODB_URI).
 */
export function toOrgId(id: string): string | mongoose.Types.ObjectId {
  return mongoose.Types.ObjectId.isValid(id) && id.length === 24
    ? new mongoose.Types.ObjectId(id)
    : id;
}
