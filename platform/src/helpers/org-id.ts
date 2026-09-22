// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createOrgIdCaster } from '@pipeline-builder/api-core';
import mongoose from 'mongoose';

/**
 * Convert a string org ID to ObjectId when valid.
 *
 * Every org-id field (`Organization._id`, `UserOrganization.organizationId`, the
 * configured system-org id) is a plain `Schema.Types.ObjectId`. A 24-hex string
 * arriving from a route param / JWT claim / cross-service payload is cast to
 * ObjectId (24-hex → ObjectId, anything else → unchanged) so filters match
 * regardless of whether the caller passed a string or an ObjectId. The
 * `parentOrgId` field is still stored as a String, so the pass-through branch
 * keeps those lookups working too.
 *
 * The logic (and the `string | string[]` signature) is api-core's
 * `createOrgIdCaster`, shared with quota. Only the mongoose constructor is supplied here, because
 * mongoose is not an api-core dependency.
 */
export const toOrgId: (id: string | string[]) => string | mongoose.Types.ObjectId =
  createOrgIdCaster(mongoose.Types.ObjectId);
