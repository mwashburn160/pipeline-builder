// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, emitCounter, emitGauge, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import type { Types } from 'mongoose';
import { builtinRolePermissions } from './role-authority.js';
import { DEFAULT_ORG_ROLES, SYSTEM_ORG_ROLES, type BuiltinRoleSpec } from './roles-service.js';
import { publishUsersRevocation } from '../helpers/session-revocation.js';
import { Role, RoleAssignment, User, UserOrganization } from '../models/index.js';
import type { RoleGrant, RoleSeedBundle } from '../models/index.js';

const logger = createLogger('rbac-backfill');

/** Summary of a single backfill run (for logging, metrics and tests). */
export interface RbacBackfillSummary {
  orgsScanned: number;
  rolesBackfilled: number;
  assignmentsAdded: number;
  /** Built-in Roles that did not exist in their org and were created. */
  rolesCreated: number;
  /**
   * Orgs holding NO built-in Role at all — their members have no permissions
   * whatsoever, and Pass B can do nothing for them.
   *
   * The most severe state this job can encounter, and it used to be a silent
   * `continue`. Reported here, warned about, and exported as a gauge so it can
   * be alerted on, because an org in this state looks identical from the outside
   * to an org whose members simply have not been granted anything.
   */
  orgsMissingBuiltinRoles: number;
  /**
   * Users whose `claimsVersion` was bumped because a bundle they hold changed.
   *
   * Without this a Pass A rewrite that REMOVES a permission left it effective in
   * every in-flight access token until it expired, while the same edit made by
   * hand through `role-crud` revoked immediately. Same change, two different
   * guarantees — now one.
   */
  claimsBumped: number;
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
 *   0. Any built-in Role an org's source list has but the database does not is
 *      created — for EVERY org, not just the system one. Pass (a) can only fix a
 *      drifted BUNDLE; a Role added to the source after a deployment was
 *      installed would otherwise never exist there. That is not hypothetical in
 *      either direction: the system org's job Roles carry system-org-only
 *      permissions that nothing else can grant, and `Team Lead` reached
 *      `DEFAULT_ORG_ROLES` after Admin and Member, so every tenant seeded before
 *      it had no carrier for `reports:write` / `reports:publish` at all.
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
  // ── Pass 0: CREATE any built-in Role an org is missing, in EVERY org ───────
  // Pass A below re-syncs the permissions of built-ins that EXIST, which is what
  // lets a new catalog permission reach an existing org's Admin Role. It cannot
  // help a newly-added ROLE: on a deployment that already ran `seedDefaultRoles`,
  // a Role added to the source afterwards simply would not be there. Both source
  // lists have grown that way — the system org's six job Roles (whose
  // system-org-only permissions nothing else can grant, most recently
  // `Registry Operator` carrying `registry:write`) and `Team Lead` in every
  // tenant (whose `reports:write` / `reports:publish` likewise have no other
  // carrier).
  //
  // ONLY ORGS THAT WERE ALREADY SEEDED. An org holding no built-in Role at all is
  // either mid-creation or broken, and inventing a full Role set for it would
  // race `seedDefaultRoles` (which also decides what the CREATOR joins) and could
  // leave an org whose owner holds nothing. Those orgs are reported instead —
  // see `orgsMissingBuiltinRoles`.
  //
  // Race-safe regardless: `{ organizationId, name }` is uniquely indexed, so the
  // upsert below either inserts or does nothing even if a real seed lands at the
  // same moment. `$setOnInsert` means an existing Role is never rewritten here —
  // Pass A owns its bundle, including one an operator renamed (a rename produces
  // a second Role rather than a silent overwrite, which is the safe direction:
  // nothing is assigned to the new one).
  // Streamed: only the org → names index is retained, which is bounded by
  // (orgs x built-ins) rather than by the collection. Reading every built-in
  // Role of the fleet into an array first was the same unbounded shape Pass B
  // had.
  const namesByOrg = new Map<string, Set<string>>();
  for await (const r of Role.find({ system: true }).select('organizationId name').lean().cursor()) {
    const key = String(r.organizationId);
    const set = namesByOrg.get(key) ?? new Set<string>();
    set.add(String(r.name));
    namesByOrg.set(key, set);
  }

  const specsFor = (orgId: string): readonly BuiltinRoleSpec[] =>
    (orgId === SYSTEM_ORG_ID ? SYSTEM_ORG_ROLES : DEFAULT_ORG_ROLES);

  const toCreate: Array<{ orgId: string; spec: BuiltinRoleSpec }> = [];
  for (const [orgId, have] of namesByOrg) {
    for (const spec of specsFor(orgId)) {
      if (!have.has(spec.name)) toCreate.push({ orgId, spec });
    }
  }

  let rolesCreated = 0;
  if (toCreate.length > 0) {
    const res = await Role.bulkWrite(toCreate.map(({ orgId, spec }) => ({
      updateOne: {
        filter: { organizationId: orgId, name: spec.name },
        update: {
          $setOnInsert: {
            organizationId: orgId,
            name: spec.name,
            grantsRole: spec.grantsRole,
            ...(spec.seedBundle ? { seedBundle: spec.seedBundle } : {}),
            permissions: builtinRolePermissions(spec),
            system: true,
          },
        },
        upsert: true,
      },
    })), { ordered: false });
    rolesCreated = res.upsertedCount ?? 0;
    if (rolesCreated > 0) {
      logger.info('Created missing built-in Roles', {
        rolesCreated,
        // The NAMES, not the org ids: which Role the source grew is the useful
        // fact, and the id list is unbounded.
        names: [...new Set(toCreate.map((t) => t.spec.name))],
      });
    }
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
  // Re-read AFTER Pass 0 so a Role it just created is included — it is already
  // in sync, so this costs a comparison and no write.
  //
  // Streamed, and only the DRIFTED Roles are retained — which on a healthy
  // deployment is none. Reading every built-in Role of the fleet into an array
  // to compare them one at a time kept the whole collection alive for the
  // duration of a scan whose output is usually empty.
  const stale: Array<{ id: Types.ObjectId; desired: string[] }> = [];
  for await (const g of Role.find({ system: true })
    .select('_id grantsRole seedBundle permissions').lean().cursor()) {
    const desired = builtinRolePermissions({
      grantsRole: g.grantsRole as RoleGrant,
      seedBundle: g.seedBundle as RoleSeedBundle | undefined,
    });
    const current = (g.permissions as string[] | undefined) ?? [];
    if (permissionSetsEqual(current, desired)) continue; // already in sync — no-op
    stale.push({ id: g._id as Types.ObjectId, desired });
  }

  let rolesBackfilled = 0;
  let claimsBumped = 0;
  if (stale.length > 0) {
    // One round trip instead of one per Role.
    await Role.bulkWrite(stale.map(({ id, desired }) => ({
      updateOne: { filter: { _id: id }, update: { $set: { permissions: desired } } },
    })), { ordered: false });
    rolesBackfilled = stale.length;

    // INVALIDATE THE SESSIONS THAT HOLD WHAT JUST CHANGED, exactly as an
    // interactive edit does (`role-crud.ts` → `claimsVersion` + a published
    // revocation). Without it a rewrite that REMOVES a permission left it live in
    // every in-flight access token for the token's full TTL, while the same edit
    // made by hand revoked immediately — the same change with two different
    // guarantees, and the weaker one applied to the path nobody watches.
    //
    // USERS only: a service account holds no session and no `claimsVersion`; its
    // next token exchange re-derives the new permissions.
    const assignees = await RoleAssignment
      .find({ roleId: { $in: stale.map((r) => r.id) }, userId: { $ne: null } })
      .select('userId').lean();
    const userIds = [...new Set(assignees.map((a) => String(a.userId)))];
    if (userIds.length > 0) {
      await User.updateMany({ _id: { $in: userIds } }, { $inc: { claimsVersion: 1 } });
      claimsBumped = userIds.length;
      // Post-write, best-effort: tells the stateless services to reject the
      // holders' in-flight tokens now rather than at expiry.
      await publishUsersRevocation(userIds);
    }
    logger.info('Re-synced stale built-in Role permission bundles', { rolesBackfilled, claimsBumped });
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

  const orgsScanned = new Set<string>();
  // Orgs with a live membership but NO built-in Role to assign. Their members
  // hold no permissions at all, which Pass B cannot fix and Pass 0 deliberately
  // will not guess at. Collected so the run can SAY so — this was a bare
  // `continue`, which made the worst state the job can meet the only one it
  // reported nothing about.
  const orgsMissingBuiltins = new Set<string>();
  // STREAMED, and flushed as it goes. The memberships of the WHOLE fleet used
  // to be read into an array and the ops accumulated into a second one before a
  // single write — two copies of a collection with no upper bound, at every pod
  // start. A cursor holds one document at a time and the buffer never exceeds
  // one chunk.
  //
  // ONE round trip per 1000 memberships, not one per membership: this runs at
  // every pod start, so its cost is the fleet's membership count times the
  // number of pods, and a loop of awaits made it the slowest thing in boot.
  // Chunked because a single bulkWrite payload is bounded.
  let assignmentsAdded = 0;
  const CHUNK = 1000;
  let ops: Array<Parameters<typeof RoleAssignment.bulkWrite>[0][number]> = [];
  const flush = async (): Promise<void> => {
    if (ops.length === 0) return;
    const res = await RoleAssignment.bulkWrite(ops, { ordered: false });
    assignmentsAdded += res.upsertedCount ?? 0;
    ops = [];
  };

  for await (const m of UserOrganization.find({ isActive: true })
    .select('userId organizationId role').lean().cursor()) {
    const key = String(m.organizationId);
    orgsScanned.add(key);
    const roles = byOrg.get(key);
    if (!roles) {
      orgsMissingBuiltins.add(key);
      continue;
    }

    // owner + admin → Admin Role (owner == admin bundle); member → Member Role.
    const roleId = m.role === 'member' ? roles.member : roles.admin;
    if (!roleId) {
      // The org has SOME built-ins but not the one this membership needs — the
      // same hole, one slot wide, and just as invisible before this.
      orgsMissingBuiltins.add(key);
      continue;
    }

    ops.push({
      updateOne: {
        filter: { userId: m.userId, roleId },
        update: { $setOnInsert: { userId: m.userId, roleId, organizationId: m.organizationId } },
        upsert: true,
      },
    });
    if (ops.length >= CHUNK) await flush();
  }
  await flush();

  if (orgsMissingBuiltins.size > 0) {
    logger.warn('Organizations have live members but no built-in Role to assign — those members hold NO permissions', {
      orgsMissingBuiltinRoles: orgsMissingBuiltins.size,
      // A bounded sample: enough to go and look, not an unbounded id dump.
      sample: [...orgsMissingBuiltins].slice(0, 10),
      fix: 'Re-run org seeding for these orgs (seedDefaultRoles) — the backfill will not invent a Role set, because that races creation and cannot know what the owner should join.',
    });
  }

  const summary: RbacBackfillSummary = {
    orgsScanned: orgsScanned.size,
    rolesBackfilled,
    assignmentsAdded,
    rolesCreated,
    orgsMissingBuiltinRoles: orgsMissingBuiltins.size,
    claimsBumped,
  };

  // OBSERVABILITY. The caller swallows failures so boot is never blocked
  // (index.ts), which means a backfill that fails on every start, or silently
  // skips half the fleet, looked exactly like one that worked. Gauges rather
  // than counters: each is the state at last boot, which is what you alert on.
  //
  // Through api-core's SEAM, not platform's `observability/metrics.js`. That
  // helper's `ensureRegistry()` THROWS when no registry is set, and this whole
  // function is wrapped in a try/catch by its caller — so importing it turned
  // "no metrics registry" into "the entire backfill silently does nothing",
  // which is the failure these metrics exist to make visible. The seam no-ops
  // until the app factory wires it and swallows emitter errors by contract.
  emitGauge('platform_rbac_backfill_orgs_missing_builtin_roles', {}, summary.orgsMissingBuiltinRoles);
  emitGauge('platform_rbac_backfill_roles_created', {}, summary.rolesCreated);
  emitGauge('platform_rbac_backfill_roles_resynced', {}, summary.rolesBackfilled);
  emitGauge('platform_rbac_backfill_assignments_added', {}, summary.assignmentsAdded);
  emitCounter('platform_rbac_backfill_runs_total', { result: 'ok' });

  logger.info('RBAC Roles backfill complete', summary);
  return summary;
}
