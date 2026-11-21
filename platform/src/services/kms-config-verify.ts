// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Post-change verification of an org's secrets after a per-org KMS config
 * change — closing the old-key window.
 *
 * WHY: a KMS config change (controllers/org-kms-config.ts) re-encrypts every
 * captured secret and evicts the per-org key cache on every replica over the
 * cache-invalidation bus. A replica the broadcast misses keeps the OUTGOING key
 * until api-core's PER_ORG_KMS_CACHE_TTL_MS lapses, and any secret it writes in
 * that window is wrapped under a key the org's current config cannot open. The
 * change's own pass catches the writes that race it (`unreadableConcurrentWrites`);
 * nothing caught the ones that land after it, until this.
 *
 * HOW: the change's conditional save stamps `Organization.kmsVerifyDueAt` =
 * now + TTL + margin in the SAME write (helpers/org-kms-config.ts `kmsVerifySchedule`), so the check
 * is durable across restarts and a second change before it runs simply moves
 * the marker (supersedes it). This sweep picks up due markers and, per org:
 *
 *   1. CLAIMS it: a conditional update on the exact due value replaces it with
 *      a short lease. Losing the claim (another replica, or a newer change)
 *      skips the org. A crash mid-check leaves the lease, which comes due again.
 *   2. Probes the provider with a throwaway encrypt. A provider that cannot
 *      derive the org's key at all (KMS outage, revoked grant) is a fault, not
 *      "every secret is unreadable" — the pass throws and the lease retries.
 *   3. Decrypts every secret under the current config (findUnreadableOrgSecrets).
 *   4. CLEARS the marker conditionally on its lease. A miss means a newer
 *      change landed during the check: its own check covers the org, and this
 *      result (read across a config flip) is dropped unreported.
 *   5. Reports any unreadable fields — names only, never values: an error log,
 *      an `admin.org.kms-config.verify` failure audit row, one
 *      `platform_kms_secret_verify_failed_total{field}` per field
 *      (KmsSecretVerifyFailed alert), and a notice to the org's owners/admins
 *      (in-app per admin + email) that those secrets must be re-entered.
 *
 * Leader-locked (one replica sweeps per window) and concurrency-safe besides:
 * each org is claimed atomically, so the no-Redis path may run it everywhere.
 */

import {
  SYSTEM_ACTOR_ID,
  SYSTEM_ORG_ID,
  createLogger,
  errorMessage,
  leaderLockKey,
} from '@pipeline-builder/api-core';
import { ADMIN_ORG_ROLES } from '@pipeline-builder/api-core/wire-vocabulary';
import type { IntervalSweepDefinition } from './background-sweeps.js';
import { findUnreadableOrgSecrets } from './secret-reencrypt.js';
import { recordAuditEvent } from '../helpers/audit.js';
import { toOrgId } from '../helpers/org-id.js';
import { Organization, User, UserOrganization } from '../models/index.js';
import { incCounter } from '../observability/metrics.js';
import { wrapEncrypted } from '../utils/secret-blob.js';

const logger = createLogger('kms-config-verify');

/** A claimed check's lease: if the claimer dies, the marker comes due again after this. */
const CLAIM_LEASE_MS = 5 * 60_000;

/** Sweep cadence: a due check runs within this of its due time. */
const SWEEP_INTERVAL_MS = 60_000;

/** Orgs checked per pass, oldest due first; a backlog drains over passes. */
const VERIFY_BATCH = 50;

/** Human wording for a field name, for the admins' notice. */
function describeField(field: string): string {
  if (field === 'idpClientSecret') return 'the SSO (identity provider) client secret';
  const provider = field.startsWith('aiProviderKeys.') ? field.slice('aiProviderKeys.'.length) : field;
  return `the ${provider} AI provider key`;
}

/** Tell the org's owners/admins which secrets must be re-entered. Never throws. */
async function notifyAdmins(orgId: string, fields: string[]): Promise<void> {
  try {
    const [org, admins] = await Promise.all([
      Organization.findById(toOrgId(orgId)).select('name').lean(),
      UserOrganization.find({ organizationId: toOrgId(orgId), isActive: true, role: { $in: [...ADMIN_ORG_ROLES] } })
        .select('userId').lean(),
    ]);
    if (admins.length === 0) {
      logger.warn('KMS verify: no active admin to tell about unreadable secrets', { orgId, fields });
      return;
    }
    const orgName = (org as { name?: string } | null)?.name ?? 'your organization';
    const subject = `Action needed: re-enter ${fields.length === 1 ? 'a secret' : `${fields.length} secrets`} for ${orgName}`;
    const content = `The encryption key for ${orgName} was changed, and the following stored `
      + `${fields.length === 1 ? 'secret' : 'secrets'} can no longer be read:\n\n`
      + fields.map((f) => `- ${describeField(f)}`).join('\n')
      + '\n\nPlease re-enter each one in organization settings. Until you do, the features that use them '
      + '(AI features, SSO sign-in) will fail for your organization.';

    const users = await User.find({ _id: { $in: admins.map((a) => a.userId) } }).select('email').lean();
    const emails = users.map((u) => (u as { email?: string }).email).filter((e): e is string => !!e);

    const { emailService } = await import('../utils/email.js');
    const { sendInAppNotification } = await import('../helpers/in-app-notify.js');
    await Promise.all([
      emails.length > 0 ? emailService.send({ to: emails, subject, text: content }) : Promise.resolve(true),
      ...admins.map((a) => sendInAppNotification({
        recipientOrgId: orgId,
        recipientUserId: String((a as { userId: unknown }).userId),
        subject,
        content,
      })),
    ]);
  } catch (err) {
    logger.warn('KMS verify: notifying admins failed (the audit row and alert still stand)', { orgId, error: errorMessage(err) });
  }
}

/** Report unreadable fields: log, audit, count, notify. */
async function reportUnreadable(orgId: string, fields: string[]): Promise<void> {
  logger.error('KMS verify: org secrets do not decrypt under the current KMS config; they must be re-entered', { orgId, fields });
  recordAuditEvent({
    action: 'admin.org.kms-config.verify',
    actorId: SYSTEM_ACTOR_ID,
    orgId: SYSTEM_ORG_ID,
    affectedOrgId: orgId,
    targetType: 'org-kms-config',
    targetId: orgId,
    outcome: 'failure',
    details: { unreadableSecrets: fields, reason: 'kms-config-verify' },
  });
  for (const field of fields) incCounter('platform_kms_secret_verify_failed_total', { field });
  await notifyAdmins(orgId, fields);
}

/**
 * Verify one due org. Returns the unreadable field names, or null when the
 * check was not ours to report (claim lost, or superseded during the check).
 */
async function verifyOrg(orgId: string, due: Date): Promise<string[] | null> {
  const lease = new Date(Date.now() + CLAIM_LEASE_MS);
  const claimed = await Organization.updateOne(
    { _id: toOrgId(orgId), kmsVerifyDueAt: due },
    { $set: { kmsVerifyDueAt: lease } },
  );
  if (claimed.matchedCount === 0) return null;

  // A provider that cannot encrypt for the org at all is a fault to retry, not
  // a verdict on the stored secrets.
  await wrapEncrypted('kms-config-verify-probe', orgId);
  const unreadable = await findUnreadableOrgSecrets(orgId);

  const cleared = await Organization.updateOne(
    { _id: toOrgId(orgId), kmsVerifyDueAt: lease },
    { $unset: { kmsVerifyDueAt: '' } },
  );
  if (cleared.matchedCount === 0) {
    logger.info('KMS verify superseded by a newer config change; its own check will run', { orgId });
    return null;
  }
  return unreadable;
}

/**
 * One pass over every org whose verification is due. Throws (after trying
 * every org) when any org's check failed, so the scheduler records a failed
 * cycle; those orgs keep their lease and come due again.
 */
export async function runDueKmsVerifications(signal?: AbortSignal): Promise<{ verified: number; unreadable: number }> {
  const due = await Organization.find({ kmsVerifyDueAt: { $lte: new Date() } })
    .select('_id kmsVerifyDueAt')
    .sort({ kmsVerifyDueAt: 1 })
    .limit(VERIFY_BATCH)
    .lean();

  let verified = 0;
  let unreadable = 0;
  const failed: string[] = [];
  for (const org of due) {
    if (signal?.aborted) break;
    const orgId = String(org._id);
    try {
      const fields = await verifyOrg(orgId, org.kmsVerifyDueAt as Date);
      if (fields === null) continue;
      verified++;
      if (fields.length > 0) {
        unreadable += fields.length;
        await reportUnreadable(orgId, fields);
      } else {
        logger.info('KMS verify: every org secret decrypts under the current config', { orgId });
      }
    } catch (err) {
      failed.push(`${orgId}: ${errorMessage(err)}`);
      logger.error('KMS verify: check failed; it will be retried', { orgId, error: errorMessage(err) });
    }
  }
  if (failed.length > 0) {
    throw new Error(`KMS config verification failed for ${failed.length} of ${due.length} due org(s): ${failed.join('; ')}`);
  }
  return { verified, unreadable };
}

/** The verification as a background sweep (see services/background-sweeps.ts). */
export function kmsConfigVerifySweep(): IntervalSweepDefinition {
  return {
    name: 'kms-config-verify',
    lockKey: leaderLockKey('platform', 'kms-config-verify'),
    intervalMs: SWEEP_INTERVAL_MS,
    // Every org is claimed by a conditional update on its marker, so replicas
    // racing the same org verify it once.
    concurrencySafe: true,
    run: async (run) => { await runDueKmsVerifications(run.signal); },
  };
}
