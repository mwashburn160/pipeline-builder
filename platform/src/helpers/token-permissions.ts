// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Permission-scoped credentials (catalog-scoped PATs and machine tokens).
 *
 * A person minting a personal access key (`POST /user/keys`) or a machine token
 * (`POST /user/generate-token`) may narrow it to a SUBSET of the permission
 * catalog. The rules, in one place:
 *
 *   1. Every id must be in the catalog, and at least one must be chosen.
 *   2. The subset must be ⊆ the creator's CURRENT effective permissions in the
 *      org the credential is bound to — re-resolved from their Roles here, and
 *      ALSO bounded by the calling token's own `permissions` claim, so a
 *      restricted token can never mint something wider than itself.
 *   3. It can't be combined with a capability `scope` — a scoped credential
 *      already carries no permissions at all.
 *   4. A caller that is ITSELF restricted (`permissionsRestricted`) and asks for
 *      "full access" gets its own current permissions instead: full access is
 *      "everything I hold", and what a restricted token holds is its subset.
 *
 * At every issue afterwards the token carries subset ∩ the holder's permissions
 * AT THAT MOMENT (`utils/token.ts#createAccessTokenPayload`) — so losing a Role
 * shrinks the credential, and nothing can ever grow it.
 */

import {
  normalizePermissionSubset,
  resolveUserPermissions,
  type Permission,
  type TokenScope,
} from '@pipeline-builder/api-core';
import type { Request } from 'express';

/** The narrowing a calling token carries, to be inherited by what it mints. */
export interface CallerRestriction {
  scope?: TokenScope;
  permissions?: Permission[];
}

/**
 * What a credential minted FROM this request must at least be narrowed to: the
 * caller's own capability scope, and — for a permission-restricted caller — its
 * current permissions. Used by every path that re-issues from a presented token
 * (switch-org without a session slot, sign-out-everywhere's replacement).
 */
export function callerRestriction(req: Request): CallerRestriction {
  const user = req.user as { scope?: TokenScope; permissionsRestricted?: boolean; permissions?: string[] } | undefined;
  return {
    ...(user?.scope ? { scope: user.scope } : {}),
    ...(user?.permissionsRestricted ? { permissions: normalizePermissionSubset(user.permissions ?? []) ?? [] } : {}),
  };
}

/** The outcome of validating a requested permission subset. */
export type PermissionSubsetResult =
  | { ok: true; permissions?: Permission[] }
  | { ok: false; status: 400 | 403; code: string; message: string; missing?: Permission[] };

/**
 * The creator's current effective permissions in the org a new credential is
 * bound to (their `lastActiveOrgId` — the org `api-key-service.create` and
 * generate-token bind to), bounded by the calling token's own claim.
 */
async function creatorPermissions(req: Request, userId: string): Promise<Set<string>> {
  // Loaded on demand: `callerRestriction` (the pure half of this module) is on
  // the switch-org / sign-out paths, which must not drag the model + token
  // graph in just to read two claims.
  const [{ User }, { membershipForOrg }] = await Promise.all([
    import('../models/index.js'),
    import('../utils/token.js'),
  ]);
  const user = await User.findById(userId).select('+isSuperAdmin lastActiveOrgId').lean();
  const orgId = user?.lastActiveOrgId ? String(user.lastActiveOrgId) : undefined;
  const membership = orgId ? await membershipForOrg(userId, orgId) : undefined;
  const fresh = resolveUserPermissions(membership?.rolePermissions, (user as { isSuperAdmin?: boolean } | null)?.isSuperAdmin === true);
  const claimed = new Set((req.user as { permissions?: string[] } | undefined)?.permissions ?? []);
  return new Set(fresh.filter((p) => claimed.has(p)));
}

/**
 * Validate the `permissions` field of a credential-minting request (see the
 * module rules). `raw` is the request body's value, untouched.
 */
export async function resolveRequestedPermissions(
  req: Request,
  userId: string,
  raw: unknown,
  scope: TokenScope | undefined,
): Promise<PermissionSubsetResult> {
  if (raw === undefined || raw === null) {
    // Rule 4 — a restricted caller's "full access" is its own current set.
    const inherited = callerRestriction(req).permissions;
    return { ok: true, ...(inherited && !scope ? { permissions: inherited } : {}) };
  }
  if (scope) {
    return {
      ok: false,
      status: 400,
      code: 'PERMISSIONS_WITH_SCOPE',
      message: 'A credential carries either a capability scope or a permission subset, not both',
    };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, status: 400, code: 'INVALID_PERMISSIONS', message: 'permissions must be an array of permission ids' };
  }
  const requested = normalizePermissionSubset(raw);
  if (requested === null) {
    return { ok: false, status: 400, code: 'INVALID_PERMISSIONS', message: 'permissions contains an unknown permission id' };
  }
  if (requested.length === 0) {
    return { ok: false, status: 400, code: 'INVALID_PERMISSIONS', message: 'Choose at least one permission, or omit permissions for full access' };
  }
  const held = await creatorPermissions(req, userId);
  const missing = requested.filter((p) => !held.has(p));
  if (missing.length > 0) {
    return {
      ok: false,
      status: 403,
      code: 'PERMISSION_SUBSET_EXCEEDS',
      message: `You can only grant permissions you currently hold (not held: ${missing.join(', ')})`,
      missing,
    };
  }
  return { ok: true, permissions: requested };
}
