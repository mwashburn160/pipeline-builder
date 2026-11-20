// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Org delete cascade + GDPR data export — HOW the teardown runs. WHAT it
 * covers is the registry in `org-cascade-registry.ts`.
 *
 * Orchestrates the destructive sweep across every store the platform ITSELF
 * owns data in for a given org:
 * - Postgres: platform's own org-scoped tables only (dashboards, alert routing,
 *   support contacts — the `platform` slice of pipeline-data's
 *   `ORG_DATA_OWNERSHIP`). Soft-deleted where `deleted_at` exists; hard-deleted
 *   otherwise.
 * - Mongo (platform's own): every collection in `MONGO_CASCADE_COLLECTIONS`
 *   (invitations, IdP config + group mappings, domains, join requests, SAML SLO
 *   sessions, service accounts + their keys) plus AuditEvent (the org's own hash
 *   chain, archived first). Memberships, Role assignments and Roles are removed
 *   later by `organizationService.delete` (the purge sweep) rather than here, but
 *   they are in the same registry so the EXPORT still captures them.
 *
 * Everything ELSE — other services' Postgres tables, quota, billing, message
 * blobs, the registry namespace — is NOT torn down here. The purge sweep
 * enqueues one durable outbox leg per owning service in the same transaction
 * as the org's hard delete (`services/cascade-outbox.ts`), and each service
 * deletes its own data on delivery, with retry, backoff and a dead-letter alert.
 *
 * Export mirrors the cascade in read-only mode across EVERY org-scoped table
 * (whoever owns it) and returns a single JSON blob the operator can hand to the
 * org (right-to-portability) before pulling the trigger.
 */

import { isSystemOrgId, createLogger, errorMessage } from '@pipeline-builder/api-core';
import { purgeOrgData, redactSecretColumns, runWithTenantContext, softDeleteRetentionMs, withTenantTx } from '@pipeline-builder/pipeline-data';
import { eq } from 'drizzle-orm';
import type { ClientSession, Types } from 'mongoose';
import { auditService } from './audit-service.js';
import { discardDeletedOrgSnapshot, storeDeletedOrgSnapshot } from './deleted-org-snapshot-store.js';
import {
  CASCADE_MONGO_COLLECTION_NAMES,
  EXPORT_TABLES,
  MONGO_CASCADE_COLLECTIONS,
  MONGO_REMOVABLE,
  type CascadeRemovedName,
} from './org-cascade-registry.js';
import {
  SYSTEM_ORG_DELETE_FORBIDDEN,
  ORG_NOT_FOUND,
  ORG_ALREADY_DELETED,
  ORG_SNAPSHOT_FAILED,
} from './org-errors.js';
import { deleteServiceAccountsForOrg, revokeServiceAccountKeysForOrg } from './service-account-cascade.js';
import { config } from '../config/index.js';
import { toOrgId } from '../helpers/org-id.js';
import { publishAccessKeyRevocation, publishUsersRevocation } from '../helpers/session-revocation.js';
import ArchivedAuditEvent from '../models/archived-audit-events.js';
import AuditEvent from '../models/audit-event.js';
import Organization from '../models/organization.js';
import PersonalAccessToken from '../models/personal-access-token.js';
import UserOrganization from '../models/user-organization.js';
import User from '../models/user.js';
import { withMongoTransaction } from '../utils/mongo-tx.js';

const logger = createLogger('org-cascade');

/**
 * How many audit events the purge archives per `bulkWrite`. Bounds peak memory
 * so a tenant at the retention ceiling can't OOM the pod mid-purge — which,
 * because the archive is fail-closed, would make the next sweep retry the same
 * org and fail identically, stalling the purge forever.
 */
const AUDIT_ARCHIVE_BATCH_SIZE = 1000;

/**
 * Max audit events an {@link exportOrg} artifact carries. Unlike the archive,
 * the export materializes into a single JSON object, so it takes a hard cap and
 * reports truncation instead of streaming. Newest-first, so a truncated export
 * keeps the most recent (most forensically useful) window.
 */
const AUDIT_EXPORT_CAP = 50_000;

// ---------------------------------------------------------------------------
// Cascade
// ---------------------------------------------------------------------------

/** Per-store row counts after cascade  handy for the audit event detail.
 *  Postgres entries carry an `ok` flag + either a row count or an error
 *  message so audit consumers can distinguish "deleted 0 rows" from
 *  "delete failed" — the prior `-1` sentinel conflated the two. */
export interface CascadeReport {
  postgres: Record<string, { ok: boolean; rowCount?: number; error?: string }>;
  /** Rows removed per collection (see {@link CascadeRemovedName}). */
  mongo: Record<CascadeRemovedName, number>;
  /** Mongo legs that FAILED (collection names). Non-empty ⇒ the purge sweep
   *  defers the hard delete, exactly like a failed Postgres table: tearing down
   *  the org doc while its rows remain would orphan them forever (nothing keys
   *  a retry off a missing org). */
  mongoFailures: string[];
  /** Whether the org's audit trail was durably archived to
   *  `archived_audit_events` BEFORE the live rows were deleted. This is a HARD
   *  GATE for the purge sweep exactly like a failed table — a failed archive
   *  leaves the audit rows intact and DEFERS the hard delete, so a forensic
   *  record is never destroyed without a durable copy. `archived` is how many
   *  events were copied. */
  auditArchive: { ok: boolean; archived?: number; error?: string };
  /** Present ONLY when the deleted org had a per-org KMS CMK (`kmsConfig`).
   *  The cascade does NOT auto-delete the external AWS key (irreversible) —
   *  it flags the orphan so an operator can schedule the key's deletion
   *  manually. `keyRef` carries the key identifier (undefined if the config
   *  stored only a wrapped master with no keyId). */
  kms?: { flagged: true; keyRef?: string };
}

/**
 * Soft- or hard-delete every row across the platform's OWN Postgres + Mongo
 * stores. Returns a report of what happened so the purge sweep can gate the
 * hard delete on it and summarize it in the `admin.org.delete` audit event.
 * The downstream services are reached by the cascade outbox, not from here.
 *
 * `actorOrgId` is the actor org for the KMS-orphan audit row; the Postgres
 * purge runs under a sysadmin tenant context (FORCE'd RLS).
 */
export async function cascadeDeleteOrg(orgId: string, actorOrgId: string): Promise<CascadeReport> {
  if (isSystemOrgId(orgId)) {
    throw new Error(SYSTEM_ORG_DELETE_FORBIDDEN);
  }

  const report: CascadeReport = {
    postgres: await cascadePostgres(orgId),
    mongo: {
      invitations: 0,
      auditEvents: 0,
      idpConfigs: 0,
      idpGroupMappings: 0,
      orgDomains: 0,
      joinRequests: 0,
      samlSessions: 0,
      personalAccessTokens: 0,
      mfaResetRequests: 0,
      impersonationRequests: 0,
      serviceAccounts: 0,
      serviceAccountKeys: 0,
    },
    mongoFailures: [],
    auditArchive: { ok: false },
  };

  await cascadeMongo(orgId, report);
  const audit = await archiveAndDeleteAuditEvents(orgId);
  report.auditArchive = audit.archive;
  report.mongo.auditEvents = audit.deleted;

  const kms = await flagKmsOrphan(orgId, actorOrgId);
  if (kms) report.kms = kms;

  logger.info('Org cascade complete', { orgId, report });
  return report;
}

/**
 * Tombstone (soft tables) or remove (hard tables) platform's OWN org-scoped
 * Postgres rows — pipeline-data's `purgeOrgData('platform', …)`, the same
 * executor every owning service runs for its own slice. Sysadmin tenant context,
 * one transaction per table so one table's failure doesn't roll back the rest.
 */
async function cascadePostgres(orgId: string): Promise<CascadeReport['postgres']> {
  const result = await purgeOrgData('platform', orgId);
  for (const name of result.failed) {
    logger.error('Postgres teardown failed', { table: name, orgId, error: result.tables[name]?.error });
  }
  return result.tables;
}

/**
 * Remove the org's rows from every collection in `MONGO_CASCADE_COLLECTIONS`
 * that owns its delete, then the service-account leg. Each collection is
 * isolated so one failure doesn't skip the rest; failures are named in
 * `report.mongoFailures`.
 *
 * Why these must go: an orphaned IdP config or group mapping would be silently
 * inherited by a future org reusing this id (and the mappings name Roles that
 * are about to be deleted); `domain` is globally UNIQUE, so a lingering row
 * would permanently block any future org — a re-signup of the same company
 * included — from registering it. The org OWNS its service accounts, and a
 * `pb_sa_…` key outliving its org would be a credential with no tenant to
 * authorize against.
 */
async function cascadeMongo(orgId: string, report: CascadeReport): Promise<void> {
  for (const collection of MONGO_REMOVABLE) {
    try {
      report.mongo[collection.name] = await collection.remove(orgId);
    } catch (err) {
      logger.error('Mongo cleanup failed', { collection: collection.name, orgId, error: errorMessage(err) });
      report.mongoFailures.push(collection.name);
    }
  }

  try {
    const sa = await deleteServiceAccountsForOrg(orgId);
    report.mongo.serviceAccounts = sa.accounts;
    report.mongo.serviceAccountKeys = sa.keys;
  } catch (err) {
    logger.error('Service-account cleanup failed', { orgId, error: errorMessage(err) });
    report.mongoFailures.push('serviceAccounts');
  }
}

/**
 * ARCHIVE the org's audit trail to a durable, TTL-free store, THEN delete the
 * live rows of its own hash chain.
 *
 * FAIL CLOSED (like a failed Postgres table or Mongo leg): if the archive write fails
 * the audit rows are NOT deleted — they stay for a retry, `archive.ok` is false,
 * and the purge sweep defers the hard delete. A forensic record is never
 * destroyed without a durable copy.
 *
 * The ARCHIVE covers every event touching the org — its own chain plus the
 * events its members performed on OTHER orgs (`orgId` = this org). The live
 * DELETE covers only this org's own chain (`affectedOrgId` = this org, the
 * chain key — see helpers/audit-chain.ts): an event whose `affectedOrgId` is
 * another org is a link in THAT org's chain, and deleting it would break that
 * tenant's tamper-evidence. The `admin.org.delete` event for this purge is
 * written by the purge sweep after the cascade returns, so it is not at risk.
 *
 * STREAMED in fixed batches, never materialized: a tenant at the retention
 * ceiling has millions of events, and one bulkWrite built from the whole trail
 * would OOM the pod — which, the archive being fail-closed, the next sweep
 * would repeat for the same org forever.
 */
/**
 * When an archived event expires: the moment the LIVE row would have — its
 * `createdAt` plus the audit retention — so the purge preserves an event for
 * the rest of its retention, never past it (the privacy policy's "audit logs
 * are kept for 90 days"). An event with no readable `createdAt` gets the full
 * window from the archive time.
 */
export function archivedAuditExpiry(event: { createdAt?: unknown }, archivedAt: Date): Date {
  const created = event.createdAt instanceof Date ? event.createdAt : new Date(String(event.createdAt ?? ''));
  const base = Number.isNaN(created.getTime()) ? archivedAt : created;
  return new Date(base.getTime() + config.audit.retentionDays * 86_400_000);
}

async function archiveAndDeleteAuditEvents(
  orgId: string,
): Promise<{ archive: CascadeReport['auditArchive']; deleted: number }> {
  try {
    let archived = 0;
    let batch: Array<Record<string, unknown>> = [];
    // Each event keeps its original `_id`, so re-archiving on a purge retry is
    // an idempotent upsert (no duplicates); the document is kept verbatim plus
    // an `archivedAt` stamp.
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const archivedAt = new Date();
      await ArchivedAuditEvent.bulkWrite(
        batch.map((e) => ({
          replaceOne: {
            filter: { _id: e._id },
            replacement: { ...e, archivedAt, expiresAt: archivedAuditExpiry(e, archivedAt) },
            upsert: true,
          },
        })),
        { ordered: false },
      );
      archived += batch.length;
      batch = [];
    };

    const cursor = AuditEvent.find({ $or: [{ orgId }, { affectedOrgId: orgId }] })
      .lean().cursor({ batchSize: AUDIT_ARCHIVE_BATCH_SIZE });
    try {
      for await (const leanDoc of cursor) {
        batch.push({ ...leanDoc });
        if (batch.length >= AUDIT_ARCHIVE_BATCH_SIZE) await flush();
      }
      await flush();
    } finally {
      await cursor.close();
    }

    const auditRes = await AuditEvent.deleteMany({ affectedOrgId: orgId });
    return { archive: { ok: true, archived }, deleted: auditRes.deletedCount ?? 0 };
  } catch (err) {
    logger.error(
      'Audit-event archive FAILED — live audit rows NOT deleted; purge will be deferred for this org (fail-closed)',
      { orgId, error: errorMessage(err) },
    );
    return { archive: { ok: false, error: errorMessage(err) }, deleted: 0 };
  }
}

/**
 * Flag a per-org KMS CMK (`kmsConfig`) the deleted org leaves behind.
 *
 * Deleting a CMK is IRREVERSIBLE (anything still wrapped under it becomes
 * unrecoverable), so the cascade never schedules it. Instead it emits an
 * operator-actionable signal — a WARN log and an `org.kms.orphaned` audit event
 * carrying the key identifier — so an operator can schedule the external key's
 * deletion by hand. Best-effort: the org's data is already gone, so a lookup or
 * audit failure is logged, never thrown.
 */
async function flagKmsOrphan(orgId: string, actorOrgId: string): Promise<CascadeReport['kms']> {
  try {
    const org = await Organization.findById(orgId).select('kmsConfig').lean();
    const kmsConfig = org?.kmsConfig;
    if (!kmsConfig || !(kmsConfig.keyId || kmsConfig.ciphertextBase64)) return undefined;
    const keyRef = kmsConfig.keyId;
    logger.warn(
      'Deleted org had a per-org KMS CMK — NOT auto-deleted (irreversible). Operator must schedule the external AWS key deletion manually.',
      { orgId, keyRef },
    );
    try {
      // Through the shared appender so the row is hash-CHAINED — a raw
      // `AuditEvent.create` would be an unchained row that fails chain verify.
      await auditService.createEvent({
        action: 'org.kms.orphaned',
        actorId: 'org-cascade',
        orgId: actorOrgId,
        affectedOrgId: orgId,
        targetType: 'organization',
        targetId: orgId,
        outcome: 'success',
        details: {
          keyId: keyRef,
          reason: 'per-org KMS CMK requires manual deletion — cascade does not auto-delete (irreversible)',
        },
      });
    } catch (auditErr) {
      logger.error('Failed to record org.kms.orphaned audit event', { orgId, keyRef, error: errorMessage(auditErr) });
    }
    return { flagged: true, keyRef };
  } catch (err) {
    logger.warn('Per-org KMS lookup failed during cascade', { orgId, error: errorMessage(err) });
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Soft-delete (grace window + auto-export)
// ---------------------------------------------------------------------------

/**
 * How long a soft-deleted ORG waits before the purge sweep may destroy it.
 *
 * `ORG_DELETION_RETENTION_DAYS` (7d) is the intent, but it can never be SHORTER
 * than the row-level soft-delete window `SOFT_DELETE_RETENTION_DAYS` (30d) that
 * the same cascade stamps onto every Postgres row it tombstones. When it was,
 * the org document and its quota/billing records were destroyed on day 7 while
 * the rows they own sat tombstoned until day 30 — 23 days of rows belonging to
 * an org that no longer exists, invisible to any product surface and missed by
 * a restore that no longer had an org to restore into. Taking the MAX of the
 * two keeps the org alive at least as long as anything it owns; raising
 * `ORG_DELETION_RETENTION_DAYS` above the row window still works as written.
 */
export function orgPurgeRetentionMs(): number {
  return Math.max(config.organization.deletionRetentionDays * 86400 * 1000, softDeleteRetentionMs());
}

/** Result of a successful {@link softDeleteOrg}. */
export interface SoftDeleteResult {
  orgId: string;
  deletedAt: Date;
  /** When the purge sweep may run the destructive cascade. Until then the org
   *  can be restored. */
  purgeAfter: Date;
  /** Id of the durable recovery snapshot persisted before the tombstone. */
  snapshotId: string;
  /** How many people had their access to the org ended (claimsVersion bump). */
  membersInvalidated: number;
}

/** One org {@link softDeleteOrgsTogether} is to tombstone. */
export interface SoftDeleteTarget {
  orgId: string;
  /** The org whose RLS scope the snapshot export reads with. */
  actorOrgId: string;
}

/**
 * SOFT-delete an org: capture a durable recovery snapshot, tombstone the org
 * (`deletedAt`/`purgeAfter`), and end every member's access to it so it is cut
 * off immediately. Runs NO destructive cascade — the purge sweep
 * ({@link import('./org-purge.js').purgeExpiredOrgs}) does that once the
 * retention window lapses.
 *
 * `actorOrgId` is the sysadmin's own org (for the export's RLS scope);
 * `deletedBy` is the sysadmin user id (stored on the snapshot). See
 * {@link softDeleteOrgsTogether} for the ordering and what "access ends" means.
 *
 * Throws SYSTEM_ORG_DELETE_FORBIDDEN / ORG_NOT_FOUND / ORG_ALREADY_DELETED /
 * ORG_SNAPSHOT_FAILED — the controller maps these to HTTP status.
 */
export async function softDeleteOrg(
  orgId: string,
  actorOrgId: string,
  deletedBy: string,
): Promise<SoftDeleteResult> {
  const { results } = await softDeleteOrgsTogether([{ orgId, actorOrgId }], deletedBy);
  return results[0];
}

/**
 * Soft-delete several orgs AND run `alsoInTransaction` in ONE transaction — so a
 * caller whose own write must not happen without the tombstones (account
 * self-delete: the account goes only if its sole-owned orgs go) gets all of it
 * or none of it.
 *
 * Ordering is safety-critical:
 *   1. Every org's recovery snapshot is captured and persisted FIRST (strict
 *      export). If any fails we throw {@link ORG_SNAPSHOT_FAILED} and NOTHING is
 *      tombstoned — we never lose an org without a snapshot. The snapshots
 *      already written are discarded.
 *   2. One transaction: each org's tombstone — conditional on the org NOT being
 *      deleted already, so a racing repeat delete cannot reset `purgeAfter`
 *      (the loser is ORG_ALREADY_DELETED) — plus ending every member's access
 *      to it, plus `alsoInTransaction`. If any of it fails, the snapshots are
 *      discarded and nothing is left half-done.
 *   3. Post-commit (best-effort): revocation publishes and the org's
 *      service-account keys.
 *
 * ENDING ACCESS is a CLAIMS bump, never a sign-out (mirrors removeMember /
 * deactivateMember). A member's sessions are theirs and span every org they
 * belong to; deleting one org or team must not sign them out of the others.
 * The bump makes every outstanding access token fail `requireAuth` at once;
 * the token chokepoint (`resolveOrgMembership`) then refuses to re-issue one
 * scoped to the soft-deleted org, so the next refresh lands in an org they are
 * still in. Their pin on it (`lastActiveOrgId`) is dropped so a new sign-in
 * never aims there. Their PATs SCOPED TO THIS ORG are revoked: a PAT's
 * authority is decoupled from the version bump.
 */
export async function softDeleteOrgsTogether<T = undefined>(
  targets: readonly SoftDeleteTarget[],
  deletedBy: string,
  alsoInTransaction?: (session: ClientSession) => Promise<T>,
): Promise<{ results: SoftDeleteResult[]; extra: T | undefined }> {
  const now = new Date();
  const purgeAfter = new Date(now.getTime() + orgPurgeRetentionMs());

  // 1. Recovery snapshots FIRST.
  const captured: Array<SoftDeleteTarget & { snapshotId: string }> = [];
  try {
    for (const target of targets) {
      captured.push({ ...target, snapshotId: await captureRecoverySnapshot(target, deletedBy, now, purgeAfter) });
    }
  } catch (err) {
    await discardSnapshots(captured.map((c) => c.snapshotId));
    throw err;
  }

  // 2. Tombstones + access cut-off (+ the caller's write), atomically.
  let tombstoned: Array<{ orgId: string; memberIds: Types.ObjectId[]; revokedPatIds: string[] }> = [];
  let extra: T | undefined;
  try {
    await withMongoTransaction(async (session) => {
      // Reassigned per attempt: a retried body re-reads the (rolled-back) rows.
      tombstoned = [];
      for (const { orgId } of captured) {
        tombstoned.push({ orgId, ...await tombstoneOrg(orgId, now, purgeAfter, session) });
      }
      extra = alsoInTransaction ? await alsoInTransaction(session) : undefined;
    });
  } catch (err) {
    await discardSnapshots(captured.map((c) => c.snapshotId));
    throw err;
  }

  // 3. Post-commit.
  for (const { orgId, memberIds, revokedPatIds } of tombstoned) {
    await afterTombstone(orgId, memberIds, revokedPatIds);
  }
  const results = captured.map(({ orgId, snapshotId }, i) => {
    const membersInvalidated = tombstoned[i].memberIds.length;
    logger.info('Org soft-deleted', { orgId, purgeAfter, snapshotId, membersInvalidated });
    return { orgId, deletedAt: now, purgeAfter, snapshotId, membersInvalidated };
  });
  return { results, extra };
}

/**
 * Check the org may be soft-deleted and persist its recovery snapshot (STRICT
 * export: any unreadable table or collection aborts, rather than persisting a
 * snapshot with silently empty stores). The snapshot is a copy of deleted data,
 * so it expires when the org is due to be purged (the TTL index on its header
 * and chunks) — see the model.
 */
async function captureRecoverySnapshot(
  { orgId, actorOrgId }: SoftDeleteTarget,
  deletedBy: string,
  deletedAt: Date,
  purgeAfter: Date,
): Promise<string> {
  if (isSystemOrgId(orgId)) throw new Error(SYSTEM_ORG_DELETE_FORBIDDEN);
  const org = await Organization.findById(toOrgId(orgId)).select('name deletedAt').lean();
  if (!org) throw new Error(ORG_NOT_FOUND);
  if ((org as { deletedAt?: Date | null }).deletedAt) throw new Error(ORG_ALREADY_DELETED);
  try {
    const snapshot = await exportOrg(orgId, actorOrgId, { strict: true });
    return await storeDeletedOrgSnapshot({
      organizationId: String(orgId),
      name: org.name,
      snapshot,
      deletedAt,
      deletedBy,
      expiresAt: purgeAfter,
    });
  } catch (err) {
    logger.error('Org soft-delete ABORTED — recovery snapshot failed; org NOT tombstoned', {
      orgId, error: errorMessage(err),
    });
    throw new Error(ORG_SNAPSHOT_FAILED);
  }
}

/** Best-effort removal of snapshots whose soft-delete did not commit (the TTL
 *  index removes any this misses). */
async function discardSnapshots(snapshotIds: readonly string[]): Promise<void> {
  for (const id of snapshotIds) {
    await discardDeletedOrgSnapshot(id).catch((err: unknown) => logger.warn(
      'Could not discard the snapshot of an aborted soft-delete (its TTL will)', { snapshotId: id, error: errorMessage(err) },
    ));
  }
}

/**
 * Inside the caller's transaction: tombstone ONE org — conditionally, so a
 * repeat delete cannot reset `purgeAfter` (ORG_ALREADY_DELETED) — and end the
 * access of everyone in it (see {@link softDeleteOrgsTogether}).
 */
async function tombstoneOrg(
  orgId: string,
  deletedAt: Date,
  purgeAfter: Date,
  session: ClientSession,
): Promise<{ memberIds: Types.ObjectId[]; revokedPatIds: string[] }> {
  const tomb = await Organization.updateOne(
    { _id: toOrgId(orgId), deletedAt: null },
    { $set: { deletedAt, purgeAfter } },
  ).session(session);
  if (tomb.matchedCount === 0) throw new Error(ORG_ALREADY_DELETED);

  // Every ACTIVE member, plus anyone working in the org on INHERITED authority
  // (a parent-org admin who opened this team — no membership row, see
  // helpers/org-authority.ts), whose session is pinned by `lastActiveOrgId`.
  const memberships = await UserOrganization.find({ organizationId: toOrgId(orgId), isActive: true })
    .select('userId').session(session).lean();
  const inheritedSessions = await User.find({ lastActiveOrgId: String(orgId) })
    .select('_id').session(session).lean();
  const byId = new Map<string, Types.ObjectId>();
  for (const mem of memberships) byId.set(String(mem.userId), mem.userId);
  for (const u of inheritedSessions) byId.set(String(u._id), u._id as Types.ObjectId);
  const memberIds = [...byId.values()];
  if (memberIds.length === 0) return { memberIds, revokedPatIds: [] };

  // A CLAIMS bump: outstanding access tokens are refused now; sessions survive
  // and re-mint into a live org. The pin on the dead org is dropped.
  await User.updateMany({ _id: { $in: memberIds } }, { $inc: { claimsVersion: 1 } }).session(session);
  await User.updateMany(
    { _id: { $in: memberIds }, lastActiveOrgId: String(orgId) },
    { $unset: { lastActiveOrgId: '' } },
  ).session(session);

  // Revoke every member's PAT scoped to THIS org. A PAT's authority is
  // decoupled from the version bump (a durable CI credential outlives a
  // session), so the bump does NOT reach it — an automation PAT would otherwise
  // keep read+write on the tombstoned org until purge. Scoped by
  // `organizationId` so a member's PATs for OTHER (still-live) orgs are untouched.
  const patFilter = { userId: { $in: memberIds }, organizationId: orgId, revoked: false };
  const revokedPatIds = (await PersonalAccessToken.find(patFilter).select('_id').session(session).lean())
    .map((k) => String(k._id));
  await PersonalAccessToken.updateMany(
    patFilter,
    { $set: { revoked: true, revokedAt: deletedAt } },
  ).session(session);
  return { memberIds, revokedPatIds };
}

/** Post-commit, best-effort: make one tombstone's cut-off true everywhere. */
async function afterTombstone(orgId: string, memberIds: Types.ObjectId[], revokedPatIds: string[]): Promise<void> {
  // Each member's now-current access version, so the stateless services cut
  // them off from the tombstoned org immediately — and each revoked PAT, whose
  // exchanged tokens the version bump doesn't reach.
  await publishUsersRevocation(memberIds);
  await publishAccessKeyRevocation(revokedPatIds);

  // Service-account keys, for the same reason member PATs are revoked: an
  // account has no session and no access version, so the bump doesn't reach it,
  // and its automation would otherwise keep writing to a tombstoned org for the
  // whole retention window. Revoked (not deleted) — a restore within the window
  // leaves the accounts and their Roles intact, and the operator reissues keys.
  // Best-effort: a failure here leaves the exchange's own live-org check as the
  // backstop (it refuses a soft-deleted org), so it must not abort the delete.
  try {
    const revoked = await revokeServiceAccountKeysForOrg(orgId);
    if (revoked > 0) logger.info('Revoked the soft-deleted org\'s service-account keys', { orgId, revoked });
  } catch (err) {
    logger.warn('Service-account key revoke on soft-delete failed (exchange still refuses the tombstoned org)', {
      orgId, error: errorMessage(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Export (read-only mirror of the cascade)
// ---------------------------------------------------------------------------

/** Single-blob JSON dump of every store's contents for the given org. */
export interface OrgExport {
  exportedAt: string;
  orgId: string;
  postgres: Record<string, unknown[]>;
  /** One entry per {@link CASCADE_MONGO_COLLECTION_NAMES} member — always
   *  present (an empty array means the org had no rows), so a consumer can tell
   *  "nothing to restore" from "never captured". */
  mongo: Record<string, unknown[]>;
  /** Set when a collection hit its export cap, so the caller can tell a
   *  complete artifact from a partial one. Absent means nothing was capped. */
  truncated?: { auditEvents: { cap: number } };
  /** Stores that could not be read (lenient mode only). Their entries above are
   *  empty because the read FAILED, not because the org has no rows. Absent
   *  means every store was read. */
  failed?: { postgres?: string[]; mongo?: string[] };
}

export interface ExportOrgOptions {
  /** Rethrow the first read failure instead of recording it in `failed`. The
   *  soft-delete recovery snapshot uses this: a snapshot with a silently empty
   *  store is not a recovery snapshot. */
  strict?: boolean;
}

/**
 * Walk every store the cascade touches and emit a single JSON blob. Read-
 * only — does not mutate. The returned object is intended for handing to
 * the org as a portability artifact before the delete.
 *
 * Lenient by default: a store that fails to read is left empty and named in
 * `failed`, so the portability export still returns what it can. `strict`
 * rethrows instead (see {@link ExportOrgOptions}).
 *
 * `actorOrgId` is needed for the same RLS reason as `cascadeDeleteOrg` —
 * the SELECTs must run with a sysadmin context to read rows owned by an
 * org that isn't the caller's own.
 */
export async function exportOrg(
  orgId: string,
  actorOrgId: string,
  { strict = false }: ExportOrgOptions = {},
): Promise<OrgExport> {
  const result: OrgExport = {
    exportedAt: new Date().toISOString(),
    orgId,
    postgres: {},
    // Seeded with every covered collection so a read failure in lenient mode
    // leaves an EMPTY array + a `failed` entry, never a missing key.
    mongo: Object.fromEntries([...CASCADE_MONGO_COLLECTION_NAMES].map((name) => [name, [] as unknown[]])),
  };
  const recordFailure = (store: 'postgres' | 'mongo', name: string, err: unknown): void => {
    if (strict) throw err;
    logger.warn('Export read failed', { store, name, orgId, error: errorMessage(err) });
    result.failed ??= {};
    (result.failed[store] ??= []).push(name);
  };

  await runWithTenantContext({ orgId: actorOrgId, isSuperAdmin: true }, async () => {
    for (const scoped of EXPORT_TABLES) {
      const { table, name } = scoped;
      try {
        const rows = await withTenantTx((tx) => tx.select().from(table)
          .where(eq((table as unknown as { orgId: unknown }).orgId as never, orgId)));
        // A table's secret columns (a runner signing key's `private_key_enc`)
        // never leave in an export, encrypted or not.
        result.postgres[name] = (rows as Record<string, unknown>[]).map((row) => redactSecretColumns(scoped, row));
      } catch (err) {
        result.postgres[name] = [];
        recordFailure('postgres', name, err);
      }
    }
  });

  // Every Mongo collection the teardown removes — the SAME table the cascade
  // deletes from, so the snapshot cannot silently omit one.
  for (const collection of MONGO_CASCADE_COLLECTIONS) {
    try {
      result.mongo[collection.name] = await collection.read(orgId);
    } catch (err) {
      result.mongo[collection.name] = [];
      recordFailure('mongo', collection.name, err);
    }
  }

  try {
    // CAPPED: the export materializes into one JSON object, so an uncapped
    // read of a retention-ceiling tenant's whole trail is a heap-exhaustion
    // risk on a single request. Truncation is reported rather than silent —
    // a portability artifact that quietly dropped records would be worse than
    // one that says it is partial.
    result.mongo.auditEvents = await AuditEvent.find({
      $or: [{ orgId }, { affectedOrgId: orgId }],
    })
      .sort({ createdAt: -1, _id: -1 })
      .limit(AUDIT_EXPORT_CAP)
      .lean();
    if (result.mongo.auditEvents.length === AUDIT_EXPORT_CAP) {
      result.truncated = { auditEvents: { cap: AUDIT_EXPORT_CAP } };
      logger.warn('AuditEvent export hit its cap — artifact is partial', { orgId, cap: AUDIT_EXPORT_CAP });
    }
  } catch (err) {
    recordFailure('mongo', 'auditEvents', err);
  }

  return result;
}
