// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AUTOMATION_ACCOUNT_BUNDLES, createLogger, emitCounter, emitGauge, isSystemOrgId, type RoleGrant, type SeedBundleId, SYSTEM_ACTOR_ID, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import type { Types } from 'mongoose';
import { builtinRolePermissions } from './role-authority.js';
import { DEFAULT_ORG_ROLES, SYSTEM_ORG_ROLES, type BuiltinRoleSpec } from './roles-service.js';
import { recordAuditEvent } from '../helpers/audit.js';
import { publishUsersRevocation } from '../helpers/session-revocation.js';
import type { AuditAction } from '../models/audit-event.js';
import { Role, RoleAssignment, ServiceAccount, User, UserOrganization } from '../models/index.js';

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
  /**
   * Automation service accounts (`platform-automation`, `pipeline-register`,
   * `reporting-ingest`, `registry-push`) moved OFF an admin-granting Role and
   * onto their least-privilege one (Pass C).
   */
  serviceAccountsNarrowed: number;
  /**
   * Automation accounts still holding an admin-granting Role because their org
   * has no least-privilege Role to move them onto — left working rather than
   * stripped to nothing, and warned about.
   */
  serviceAccountsUnnarrowed: number;
}

/** Why every row this job writes exists — the filter that separates its
 *  changes from a person's on the org's trail. */
const BACKFILL_REASON = 'rbac-backfill';

/**
 * Record one change the backfill made, under the system actor and against the
 * org it changed. Each pass is a Role or assignment edit no person performed;
 * without a row it is indistinguishable from one nobody can account for.
 */
function auditBackfill(
  action: AuditAction,
  orgId: string,
  target: { targetType: string; targetId: string; roleId: string },
  details: Record<string, unknown>,
): void {
  recordAuditEvent({
    action,
    actorId: SYSTEM_ACTOR_ID,
    orgId: SYSTEM_ORG_ID,
    affectedOrgId: orgId,
    ...target,
    outcome: 'success',
    details: { ...details, reason: BACKFILL_REASON },
  });
}

/** `bulkWrite`'s op-index → upserted `_id` map, tolerating a driver (or test
 *  double) that omits it. */
function upsertedIdsOf(res: { upsertedIds?: Record<number, unknown> }): Map<number, string> {
  return new Map(Object.entries(res.upsertedIds ?? {}).map(([i, id]) => [Number(i), String(id)]));
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
 *   c. The automation SERVICE ACCOUNTS `infra store-token` provisions are moved
 *      off an admin-granting Role onto their least-privilege one (see
 *      {@link narrowAutomationAccounts}). People are never touched by it.
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
  // lists have grown that way — the system org's eight job Roles (whose
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
    (isSystemOrgId(orgId) ? SYSTEM_ORG_ROLES : DEFAULT_ORG_ROLES);

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
    for (const [i, id] of upsertedIdsOf(res as { upsertedIds?: Record<number, unknown> })) {
      const created = toCreate[i];
      if (!created) continue;
      auditBackfill('org.role.create', created.orgId, { targetType: 'role', targetId: id, roleId: id }, {
        name: created.spec.name,
        permissions: builtinRolePermissions(created.spec),
      });
    }
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
  const stale: Array<{ id: Types.ObjectId; orgId: string; name: string; current: string[]; desired: string[] }> = [];
  for await (const g of Role.find({ system: true })
    .select('_id organizationId name grantsRole seedBundle permissions').lean().cursor()) {
    const desired = builtinRolePermissions({
      grantsRole: g.grantsRole as RoleGrant,
      seedBundle: g.seedBundle as SeedBundleId | undefined,
    });
    const current = (g.permissions as string[] | undefined) ?? [];
    if (permissionSetsEqual(current, desired)) continue; // already in sync — no-op
    stale.push({ id: g._id as Types.ObjectId, orgId: String(g.organizationId), name: String(g.name), current, desired });
  }

  let rolesBackfilled = 0;
  let claimsBumped = 0;
  if (stale.length > 0) {
    // One round trip instead of one per Role.
    await Role.bulkWrite(stale.map(({ id, desired }) => ({
      updateOne: { filter: { _id: id }, update: { $set: { permissions: desired } } },
    })), { ordered: false });
    rolesBackfilled = stale.length;
    // Both sides of every rewrite: a bundle change is a permission grant or
    // revoke for everyone holding the Role.
    for (const r of stale) {
      auditBackfill('org.role.update', r.orgId, { targetType: 'role', targetId: String(r.id), roleId: String(r.id) }, {
        name: r.name,
        before: { permissions: r.current },
        after: { permissions: r.desired },
      });
    }

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

  // ── Pass C: move the automation service accounts OFF the org admin Role ────
  const { serviceAccountsNarrowed, serviceAccountsUnnarrowed } = await narrowAutomationAccounts();

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
  // Parallel to `ops`: who each op is for, so an upsert can be audited by id.
  let opMeta: Array<{ userId: string; roleId: string; orgId: string; orgRole: string }> = [];
  const flush = async (): Promise<void> => {
    if (ops.length === 0) return;
    const res = await RoleAssignment.bulkWrite(ops, { ordered: false });
    assignmentsAdded += res.upsertedCount ?? 0;
    for (const [i] of upsertedIdsOf(res as { upsertedIds?: Record<number, unknown> })) {
      const meta = opMeta[i];
      if (!meta) continue;
      auditBackfill('org.role.member.add', meta.orgId, { targetType: 'user', targetId: meta.userId, roleId: meta.roleId }, {
        orgRole: meta.orgRole,
      });
    }
    ops = [];
    opMeta = [];
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
    opMeta.push({ userId: String(m.userId), roleId: String(roleId), orgId: key, orgRole: String(m.role) });
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
    serviceAccountsNarrowed,
    serviceAccountsUnnarrowed,
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
  emitGauge('platform_rbac_backfill_service_accounts_narrowed', {}, summary.serviceAccountsNarrowed);
  emitGauge('platform_rbac_backfill_service_accounts_unnarrowed', {}, summary.serviceAccountsUnnarrowed);
  emitCounter('platform_rbac_backfill_runs_total', { result: 'ok' });

  logger.info('RBAC Roles backfill complete', summary);
  return summary;
}

/** The coarse grants that make a Role an ADMIN Role — what Pass C takes away. */
const ADMIN_GRANTS: readonly RoleGrant[] = ['admin', 'superadmin'];

/**
 * Pass C: move the service accounts `pipeline-manager infra store-token`
 * provisions off the org ADMIN Role and onto the least-privilege Role api-core's
 * `AUTOMATION_ACCOUNT_BUNDLES` names for them — `Pipeline Automation` for
 * `platform-automation`, `Pipeline Registration` for `pipeline-register`, and NO
 * Role for the scoped `reporting-ingest` / `registry-push` accounts, whose keys
 * carry a capability scope instead of permissions.
 *
 * `platform-automation` was created holding the Admin Role (Super Admin in the
 * system org), so a leaked synth credential could rewrite every pipeline, Role
 * and member of its org. Doing this at boot rather than asking every operator to
 * re-run `store-token` is what makes the narrowing reach existing installs.
 *
 * The rules, and why:
 *  - **Only accounts holding an admin-granting Role are touched.** That is the
 *    signature of the old provisioning. An account an operator already narrowed
 *    by hand — or one this pass already moved — holds none, and is left exactly
 *    as it is. That is also what makes a repeat run a no-op.
 *  - **Only the admin-granting assignments are removed.** A custom Role an
 *    operator added deliberately stays.
 *  - **Never stripped to nothing by accident.** If the org has no target Role
 *    (an org Pass 0 would not seed), the account keeps its admin Role and is
 *    counted in `serviceAccountsUnnarrowed` — a broken pipeline is worse than an
 *    over-privileged one that is reported.
 *  - **Service accounts only.** The filter is `serviceAccountId`; a person's
 *    assignment is never read or written here.
 *  - **No session to revoke.** A service account has no session and no
 *    `claimsVersion`; every key exchange re-derives its permissions from these
 *    assignments, so the narrowing reaches a live key within one exchanged-token
 *    lifetime (5 minutes). Publishing a KEY revocation instead would stop the
 *    automation outright, which is not the intent.
 */
async function narrowAutomationAccounts(): Promise<{ serviceAccountsNarrowed: number; serviceAccountsUnnarrowed: number }> {
  const bundleByName = new Map<string, SeedBundleId | null>(
    Object.entries(AUTOMATION_ACCOUNT_BUNDLES) as Array<[string, SeedBundleId | null]>,
  );
  // Bounded by (orgs x four names), never by the size of the collection.
  const accounts = await ServiceAccount.find({ name: { $in: [...bundleByName.keys()] } })
    .select('_id organizationId name').lean();
  if (accounts.length === 0) return { serviceAccountsNarrowed: 0, serviceAccountsUnnarrowed: 0 };

  const held = await RoleAssignment.find({ serviceAccountId: { $in: accounts.map((a) => a._id) } })
    .select('_id serviceAccountId roleId').lean();
  if (held.length === 0) return { serviceAccountsNarrowed: 0, serviceAccountsUnnarrowed: 0 };
  const adminRoleIds = new Set((await Role.find({
    _id: { $in: [...new Set(held.map((a) => String(a.roleId)))] },
    grantsRole: { $in: ADMIN_GRANTS },
  }).select('_id').lean()).map((r) => String(r._id)));

  const adminHeldBy = new Map<string, Array<{ assignmentId: Types.ObjectId; roleId: string }>>();
  for (const a of held) {
    if (!adminRoleIds.has(String(a.roleId))) continue;
    const key = String(a.serviceAccountId);
    adminHeldBy.set(key, [...(adminHeldBy.get(key) ?? []), { assignmentId: a._id as Types.ObjectId, roleId: String(a.roleId) }]);
  }
  const toNarrow = accounts.filter((a) => adminHeldBy.has(String(a._id)));
  if (toNarrow.length === 0) return { serviceAccountsNarrowed: 0, serviceAccountsUnnarrowed: 0 };

  // The target Roles, per org — found by their stable `seedBundle`, never by name.
  const targets = new Map<string, Types.ObjectId>();
  const wantedBundles = [...new Set([...bundleByName.values()].filter((b): b is SeedBundleId => !!b))];
  for (const r of await Role.find({
    system: true,
    seedBundle: { $in: wantedBundles },
    organizationId: { $in: [...new Set(toNarrow.map((a) => String(a.organizationId)))] },
  }).select('_id organizationId seedBundle').lean()) {
    targets.set(`${String(r.organizationId)}:${String(r.seedBundle)}`, r._id as Types.ObjectId);
  }

  const removeIds: Types.ObjectId[] = [];
  const grants: Array<Parameters<typeof RoleAssignment.bulkWrite>[0][number]> = [];
  const narrowed: string[] = [];
  const unnarrowed: string[] = [];
  // Audited only once the writes below land — from/to Role per account.
  const moves: Array<{ accountId: string; orgId: string; name: string; fromRoleIds: string[]; toRoleId?: string }> = [];
  for (const account of toNarrow) {
    const bundle = bundleByName.get(String(account.name)) ?? null;
    const target = bundle ? targets.get(`${String(account.organizationId)}:${bundle}`) : undefined;
    if (bundle && !target) {
      unnarrowed.push(String(account._id));
      continue;
    }
    const removed = adminHeldBy.get(String(account._id)) ?? [];
    removeIds.push(...removed.map((r) => r.assignmentId));
    moves.push({
      accountId: String(account._id),
      orgId: String(account.organizationId),
      name: String(account.name),
      fromRoleIds: removed.map((r) => r.roleId),
      ...(target ? { toRoleId: String(target) } : {}),
    });
    if (target) {
      grants.push({
        updateOne: {
          filter: { serviceAccountId: account._id, roleId: target },
          update: { $setOnInsert: { serviceAccountId: account._id, roleId: target, organizationId: account.organizationId } },
          upsert: true,
        },
      });
    }
    narrowed.push(String(account._id));
  }

  // GRANT before REVOKE: a crash between the two leaves an account holding both
  // (still working, and the next boot finishes the move), never neither.
  if (grants.length > 0) await RoleAssignment.bulkWrite(grants, { ordered: false });
  if (removeIds.length > 0) await RoleAssignment.deleteMany({ _id: { $in: removeIds }, serviceAccountId: { $ne: null } });

  for (const m of moves) {
    const account = { targetType: 'service-account', targetId: m.accountId };
    if (m.toRoleId) {
      auditBackfill('org.role.member.add', m.orgId, { ...account, roleId: m.toRoleId }, { name: m.name, fromRoleIds: m.fromRoleIds });
    }
    for (const from of m.fromRoleIds) {
      auditBackfill('org.role.member.remove', m.orgId, { ...account, roleId: from }, { name: m.name, ...(m.toRoleId ? { toRoleId: m.toRoleId } : {}) });
    }
  }

  if (narrowed.length > 0) {
    logger.info('Moved automation service accounts off the org admin Role', {
      serviceAccountsNarrowed: narrowed.length,
      names: [...new Set(toNarrow.filter((a) => narrowed.includes(String(a._id))).map((a) => String(a.name)))],
    });
  }
  if (unnarrowed.length > 0) {
    logger.warn('Automation service accounts still hold the org admin Role — their org has no least-privilege Role to move them onto', {
      serviceAccountsUnnarrowed: unnarrowed.length,
      sample: unnarrowed.slice(0, 10),
      fix: 'Pass 0 seeds the machine Roles only in orgs that already hold built-in Roles; re-run org seeding for these orgs, then restart platform.',
    });
  }
  return { serviceAccountsNarrowed: narrowed.length, serviceAccountsUnnarrowed: unnarrowed.length };
}
