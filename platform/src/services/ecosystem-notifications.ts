// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin-ecosystem notification delivery.
 *
 * Platform is the relay because it owns the three things delivery needs: the
 * user directory (addresses), the Roles (who holds a permission RIGHT NOW) and
 * SMTP. A request names recipient RULES ({@link EcosystemRecipientSpec}); this
 * module resolves them at send time, applies each user's per-org
 * `notifications.ecosystem` email preferences (never for transactional notices),
 * drops the in-app copy into each recipient's inbox through the message service
 * and mails every recipient INDIVIDUALLY — a shared To: line would tell a
 * publisher which orgs installed their plugin.
 *
 * Callers: the `/internal/notify-email` relay (the plugin service) and
 * platform's own events (N23, Ecosystem Manager role changes).
 */

import {
  createLogger,
  ECOSYSTEM_EMAIL_PREFERENCE_FIELDS,
  ECOSYSTEM_NOTIFICATION_EVENTS,
  errorMessage,
  renderEcosystemManagerChange,
  SYSTEM_ORG_ID,
  type EcosystemNotifyRequest,
  type EcosystemRecipientSpec,
} from '@pipeline-builder/api-core';
import { toOrgId } from '../helpers/org-id.js';
import { Role, RoleAssignment, User, UserOrganization, UserPreferences } from '../models/index.js';
import { incCounter } from '../observability/metrics.js';

const logger = createLogger('ecosystem-notifications');

/** A Mongo user id. */
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

/** One resolved user: where their in-app copy lands (and whose per-org
 *  preferences govern their email). */
interface ResolvedUser { inboxOrgId: string | undefined }

/** The outcome of one delivery. Counts, never identities. */
export interface EcosystemDeliveryReport {
  /** Users + raw addresses the rules resolved to. */
  recipientCount: number;
  inApp: number;
  emailed: number;
  /** Emails withheld by a user's opt-out preference. */
  suppressed: number;
  /** Email sends that failed (logged and counted). */
  failed: number;
}

type Id = { toString(): string };
const ids = (rows: Array<{ userId?: Id | null }>): string[] =>
  rows.map((r) => r.userId?.toString()).filter((u): u is string => !!u);

/** Active members of `orgId`, optionally narrowed to `userIds`. */
async function activeMembers(orgId: string, userIds?: string[]): Promise<string[]> {
  if (userIds && userIds.length === 0) return [];
  const rows = await UserOrganization.find({
    organizationId: toOrgId(orgId),
    isActive: true,
    ...(userIds ? { userId: { $in: userIds } } : {}),
  }).select('userId').lean();
  return ids(rows as Array<{ userId?: Id | null }>);
}

/**
 * Active members of `orgId` whose Roles IN THAT ORG carry `permission`. Service
 * accounts are skipped (their assignments carry no `userId`), and superadmins
 * are not implicitly included — they are nobody's org member by virtue of the
 * flag alone.
 */
export async function holdersOfPermission(orgId: string, permission: string): Promise<string[]> {
  const oid = toOrgId(orgId);
  const roles = await Role.find({ organizationId: oid, permissions: permission }).select('_id').lean();
  if (roles.length === 0) return [];
  const assignments = await RoleAssignment.find({
    organizationId: oid,
    roleId: { $in: roles.map((r) => r._id) },
    userId: { $ne: null },
  }).select('userId').lean();
  return activeMembers(orgId, [...new Set(ids(assignments as Array<{ userId?: Id | null }>))]);
}

async function ownersOf(orgId: string): Promise<string[]> {
  const rows = await UserOrganization.find({ organizationId: toOrgId(orgId), isActive: true, role: 'owner' }).select('userId').lean();
  return ids(rows as Array<{ userId?: Id | null }>);
}

async function superadmins(): Promise<Array<{ id: string; lastActiveOrgId?: string }>> {
  const rows = await User.find({ isSuperAdmin: true }).select('_id lastActiveOrgId').lean();
  return (rows as Array<{ _id: Id; lastActiveOrgId?: string | null }>).map((u) => ({
    id: u._id.toString(),
    ...(u.lastActiveOrgId ? { lastActiveOrgId: String(u.lastActiveOrgId) } : {}),
  }));
}

/** How many people could decide an ecosystem request. Counts, never identities. */
export interface EcosystemApproverCount {
  /** Active system-org members whose Roles carry the permission. */
  holders: number;
  /** Holders left after the exclusions (conflicts of interest). */
  eligible: number;
  /** Superadmins not excluded: they may always decide, and receive moderator
   *  notices when no holder is eligible. */
  superadmins: number;
}

/**
 * Count the system org's holders of `permission` (the Ecosystem Managers),
 * minus the conflicts of interest the caller names: members of the requesting
 * orgs and specific users (the submitter, the first approver). The same
 * resolution the `moderators` recipient rule uses, so the console's number and
 * who actually gets asked never disagree.
 */
export async function countEcosystemApprovers(
  permission: string,
  exclude: { memberOfOrgIds?: readonly string[]; userIds?: readonly string[] } = {},
): Promise<EcosystemApproverCount> {
  const excluded = new Set(exclude.userIds ?? []);
  for (const orgId of exclude.memberOfOrgIds ?? []) {
    for (const u of await activeMembers(orgId)) excluded.add(u);
  }
  const holders = await holdersOfPermission(SYSTEM_ORG_ID, permission);
  const admins = await superadmins();
  return {
    holders: holders.length,
    eligible: holders.filter((u) => !excluded.has(u)).length,
    superadmins: admins.filter((s) => !excluded.has(s.id)).length,
  };
}

/**
 * Resolve recipient rules into users (keyed by id, first rule wins for the
 * inbox org) and raw addresses. Exported for tests.
 */
export async function resolveEcosystemRecipients(
  specs: readonly EcosystemRecipientSpec[],
): Promise<{ users: Map<string, ResolvedUser>; addresses: Set<string> }> {
  const users = new Map<string, ResolvedUser>();
  const addresses = new Set<string>();
  const add = (userId: string, inboxOrgId: string | undefined): void => {
    if (!users.has(userId)) users.set(userId, { inboxOrgId });
  };

  for (const spec of specs) {
    switch (spec.kind) {
      case 'user': {
        const user = await User.findById(spec.userId).select('_id lastActiveOrgId').lean();
        if (user) add(user._id.toString(), spec.orgId ?? (user.lastActiveOrgId ? String(user.lastActiveOrgId) : undefined));
        break;
      }
      case 'org_permission': {
        // Org approvers / publisher managers: holders in the org; a team whose
        // policy is inherited falls back to its ROOT org's holders; with nobody
        // holding it anywhere, the org's owners.
        let found = (await holdersOfPermission(spec.orgId, spec.permission)).map((u) => ({ u, org: spec.orgId }));
        if (found.length === 0 && spec.inheritFromRoot) {
          const { resolveOrgLineage } = await import('../helpers/org-hierarchy.js');
          const { rootOrgId } = await resolveOrgLineage(spec.orgId);
          if (rootOrgId && rootOrgId !== spec.orgId) {
            found = (await holdersOfPermission(rootOrgId, spec.permission)).map((u) => ({ u, org: rootOrgId }));
          }
        }
        if (found.length === 0) found = (await ownersOf(spec.orgId)).map((u) => ({ u, org: spec.orgId }));
        for (const { u, org } of found) add(u, org);
        break;
      }
      case 'org_members':
        // An org's chosen recipients (plugin security notices): only the named
        // users who are ACTIVE members of that org right now — a stale id or
        // someone who left receives nothing.
        // Only ObjectId-shaped ids reach the query (anything else would fail the
        // whole delivery on a cast error, and names nobody anyway).
        for (const u of await activeMembers(spec.orgId, spec.userIds.filter((id) => OBJECT_ID_RE.test(id)))) add(u, spec.orgId);
        break;
      case 'moderators': {
        // The system org's Ecosystem Managers, minus conflicts of interest; the
        // superadmins when nobody else is eligible.
        const excluded = new Set(spec.excludeUserIds ?? []);
        if (spec.excludeMembersOfOrgId) {
          for (const u of await activeMembers(spec.excludeMembersOfOrgId)) excluded.add(u);
        }
        const holders = (await holdersOfPermission(SYSTEM_ORG_ID, spec.permission)).filter((u) => !excluded.has(u));
        if (holders.length > 0) {
          for (const u of holders) add(u, SYSTEM_ORG_ID);
        } else {
          const fallback = (await superadmins()).filter((s) => !excluded.has(s.id));
          if (fallback.length === 0) logger.warn('No eligible moderator for an ecosystem notice', { permission: spec.permission });
          for (const s of fallback) add(s.id, SYSTEM_ORG_ID);
        }
        break;
      }
      case 'superadmins':
        for (const s of await superadmins()) add(s.id, s.lastActiveOrgId ?? SYSTEM_ORG_ID);
        break;
      case 'address':
        addresses.add(spec.email);
        break;
    }
  }
  return { users, addresses };
}

/** Users (of `candidates`) who turned `field` off in the given org's preferences. */
async function optedOut(candidates: Map<string, ResolvedUser>, field: string): Promise<Set<string>> {
  const userIds = [...candidates.keys()];
  if (userIds.length === 0) return new Set();
  const rows = await UserPreferences.find({ userId: { $in: userIds } }).select('userId organizationId notifications').lean();
  const out = new Set<string>();
  for (const row of rows as Array<{ userId: Id; organizationId: string; notifications?: { ecosystem?: Record<string, boolean> } }>) {
    const userId = row.userId.toString();
    if (candidates.get(userId)?.inboxOrgId !== row.organizationId) continue;
    if (row.notifications?.ecosystem?.[field] === false) out.add(userId);
  }
  return out;
}

/**
 * Deliver one ecosystem notice. Never throws for a single failed email (it is
 * logged and counted as `ecosystem_notification_failed_total{event}`); throws
 * only when recipient resolution itself fails, so the caller can retry.
 */
export async function deliverEcosystemNotification(request: EcosystemNotifyRequest): Promise<EcosystemDeliveryReport> {
  const spec = ECOSYSTEM_NOTIFICATION_EVENTS[request.event];
  const channels = request.channels ?? spec.channels;
  const { users, addresses } = await resolveEcosystemRecipients(request.recipients);
  const report: EcosystemDeliveryReport = { recipientCount: users.size + addresses.size, inApp: 0, emailed: 0, suppressed: 0, failed: 0 };

  if (channels.includes('in_app') && users.size > 0) {
    const { sendInAppNotificationConfirmed } = await import('../helpers/in-app-notify.js');
    for (const [userId, { inboxOrgId }] of users) {
      if (!inboxOrgId) continue;
      const ok = await sendInAppNotificationConfirmed({
        recipientOrgId: inboxOrgId, recipientUserId: userId, subject: request.subject, content: request.text,
      });
      if (ok) report.inApp++;
    }
  }

  if (channels.includes('email')) {
    // Transactional notices ignore preferences; so does a notice the sender
    // marks mandatory (N24 yank / advisory / security-fix requests).
    const field = spec.preference && !request.mandatory ? ECOSYSTEM_EMAIL_PREFERENCE_FIELDS[spec.preference] : undefined;
    const skip = field ? await optedOut(users, field) : new Set<string>();
    report.suppressed = skip.size;
    const wanted = [...users.keys()].filter((u) => !skip.has(u));
    const rows = wanted.length > 0 ? await User.find({ _id: { $in: wanted } }).select('email').lean() : [];
    const emails = new Set([
      ...(rows as Array<{ email?: string }>).map((u) => u.email).filter((e): e is string => typeof e === 'string' && e.length > 0),
      ...addresses,
    ]);
    const { emailService } = await import('../utils/email.js');
    for (const to of emails) {
      // One message per recipient: no recipient ever sees another's address.
      let ok = false;
      try {
        ok = await emailService.send({ to, subject: request.subject, text: request.text });
      } catch (err) {
        logger.warn('Ecosystem email send threw', { event: request.event, error: errorMessage(err) });
      }
      if (ok) {
        report.emailed++;
      } else {
        report.failed++;
        incCounter('ecosystem_notification_failed_total', { event: request.event });
      }
    }
  }

  logger.info('Ecosystem notification delivered', { event: request.event, ...report });
  return report;
}

/**
 * The `N23` notice: someone was added to or removed from the system org's Ecosystem
 * Manager role. Tells every superadmin and the affected user (in-app + email,
 * transactional). Fire-and-forget: never throws, never blocks the assignment.
 */
export async function notifyEcosystemManagerChange(input: { userId: string; added: boolean; actorUserId?: string }): Promise<void> {
  try {
    const [user, actor] = await Promise.all([
      User.findById(input.userId).select('email username').lean(),
      input.actorUserId
        ? User.findById(input.actorUserId).select('email username').lean()
        : Promise.resolve(null),
    ]);
    const label = (u: { email?: string; username?: string } | null): string | undefined => u?.email || u?.username;
    const content = renderEcosystemManagerChange({
      user: label(user) ?? input.userId,
      added: input.added,
      ...(label(actor) ? { actor: label(actor) } : {}),
    });
    await deliverEcosystemNotification({
      event: 'N23',
      recipients: [{ kind: 'superadmins' }, { kind: 'user', userId: input.userId, orgId: SYSTEM_ORG_ID }],
      ...content,
    });
  } catch (err) {
    logger.warn('Ecosystem Manager change notification failed', { userId: input.userId, error: errorMessage(err) });
  }
}
