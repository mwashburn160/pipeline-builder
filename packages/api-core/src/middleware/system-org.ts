// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The system tenant's well-known identity.
 */

/**
 * The system tenant's canonical org **id** — a fixed, well-known ObjectId (NOT
 * the string 'system'). This is the single knob every service resolves the
 * system tenant through; override via the `SYSTEM_ORG_ID` env for alternate
 * installs. The system org's human identifier stays the slug/name 'system'
 * (see {@link SYSTEM_ORG_SLUG}); only its `_id` is this ObjectId.
 */
export const SYSTEM_ORG_ID = (process.env.SYSTEM_ORG_ID || '000000000000000000000001').toLowerCase();

/** The system org's well-known slug/name (the human identifier; its `_id` is {@link SYSTEM_ORG_ID}). */
export const SYSTEM_ORG_SLUG = 'system';

/**
 * Check if an orgId or orgName/slug matches the system org. Use this instead of
 * comparing directly: the id is now an ObjectId ({@link SYSTEM_ORG_ID}) while the
 * name/slug is 'system' ({@link SYSTEM_ORG_SLUG}), so the two are compared against
 * their respective canonical values.
 */
export function isSystemOrgId(orgId?: string, orgName?: string): boolean {
  return orgId?.toLowerCase() === SYSTEM_ORG_ID || orgName?.toLowerCase() === SYSTEM_ORG_SLUG;
}

