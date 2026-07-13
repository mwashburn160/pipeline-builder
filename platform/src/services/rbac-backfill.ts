// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import mongoose from 'mongoose';
import type { Types } from 'mongoose';
import { permissionsForGrantsRole } from './roles-service.js';
import { Role, RoleAssignment, UserOrganization } from '../models/index.js';
import type { RoleGrant } from '../models/index.js';

const logger = createLogger('rbac-backfill');

/** Summary of a single backfill run (for logging + tests). */
export interface RbacBackfillSummary {
  orgsScanned: number;
  rolesBackfilled: number;
  assignmentsAdded: number;
}

/**
 * One-time collection + permission-string rename for the Group→Role cleanup.
 * Runs FIRST (before any Role/RoleAssignment query) so the models — now pointing
 * at `roles`/`role_assignments` — see the pre-existing data. Each step is guarded
 * and idempotent, so re-running on an already-migrated DB is a cheap no-op.
 */
async function renameGroupsToRoles(): Promise<void> {
  const db = mongoose.connection?.db;
  if (!db) {
    logger.warn('renameGroupsToRoles: no active mongoose connection; skipping');
    return;
  }

  // 1. Rename the legacy collections to their Role names (only when the source
  //    exists and the target doesn't, so a partially-migrated/fresh DB is safe).
  const renames: Array<[from: string, to: string]> = [
    ['groups', 'roles'],
    ['group_memberships', 'role_assignments'],
  ];
  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
  for (const [from, to] of renames) {
    if (existing.has(from) && !existing.has(to)) {
      try {
        await db.renameCollection(from, to);
        logger.info('Renamed RBAC collection', { from, to });
      } catch (err) {
        logger.warn('renameGroupsToRoles: collection rename failed', { from, to, error: err });
      }
    }
  }

  // 2. Rewrite the permission catalog id on existing Roles: `groups:manage` →
  //    `roles:manage`. Two idempotent steps (add-new-where-old, then drop-old).
  try {
    const added = await Role.updateMany(
      { permissions: 'groups:manage' },
      { $addToSet: { permissions: 'roles:manage' } },
    );
    const removed = await Role.updateMany(
      { permissions: 'groups:manage' },
      { $pull: { permissions: 'groups:manage' } },
    );
    if ((added.modifiedCount ?? 0) > 0 || (removed.modifiedCount ?? 0) > 0) {
      logger.info('Rewrote groups:manage → roles:manage on Roles', {
        added: added.modifiedCount ?? 0,
        removed: removed.modifiedCount ?? 0,
      });
    }
  } catch (err) {
    logger.warn('renameGroupsToRoles: permission rewrite failed', { error: err });
  }

  // 3. Normalize built-in Role DISPLAY names to the canonical vocabulary
  //    (admin → "Admin", member → "Member", superadmin → "Super Admin"), keyed
  //    off the stable `grantsRole` so legacy "Administrators"/"Developers"/
  //    "Superadmins" docs are renamed in place. Names are cosmetic (all lookups
  //    key on `grantsRole`); idempotent — only a mismatched name is updated.
  try {
    const canonical: Array<[grant: RoleGrant, name: string]> = [
      ['admin', 'Admin'], ['member', 'Member'], ['superadmin', 'Super Admin'],
    ];
    let renamed = 0;
    for (const [grant, name] of canonical) {
      const res = await Role.updateMany(
        { system: true, grantsRole: grant, name: { $ne: name } },
        { $set: { name } },
      );
      renamed += res.modifiedCount ?? 0;
    }
    if (renamed > 0) logger.info('Normalized built-in Role names to Admin/Member/Super Admin', { renamed });
  } catch (err) {
    logger.warn('renameGroupsToRoles: name normalization failed', { error: err });
  }
}

/**
 * Startup backfill for the single-source "Roles" RBAC model. Runs once at boot
 * (after Mongo connects) and is safe to run repeatedly — cheap on a no-op.
 *
 * Two idempotent passes across ALL orgs:
 *   a. Every built-in (`system:true`) Role with an empty/missing `permissions[]`
 *      is populated from the bundle matching its `grantsRole`
 *      (admin/superadmin → admin bundle, member → member bundle) so pre-existing
 *      Roles become self-describing.
 *   b. Every ACTIVE `UserOrganization` membership is ensured to hold the built-in
 *      Role matching its current coarse role (member → Member, admin/owner →
 *      Admin), keyed off `grantsRole`, via an idempotent assignment upsert — so
 *      users who previously relied on the (now-removed) role baseline keep their
 *      permissions.
 *
 * Failures are surfaced by the caller (index.ts wraps this in try/catch so a
 * partial failure logs and boot continues) — nothing here is fatal.
 */
export async function backfillRbacRoles(): Promise<RbacBackfillSummary> {
  // ── Collection + permission-string rename (Group→Role) ─────────────────────
  // MUST precede every Role/RoleAssignment query below so the models see the
  // migrated data.
  await renameGroupsToRoles();

  // ── Pass A: populate empty built-in Role permission bundles ────────────────
  const emptyBuiltins = await Role.find({
    system: true,
    $or: [{ permissions: { $exists: false } }, { permissions: { $size: 0 } }],
  }).select('_id grantsRole').lean();

  let rolesBackfilled = 0;
  for (const g of emptyBuiltins) {
    await Role.updateOne(
      { _id: g._id },
      { $set: { permissions: permissionsForGrantsRole(g.grantsRole as RoleGrant) } },
    );
    rolesBackfilled += 1;
  }

  // ── Pass B: ensure each active member holds the Role matching their role ────
  // Build org → { member, admin } built-in-Role id map, keyed off the stable
  // `grantsRole` (name-independent).
  const builtins = await Role.find({
    system: true,
    grantsRole: { $in: ['member', 'admin'] },
  }).select('_id organizationId grantsRole').lean();

  const byOrg = new Map<string, { member?: Types.ObjectId; admin?: Types.ObjectId }>();
  for (const g of builtins) {
    const key = String(g.organizationId);
    const entry = byOrg.get(key) ?? {};
    if (g.grantsRole === 'member') entry.member = g._id as Types.ObjectId;
    else if (g.grantsRole === 'admin') entry.admin = g._id as Types.ObjectId;
    byOrg.set(key, entry);
  }

  const memberships = await UserOrganization.find({ isActive: true })
    .select('userId organizationId role').lean();

  const orgsScanned = new Set<string>();
  let assignmentsAdded = 0;
  for (const m of memberships) {
    const key = String(m.organizationId);
    orgsScanned.add(key);
    const roles = byOrg.get(key);
    if (!roles) continue; // org has no built-in Roles (unseeded) — skip

    // owner + admin → Admin Role (owner == admin bundle); member → Member Role.
    const roleId = m.role === 'member' ? roles.member : roles.admin;
    if (!roleId) continue;

    const res = await RoleAssignment.updateOne(
      { userId: m.userId, roleId },
      { $setOnInsert: { userId: m.userId, roleId, organizationId: m.organizationId } },
      { upsert: true },
    );
    if (res.upsertedCount && res.upsertedCount > 0) assignmentsAdded += 1;
  }

  const summary: RbacBackfillSummary = {
    orgsScanned: orgsScanned.size,
    rolesBackfilled,
    assignmentsAdded,
  };
  logger.info('RBAC Roles backfill complete', summary);
  return summary;
}
