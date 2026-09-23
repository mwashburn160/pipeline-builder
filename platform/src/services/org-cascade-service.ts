// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Org delete cascade + GDPR data export — HOW the teardown runs. WHAT it
 * covers is the registry in `org-cascade-registry.ts`.
 *
 * Orchestrates the destructive sweep across every store the platform owns data
 * in for a given org:
 * - Postgres (via pipeline-core): every org-scoped (`org_id`) table. Soft-deleted
 *   where `deleted_at` exists; hard-deleted otherwise.
 * - Mongo (platform's own): every collection in `MONGO_CASCADE_COLLECTIONS`
 *   (invitations, IdP config + group mappings, domains, join requests, SAML SLO
 *   sessions, service accounts + their keys) plus AuditEvent (the org's own hash
 *   chain, archived first). Memberships, Role assignments and Roles are removed
 *   later by `organizationService.delete` (the purge sweep) rather than here, but
 *   they are in the same registry so the EXPORT still captures them.
 * - Quota service: HTTP DELETE /quotas/:orgId.
 * - Billing service: HTTP DELETE /billing/subscriptions/by-org/:orgId.
 *
 * Export mirrors the cascade in read-only mode: walks the same set and
 * returns a single JSON blob the operator can hand to the org (right-to-
 * portability) before pulling the trigger.
 */

import { createLogger, createSafeClient, errorMessage, getServiceAuthHeader, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { runWithTenantContext, softDeleteRetentionMs, withTenantTx } from '@pipeline-builder/pipeline-data';
import { eq, sql } from 'drizzle-orm';
import type { Types } from 'mongoose';
import { auditService } from './audit-service.js';
import {
  CASCADE_MONGO_COLLECTION_NAMES,
  HARD_DELETE_TABLES,
  MONGO_CASCADE_COLLECTIONS,
  MONGO_REMOVABLE,
  SOFT_DELETE_TABLES,
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
import { publishUsersRevocation } from '../helpers/session-revocation.js';
import ArchivedAuditEvent from '../models/archived-audit-events.js';
import AuditEvent from '../models/audit-event.js';
import DeletedOrgSnapshot from '../models/deleted-org-snapshot.js';
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
// HTTP clients for downstream services
// ---------------------------------------------------------------------------

function quotaClient() {
  return createSafeClient({
    host: config.quota.serviceHost,
    port: config.quota.servicePort,
    timeout: config.organization.cascadeHttpTimeoutMs,
  });
}

function billingClient() {
  return createSafeClient({
    host: config.billing.serviceHost,
    port: config.billing.servicePort,
    timeout: config.organization.cascadeHttpTimeoutMs,
  });
}

function messageClient() {
  return createSafeClient({
    host: config.message.serviceHost,
    port: config.message.servicePort,
    timeout: config.organization.cascadeHttpTimeoutMs,
  });
}

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
  quota: { ok: boolean; statusCode?: number };
  billing: { ok: boolean; statusCode?: number };
  /** Result of purging the org's MinIO attachment blobs via the message service
   *  (platform holds no object-storage client, so the blobs — keyed `<orgId>/…`
   *  — would orphan otherwise). Best-effort: unlike quota/billing this is NOT a
   *  hard gate (an unreachable message service must not block the org delete),
   *  but a false `ok` signals leftover blobs for out-of-band reclamation. */
  messageBlobs: { ok: boolean; statusCode?: number; deleted?: number };
  /** Whether the org's audit trail was durably archived to
   *  `archived_audit_events` BEFORE the live rows were deleted. This is a HARD
   *  GATE for the purge sweep exactly like billing/quota — a failed archive
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
 * Soft- or hard-delete every row across the platform's own Postgres + Mongo
 * stores AND fire HTTP DELETEs at the quota / billing services. Returns a
 * report of what happened so the purge sweep can gate the hard delete on it and
 * summarize it in the `admin.org.delete` audit event.
 *
 * `actorOrgId` is the actor org for the tenant-context scope (the purge sweep
 * passes the system org) so the soft-delete UPDATEs pass FORCE'd RLS on the
 * affected tables. Sysadmins bypass RLS via the `is_sysadmin` GUC.
 */
export async function cascadeDeleteOrg(orgId: string, actorOrgId: string): Promise<CascadeReport> {
  if (orgId === SYSTEM_ORG_ID) {
    throw new Error(SYSTEM_ORG_DELETE_FORBIDDEN);
  }

  const report: CascadeReport = {
    postgres: await cascadePostgres(orgId, actorOrgId),
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
    quota: { ok: false },
    billing: { ok: false },
    messageBlobs: { ok: false },
    auditArchive: { ok: false },
  };

  await cascadeMongo(orgId, report);
  const audit = await archiveAndDeleteAuditEvents(orgId);
  report.auditArchive = audit.archive;
  report.mongo.auditEvents = audit.deleted;

  // NOTE: quota + billing `ok` are HARD GATES for the caller — the purge sweep
  // defers the org-doc hard delete when either is false (a live subscription
  // must never outlive its org). They are only recorded here so the cascade
  // returns a full report; the caller decides.
  report.quota = await deleteDownstream(quotaClient(), `/quotas/${encodeURIComponent(orgId)}`, orgId, 'Quota');
  // Cancels any active subscription and drops its events + dedupe keys.
  report.billing = await deleteDownstream(
    billingClient(), `/billing/subscriptions/by-org/${encodeURIComponent(orgId)}`, orgId, 'Billing',
  );
  // The org's MinIO attachment blobs: platform hard-deletes the
  // `message_attachments` rows but has no object-storage client, so the message
  // service reclaims the blobs. Best-effort and NOT a hard gate — an unreachable
  // message service must not block the org delete; a false `ok` flags leftover
  // blobs for the out-of-band orgId-prefix sweep.
  const blobs = await deleteDownstream(
    messageClient(), `/messages/internal/org/${encodeURIComponent(orgId)}/attachments`, orgId, 'Message attachment-blob purge',
  );
  report.messageBlobs = { ok: blobs.ok, statusCode: blobs.statusCode, ...(blobs.deleted === undefined ? {} : { deleted: blobs.deleted }) };

  const kms = await flagKmsOrphan(orgId, actorOrgId);
  if (kms) report.kms = kms;

  logger.info('Org cascade complete', { orgId, report });
  return report;
}

/**
 * Tombstone (soft tables) or remove (hard tables) every org-scoped Postgres row.
 *
 * Runs under a sysadmin tenant context so the soft-delete UPDATEs pass FORCE'd
 * RLS without a per-table USING clause for the deletor. Each statement goes
 * through `withTenantTx`, which is what applies that context to the connection
 * — a bare `db` call runs with empty RLS settings, and under the non-superuser
 * app role it silently matches 0 rows. One transaction per table so one
 * table's failure doesn't roll back the rest.
 */
async function cascadePostgres(orgId: string, actorOrgId: string): Promise<CascadeReport['postgres']> {
  const out: CascadeReport['postgres'] = {};
  await runWithTenantContext({ orgId: actorOrgId, isSuperAdmin: true }, async () => {
    const now = new Date();
    for (const { table, name } of SOFT_DELETE_TABLES) {
      try {
        // Only rows not already tombstoned, so the row count is accurate.
        //
        // This is the TERMINAL org purge (it runs only from the purge sweep once
        // the retention window has lapsed), so `purge_after = now` is stamped
        // ALONGSIDE `deleted_at`: the owning service's retention sweep is keyed
        // on `deleted_at IS NOT NULL AND purge_after < now`, and a NULL
        // `purge_after` would leave the org's rows in Postgres forever (a GDPR
        // erasure gap). The snapshot captured at soft-delete time remains the
        // recovery source and is untouched here.
        const result = await withTenantTx((tx) => tx.update(table)
          .set({ deletedAt: now, purgeAfter: now })
          .where(sql`${(table as { orgId: unknown }).orgId} = ${orgId} AND deleted_at IS NULL`));
        out[name] = { ok: true, rowCount: (result as { rowCount?: number }).rowCount ?? 0 };
      } catch (err) {
        logger.error('Postgres soft-delete failed', { table: name, orgId, error: errorMessage(err) });
        out[name] = { ok: false, error: errorMessage(err) };
      }
    }
    for (const { table, name } of HARD_DELETE_TABLES) {
      try {
        const result = await withTenantTx((tx) => tx.delete(table)
          .where(eq((table as { orgId: unknown }).orgId as never, orgId)));
        out[name] = { ok: true, rowCount: (result as { rowCount?: number }).rowCount ?? 0 };
      } catch (err) {
        logger.error('Postgres hard-delete failed', { table: name, orgId, error: errorMessage(err) });
        out[name] = { ok: false, error: errorMessage(err) };
      }
    }
  });
  return out;
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
 * FAIL CLOSED (like the billing/quota hard gates): if the archive write fails
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
      await ArchivedAuditEvent.bulkWrite(
        batch.map((e) => ({
          replaceOne: {
            filter: { _id: e._id },
            replacement: { ...e, archivedAt: new Date() },
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
 * HTTP DELETE `path` on a peer service with a platform service token. Never
 * throws: an unreachable service or a non-2xx answer is `ok: false`, and the
 * caller decides whether that gates the purge. `deleted` is the service's own
 * count when it reports one.
 */
async function deleteDownstream(
  client: ReturnType<typeof createSafeClient>,
  path: string,
  orgId: string,
  label: string,
): Promise<{ ok: boolean; statusCode?: number; deleted?: number }> {
  try {
    const auth = getServiceAuthHeader({ serviceName: 'platform', orgId: SYSTEM_ORG_ID, role: 'owner' });
    const resp = await client.delete(path, { headers: { 'Authorization': auth, 'x-org-id': orgId } });
    const ok = !!resp && resp.statusCode < 400;
    if (!ok) logger.warn(`${label} returned non-2xx`, { orgId, statusCode: resp?.statusCode });
    const deleted = (resp?.body as { data?: { deleted?: number } } | undefined)?.data?.deleted;
    return { ok, statusCode: resp?.statusCode, ...(typeof deleted === 'number' ? { deleted } : {}) };
  } catch (err) {
    logger.warn(`${label} delete failed`, { orgId, error: errorMessage(err) });
    return { ok: false };
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
  /** How many active members had their sessions invalidated (tokenVersion bump). */
  membersInvalidated: number;
}

/**
 * SOFT-delete an org: capture a durable recovery snapshot, tombstone the org
 * (`deletedAt`/`purgeAfter`), and invalidate every active member's session so
 * access is cut off immediately. Runs NO destructive cascade — the purge sweep
 * ({@link import('./org-purge.js').purgeExpiredOrgs}) does that once the
 * retention window lapses.
 *
 * Ordering is safety-critical:
 *   1. Export the org (`exportOrg`) + persist it to `deleted_org_snapshots`
 *      BEFORE anything else. If either fails we throw {@link ORG_SNAPSHOT_FAILED}
 *      and the org is NOT tombstoned — we never lose an org without a snapshot.
 *   2. In one transaction: set the tombstone AND bump `tokenVersion` (+ clear
 *      refresh tokens) for every active member, mirroring removeMember/
 *      deactivateMember. The tokenVersion bump makes outstanding access tokens
 *      fail `requireAuth`; the token chokepoint (`resolveMembership`) then
 *      refuses to re-issue a token scoped to the soft-deleted org.
 *
 * `actorOrgId` is the sysadmin's own org (for the export's RLS scope);
 * `deletedBy` is the sysadmin user id (stored on the snapshot).
 *
 * Throws SYSTEM_ORG_DELETE_FORBIDDEN / ORG_NOT_FOUND / ORG_ALREADY_DELETED /
 * ORG_SNAPSHOT_FAILED — the controller maps these to HTTP status.
 */
export async function softDeleteOrg(
  orgId: string,
  actorOrgId: string,
  deletedBy: string,
): Promise<SoftDeleteResult> {
  if (orgId === SYSTEM_ORG_ID) {
    throw new Error(SYSTEM_ORG_DELETE_FORBIDDEN);
  }

  const org = await Organization.findById(toOrgId(orgId)).select('name deletedAt').lean();
  if (!org) throw new Error(ORG_NOT_FOUND);
  if ((org as { deletedAt?: Date | null }).deletedAt) throw new Error(ORG_ALREADY_DELETED);

  // 1. Recovery snapshot FIRST — abort the whole soft-delete if we can't capture
  // + persist it. Losing an org without a snapshot is the one outcome we refuse.
  // STRICT export: any unreadable table or collection aborts, rather than
  // persisting a snapshot with silently empty stores.
  let snapshotId: string;
  try {
    const snapshot = await exportOrg(orgId, actorOrgId, { strict: true });
    const doc = await DeletedOrgSnapshot.create({
      organizationId: toOrgId(orgId),
      name: org.name,
      snapshot,
      deletedAt: new Date(),
      deletedBy,
    });
    snapshotId = String(doc._id);
  } catch (err) {
    logger.error('Org soft-delete ABORTED — recovery snapshot failed; org NOT tombstoned', {
      orgId, error: errorMessage(err),
    });
    throw new Error(ORG_SNAPSHOT_FAILED);
  }

  // 2. Tombstone + session cut-off, atomically.
  const now = new Date();
  const purgeAfter = new Date(now.getTime() + orgPurgeRetentionMs());

  let bumpedMemberIds: Types.ObjectId[] = [];
  const membersInvalidated = await withMongoTransaction(async (session) => {
    await Organization.updateOne(
      { _id: toOrgId(orgId) },
      { $set: { deletedAt: now, purgeAfter } },
    ).session(session);

    // Bump tokenVersion for every ACTIVE member (mirrors removeMember): their
    // outstanding access tokens are rejected on the next request, and clearing
    // the refresh-session slots blocks a silent re-issue.
    const memberships = await UserOrganization.find({ organizationId: toOrgId(orgId), isActive: true })
      .select('userId').session(session).lean();
    // Plus anyone working in the org on INHERITED authority (a parent-org admin
    // who opened this team — no membership row, see helpers/org-authority.ts):
    // their session is pinned by `lastActiveOrgId`, and must be cut just the same.
    const inheritedSessions = await User.find({ lastActiveOrgId: String(orgId) })
      .select('_id').session(session).lean();
    const byId = new Map<string, Types.ObjectId>();
    for (const m of memberships) byId.set(String(m.userId), m.userId);
    for (const u of inheritedSessions) byId.set(String(u._id), u._id as Types.ObjectId);
    bumpedMemberIds = [...byId.values()];
    if (bumpedMemberIds.length > 0) {
      await User.updateMany(
        { _id: { $in: bumpedMemberIds } },
        { $inc: { tokenVersion: 1 }, $set: { refreshSessions: [] } },
      ).session(session);

      // Revoke every member's PAT scoped to THIS org. A PAT's authority is
      // decoupled from tokenVersion (a session logout must not kill a durable CI
      // credential), so the tokenVersion bump above does NOT reach it — an
      // automation PAT would otherwise keep read+write on the tombstoned org
      // until purge. Scope the revoke to `organizationId === orgId` so a member's
      // PATs for OTHER (still-live) orgs are untouched. requireAuth also read-
      // guards this on `org.deletedAt`, so the two together fail closed.
      await PersonalAccessToken.updateMany(
        { userId: { $in: bumpedMemberIds }, organizationId: orgId, revoked: false },
        { $set: { revoked: true, revokedAt: now } },
      ).session(session);
    }
    return bumpedMemberIds.length;
  });
  // Post-commit: publish each member's now-current tokenVersion so the stateless
  // services cut them off from the tombstoned org immediately (best-effort).
  await publishUsersRevocation(bumpedMemberIds);

  // Service-account keys, for the same reason member PATs are revoked above: an
  // account has no session and no `tokenVersion`, so the bump doesn't reach it,
  // and its automation would otherwise keep writing to a tombstoned org for the
  // whole retention window. Revoked (not deleted) — a restore within the window
  // leaves the accounts and their Roles intact, and the operator reissues keys.
  // Best-effort: a failure here leaves the exchange's own live-org check as the
  // backstop (it refuses a soft-deleted org), so it must not abort the delete.
  let serviceAccountKeysRevoked = 0;
  try {
    serviceAccountKeysRevoked = await revokeServiceAccountKeysForOrg(orgId);
  } catch (err) {
    logger.warn('Service-account key revoke on soft-delete failed (exchange still refuses the tombstoned org)', {
      orgId, error: errorMessage(err),
    });
  }

  logger.info('Org soft-deleted', { orgId, purgeAfter, snapshotId, membersInvalidated, serviceAccountKeysRevoked });
  return { orgId, deletedAt: now, purgeAfter, snapshotId, membersInvalidated };
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
    for (const { table, name } of [...SOFT_DELETE_TABLES, ...HARD_DELETE_TABLES]) {
      try {
        const rows = await withTenantTx((tx) => tx.select().from(table)
          .where(eq((table as { orgId: unknown }).orgId as never, orgId)));
        result.postgres[name] = rows as unknown[];
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
