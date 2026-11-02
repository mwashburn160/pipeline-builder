// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import type { Types } from 'mongoose';
import { builtinRolePermissions } from './role-authority.js';
import { SYSTEM_ORG_ROLES } from './roles-service.js';
import { Role, RoleAssignment, UserOrganization } from '../models/index.js';
import type { RoleGrant, RoleSeedBundle } from '../models/index.js';

const logger = createLogger('rbac-backfill');

/** Summary of a single backfill run (for logging + tests). */
export interface RbacBackfillSummary {
  orgsScanned: number;
  rolesBackfilled: number;
  assignmentsAdded: number;
  /** System-org built-in Roles that did not exist and were created. */
  rolesCreated: number;
}

/** Order-independent equality of two permission lists (the stored bundle and the
 *  desired one may be persisted in different orders, so compare as sets). */
function permissionSetsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((p) => setB.has(p));
}


/**
 * Startup backfill for the single-source "Roles" RBAC model. Runs once at boot
 * (after Mongo connects) and is safe to run repeatedly — cheap on a no-op.
 *
 * Three idempotent passes:
 *   0. Any built-in Role the SYSTEM org's source list has but the database does
 *      not is created. Pass (a) can only fix a drifted BUNDLE; a Role added to
 *      the source after a deployment was installed would otherwise never exist
 *      there, and its system-org-only permissions would have no carrier.
 *   a. Every built-in (`system:true`) Role with an empty/missing `permissions[]`
 *      is populated from the bundle matching its `grantsRole`
 *      (admin/superadmin → admin bundle, member → member bundle) so pre-existing
 *      Roles become self-describing.
 *   b. Every ACTIVE `UserOrganization` membership is ensured to hold the built-in
 *      Role matching its current coarse role (member → Member, admin/owner →
 *      Admin), keyed off `grantsRole`, via an idempotent assignment upsert — so
 *      every member's permissions come from a Role.
 *
 * Failures are surfaced by the caller (index.ts wraps this in try/catch so a
 * partial failure logs and boot continues) — nothing here is fatal.
 */
export async function backfillRbacRoles(): Promise<RbacBackfillSummary> {
  // ── Pass 0: CREATE any system-org built-in Role that does not exist yet ────
  // Pass A below re-syncs the permissions of built-ins that EXIST, which is what
  // lets a new catalog permission reach an existing org's Admin Role. It cannot
  // help a newly-added ROLE: on every deployment that already ran
  // `seedDefaultRoles`, a Role added to the source afterwards simply would not be
  // there, and its permissions — all system-org-only, so ungrantable by a custom
  // Role anywhere — would have no carrier at all. That is not a fresh-install
  // nicety; it is the difference between the job being staffable and not.
  //
  // Matched by NAME within the system org, which is what `seedDefaultRoles` makes
  // unique there, and created with `system: true` so Pass A then owns its bundle.
  // Idempotent: an existing Role is left alone, including one an operator renamed
  // (a rename produces a second Role rather than a silent rewrite, which is the
  // safe direction — nothing is assigned to the new one).
  let rolesCreated = 0;
  const systemRoleNames = await Role.find({ organizationId: SYSTEM_ORG_ID, system: true })
    .select('name').lean();
  const haveName = new Set(systemRoleNames.map((r) => String(r.name)));
  const missing = SYSTEM_ORG_ROLES.filter((spec) => !haveName.has(spec.name));
  // Only act on a system org that EXISTS. An install that has never created one
  // has nothing to backfill, and creating Roles for an absent org would leave
  // orphans that `seedDefaultRoles` then duplicates.
  if (missing.length > 0 && systemRoleNames.length > 0) {
    await Role.create(missing.map((spec) => ({
      organizationId: SYSTEM_ORG_ID,
      name: spec.name,
      grantsRole: spec.grantsRole,
      ...(spec.seedBundle ? { seedBundle: spec.seedBundle } : {}),
      permissions: builtinRolePermissions(spec),
      system: true,
    })));
    rolesCreated = missing.length;
    logger.info('Created missing system-org built-in Roles', {
      rolesCreated, names: missing.map((m) => m.name),
    });
  }

  // ── Pass A: RE-SYNC built-in Role permission bundles to the current source ──
  // Overwrite every built-in (`system:true`) Role's `permissions[]` to the CURRENT
  // bundle for its `grantsRole` (admin/superadmin → admin bundle, member → member
  // bundle). Overwriting — not filling only when empty — is what lets a newly
  // added catalog permission reach EXISTING orgs' Admin/Member Roles instead of
  // only fresh orgs.
  // Idempotent: a Role already carrying the exact bundle is skipped (no write, not
  // counted). Scoped to system Roles only — user-authored custom Roles (system:false)
  // are never touched.
  // A named-bundle Role (the system org's Ecosystem Manager) re-syncs to ITS
  // bundle, never to the Member bundle it shares `grantsRole: 'member'` with.
  const builtinRoles = await Role.find({ system: true })
    .select('_id grantsRole seedBundle permissions').lean();

  let rolesBackfilled = 0;
  for (const g of builtinRoles) {
    const desired = builtinRolePermissions({
      grantsRole: g.grantsRole as RoleGrant,
      seedBundle: g.seedBundle as RoleSeedBundle | undefined,
    });
    const current = (g.permissions as string[] | undefined) ?? [];
    if (permissionSetsEqual(current, desired)) continue; // already in sync — no-op
    await Role.updateOne({ _id: g._id }, { $set: { permissions: desired } });
    rolesBackfilled += 1;
  }
  if (rolesBackfilled > 0) {
    logger.info('Re-synced stale built-in Role permission bundles', { rolesBackfilled });
  }

  // ── Pass B: ensure each active member holds the Role matching their role ────
  // Build org → { member, admin } built-in-Role id map, keyed off the stable
  // `grantsRole` (name-independent).
  // `seedBundle: null` keeps the Ecosystem Manager (grantsRole 'member') out of
  // the Member slot — no member is ever auto-assigned an ecosystem Role.
  const builtins = await Role.find({
    system: true,
    grantsRole: { $in: ['member', 'admin'] },
    seedBundle: null,
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
    rolesCreated,
  };
  logger.info('RBAC Roles backfill complete', summary);
  return summary;
}
