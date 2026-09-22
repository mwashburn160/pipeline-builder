// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createOrgIdCaster } from '@pipeline-builder/api-core';
import mongoose from 'mongoose';

/**
 * Cast a 24-hex org id to ObjectId so `_id` lookups match the shared
 * `organizations` collection (platform writes ObjectId `_id`s; the well-known
 * `'system'` org and other string ids pass through unchanged). The org model's
 * `_id` is Mixed, so both forms coexist; without the cast `findById('<24hex>')`
 * never matches an ObjectId doc. The logic is api-core's `createOrgIdCaster`
 * (shared with platform); only the mongoose constructor is supplied here.
 *
 * Lives in its own config-free module so the hierarchy helpers can use it
 * without dragging in the service config (which requires MONGODB_URI).
 */
export const toOrgId: (id: string | string[]) => string | mongoose.Types.ObjectId =
  createOrgIdCaster(mongoose.Types.ObjectId);
