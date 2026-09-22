// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The permissions a user's Roles grant — the single-source RBAC input to token
 * issuance (`resolveUserPermissions` in api-core; superadmin ⇒ all). There is no
 * role-derived baseline: this union IS the effective permission set.
 *
 * Kept free of the roles-service graph so token issuance has a minimal
 * dependency set.
 */

import { isValidPermission } from '@pipeline-builder/api-core';
import type { ClientSession } from 'mongoose';
import { toOrgId } from '../helpers/org-id.js';
import { Role, RoleAssignment } from '../models/index.js';

/**
 * Flattened, deduped permissions granted to `userId` by the Roles they hold in
 * any of `orgIds` (inherited authority carries the ancestor's Roles plus any the
 * user also holds in the team). Two queries whatever the org count. Invalid or
 * stale permission strings are dropped.
 */
export async function rolePermissionsFor(
  userId: string,
  orgIds: readonly string[],
  session?: ClientSession,
): Promise<string[]> {
  if (orgIds.length === 0) return [];
  const assignments = await RoleAssignment.find({ userId, organizationId: { $in: orgIds.map((id) => toOrgId(id)) } })
    .session(session ?? null).select('roleId').lean();
  const roleIds = [...new Set(assignments.map((m) => String(m.roleId)))];
  if (roleIds.length === 0) return [];
  const roles = await Role.find({ _id: { $in: roleIds } }).session(session ?? null).select('permissions').lean();
  const perms = new Set<string>();
  for (const role of roles) {
    for (const p of role.permissions ?? []) {
      if (isValidPermission(p)) perms.add(p);
    }
  }
  return [...perms];
}
