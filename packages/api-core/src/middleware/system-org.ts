// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The system tenant's well-known identity.
 */

/**
 * The system tenant's canonical org **id** — a fixed, well-known ObjectId (NOT
 * the string 'system'). The single value every service resolves the system
 * tenant through. The system org's human identifier stays the slug/name
 * 'system' (see {@link SYSTEM_ORG_SLUG}); only its `_id` is this ObjectId.
 *
 * NOT ENV-OVERRIDABLE, and the removed override is worth a note so nobody
 * re-adds it. It read `process.env.SYSTEM_ORG_ID` "for alternate installs" —
 * but the schema contradicts it: `postgres-init.sql` hardcodes this literal as
 * the DEFAULT on 23 org-scoped columns and seeds its rows with it. So an
 * override moved the application's idea of the system org while the database's
 * stayed put, which is a half-feature that fails in the worst possible
 * place — tenancy. The divergence was already being worked around in two spots
 * (`query-builders.ts` drops an orgId predicate over it; the ecosystem
 * bootstrap repairs the Official publisher), and the knob appeared in no
 * `.env.example`, so nothing could set it deliberately anyway.
 *
 * An alternate install changes the DDL and this constant together, or not at
 * all.
 */
export const SYSTEM_ORG_ID = '000000000000000000000001';

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

