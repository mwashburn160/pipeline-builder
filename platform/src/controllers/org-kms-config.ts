// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-org KMS configuration admin endpoints.
 *
 *   GET    /api/admin/orgs/:orgId/kms-config  read current config
 *   PUT    /api/admin/orgs/:orgId/kms-config  upsert (set keyId + ciphertextBase64)
 *   DELETE /api/admin/orgs/:orgId/kms-config  clear (org falls back to shared master)
 *
 * PUT and DELETE both migrate the org's platform secrets and runner signing
 * keys from the outgoing config to the incoming one (`changeKmsConfig`).
 *
 * Sysadmin-gated. Maintains the per-org KMS posture: when
 * `SECRET_ENCRYPTION_PER_ORG_KMS=true`, the `PerOrgKmsKeyProvider` reads
 * `Organization.kmsConfig` to wrap each org's secrets under its own CMK.
 * Orgs without a config fall through to the shared base master.
 *
 * After a change, the in-process provider's cache for the affected org is
 * evicted so the next write/read picks up the new key without a restart.
 * The pipeline service then re-wraps the org's runner signing keys
 * (services/runner-key-reencrypt.ts).
 *
 * The endpoint never returns the wrapped master ciphertext in GET responses —
 * it's safe to log / commit (only the KMS CMK can unwrap it), but echoing
 * it on read serves no legitimate purpose and reduces accidental exposure
 * surfaces. Operators can re-derive from the KMS console if needed.
 */

import { createHash } from 'crypto';
import {
  ErrorCode,
  PerOrgKmsKeyProvider,
  type KeyProvider,
  createLogger,
  getDefaultKeyProvider,
  sendError,
  sendSuccess,
  errorMessage,
} from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';
import { audit } from '../helpers/audit.js';
import { requireSystemAdmin, withController } from '../helpers/controller-helper.js';
import { toOrgId } from '../helpers/org-id.js';
import { activeKmsConfig } from '../helpers/org-kms-config.js';
import type { AuditAction } from '../models/audit-event.js';
import { Organization, type OrganizationDocument } from '../models/index.js';
import { reencryptRunnerSigningKeys, type RunnerKeyReencryptResult } from '../services/runner-key-reencrypt.js';
import { captureOrgSecrets, OrgSecretsReencryptError, reencryptOrgSecrets } from '../services/secret-reencrypt.js';
import { orgKmsConfigSchema, validateBody } from '../utils/validation.js';

const logger = createLogger('org-kms-config-controller');

/** The dry-run's per-org fallback. Never reached (the resolver always returns
 *  the proposed config); it throws rather than derive anything if it ever is. */
const UNREACHABLE_FALLBACK: KeyProvider = {
  deriveKey: () => {
    throw new Error('KMS config test resolved no per-org config');
  },
};

/** Evict the cached master for `orgId` from the active provider if it's a
 *  PerOrgKmsKeyProvider. No-op for any other provider. `evict` applies here AND
 *  broadcasts over the cache-invalidation bus, so every other platform replica
 *  and every pipeline replica drops the org's key too (TTL backstop otherwise). */
function evictPerOrgCache(orgId: string): void {
  const provider = getDefaultKeyProvider();
  if (provider instanceof PerOrgKmsKeyProvider) {
    provider.evict(orgId);
    logger.info('Evicted per-org KMS cache after config change', { orgId });
  }
}

/** Audit / response fields for the pipeline service's runner-key re-encrypt. */
function runnerKeyDetails(result: RunnerKeyReencryptResult): Record<string, unknown> {
  return result.ok
    ? { runnerKeysReencrypted: result.counts.reencrypted, runnerKeysScanned: result.counts.scanned }
    : { runnerKeysReencryptError: result.error, ...(result.counts ? { runnerKeyFailures: result.counts.failures } : {}) };
}

/** GET /api/admin/orgs/:orgId/kms-config */
export const getOrgKmsConfig = withController('Get org KMS config', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  const orgId = String(req.params.orgId);
  const org = await Organization.findById(toOrgId(orgId)).select('kmsConfig').lean();
  if (!org) return sendError(res, 404, 'Organization not found');

  const cfg = activeKmsConfig(org.kmsConfig);
  if (!cfg) {
    return sendSuccess(res, 200, { configured: false });
  }
  // Return only the keyId — the ciphertext is intentionally elided. See
  // module docstring for rationale.
  sendSuccess(res, 200, { configured: true, keyId: cfg.keyId });
});

type ProposedKmsConfig = { keyId: string; ciphertextBase64: string };

/** Mongo filter fragment matching an org whose stored kmsConfig is still
 *  `current` — the exact keyId and ciphertext, or no active config at all
 *  (either field missing/empty, the {@link activeKmsConfig} reading). */
function kmsConfigMatch(current: ProposedKmsConfig | null): Record<string, unknown> {
  return current
    ? { 'kmsConfig.keyId': current.keyId, 'kmsConfig.ciphertextBase64': current.ciphertextBase64 }
    : { $or: [{ 'kmsConfig.keyId': { $in: [null, ''] } }, { 'kmsConfig.ciphertextBase64': { $in: [null, ''] } }] };
}

/**
 * Put `previous` back after a change to `next` whose secret re-encrypt failed
 * before writing anything — conditionally on `next` still being the stored
 * config, so a change that landed since is never overwritten. True when the
 * previous config is current again. A failed restore is logged, not thrown:
 * the caller then finishes the migration as if no restore was tried.
 */
async function restoreKmsConfig(
  orgId: string,
  org: OrganizationDocument,
  next: ProposedKmsConfig | null,
  previous: ProposedKmsConfig | null,
): Promise<boolean> {
  try {
    const restored = await Organization.updateOne(
      { _id: org._id, ...kmsConfigMatch(next) },
      previous ? { $set: { kmsConfig: { keyId: previous.keyId, ciphertextBase64: previous.ciphertextBase64 } } } : { $unset: { kmsConfig: 1 } },
    );
    if (restored.matchedCount === 0) {
      logger.error('KMS config restore skipped: the config changed again since this request saved it', { orgId });
      return false;
    }
  } catch (err) {
    logger.error('KMS config restore failed', { orgId, error: errorMessage(err) });
    return false;
  }
  evictPerOrgCache(orgId);
  return true;
}

/** The two config changes, keyed: their audit action and the words their messages use. */
const KMS_CONFIG_CHANGES = {
  upsert: { action: 'admin.org.kms-config.upsert', verb: 'rotate', done: 'saved' },
  delete: { action: 'admin.org.kms-config.delete', verb: 'clear', done: 'cleared' },
} as const satisfies Record<string, { action: AuditAction; verb: string; done: string }>;
type KmsConfigChange = keyof typeof KMS_CONFIG_CHANGES;

/**
 * Change an org's per-org KMS config — set it (`next`) or clear it (`null`) —
 * and move everything wrapped under the outgoing config onto the incoming one.
 * PUT and DELETE are the same migration: the derived key changes either way,
 * so every platform secret wrapped under the old one must move with it.
 *
 *  1. Capture all encrypted platform secrets under the org with the OLD
 *     provider active (skipped with `?reencrypt=false`). A capture failure
 *     refuses the change (409) before anything is written.
 *  2. Save the new kmsConfig — conditionally on the outgoing config still
 *     being current, so a concurrent PUT/DELETE gets 409 CONFLICT before it
 *     re-encrypts anything — + evict the per-org cache so the NEW provider
 *     becomes active on the next encrypt call.
 *  3. Re-encrypt the captured plaintexts under the NEW provider. A failure
 *     before any secret was written (the new CMK unusable) restores the
 *     previous config and answers 500 without touching the runner keys.
 *  4. Ask the pipeline service to re-wrap the org's runner signing keys
 *     (Postgres), handing it the config they were written under.
 *
 * `?reencrypt=false` skips phases 1 and 3 only (the platform Mongo secrets):
 * use it only when the org has no stored platform secrets yet, or to push past
 * an unreadable row — those secrets become unreadable. Phase 4 always runs:
 * the runner keys are independent of the Mongo capture, and once the config is
 * saved the previous one survives only in this request. A runner-key failure
 * is reported (500, audited), never swallowed: the config is saved by then, so
 * the operator must rerun the pipeline re-encrypt for the org.
 */
async function changeKmsConfig(
  req: Request,
  res: Response,
  orgId: string,
  org: OrganizationDocument,
  next: ProposedKmsConfig | null,
  change: KmsConfigChange,
): Promise<void> {
  const { action, verb, done } = KMS_CONFIG_CHANGES[change];
  const reencrypt = String(req.query.reencrypt ?? 'true').toLowerCase() !== 'false';

  // Capture plaintexts under the OLD provider, before any state changes.
  // If decryption fails, abort — we'd rather refuse the change than
  // leave the org with unreadable secrets.
  let captured;
  if (reencrypt) {
    try {
      captured = await captureOrgSecrets(orgId);
    } catch (err) {
      logger.warn(`KMS config ${verb} aborted: pre-change capture failed`, {
        orgId,
        error: errorMessage(err),
      });
      return void sendError(
        res, 409,
        `Cannot ${verb} KMS config: failed to decrypt existing platform secrets under the current provider. ${errorMessage(err)}. Repair the failing row OR retry with ?reencrypt=false, which skips only the platform secret re-encrypt (existing platform secrets — AI provider keys, the SSO client secret — will become unreadable; the org's runner signing keys are still re-wrapped).`,
      );
    }
  }

  // Save conditionally on the config this request read (and captured under)
  // still being the current one. Two concurrent changes both read the same
  // outgoing config; only the first save matches, and the second is refused
  // here — before it re-encrypts anything — instead of re-wrapping secrets it
  // captured under a config that is no longer the org's.
  const previousKmsConfig = activeKmsConfig(org.kmsConfig);
  const saved = await Organization.updateOne(
    { _id: org._id, ...kmsConfigMatch(previousKmsConfig) },
    next
      ? { $set: { kmsConfig: { keyId: next.keyId, ciphertextBase64: next.ciphertextBase64 } } }
      : { $unset: { kmsConfig: 1 } },
  );
  if (saved.matchedCount === 0) {
    logger.warn(`KMS config ${verb} refused: the config changed since this request read it`, { orgId });
    return void sendError(
      res, 409,
      `Cannot ${verb} KMS config: it was changed by another request while this one was in flight. Nothing was written; re-read the config and retry.`,
      ErrorCode.CONFLICT,
    );
  }

  evictPerOrgCache(orgId);

  // Once the config is saved the previous one survives only in this request,
  // so the runner keys are re-wrapped even when the Mongo pass failed —
  // skipping them would strand them under a config nothing can name again.
  // The one exception: a pass that failed before writing anything (the new
  // CMK unusable) is undone by restoring the previous config instead.
  let reencryptCounts;
  let secretsError: string | undefined;
  if (reencrypt && captured) {
    try {
      reencryptCounts = await reencryptOrgSecrets(orgId, captured);
    } catch (err) {
      secretsError = errorMessage(err);
      logger.error(`KMS config ${verb}: re-encryption failed after config change`, { orgId, error: secretsError });
      if (err instanceof OrgSecretsReencryptError && !err.written
        && await restoreKmsConfig(orgId, org, next, previousKmsConfig)) {
        audit(req, action, {
          targetType: 'org-kms-config',
          targetId: orgId,
          affectedOrgId: orgId,
          outcome: 'failure',
          details: { ...(next ? { keyId: next.keyId } : {}), secretsReencryptError: secretsError, configRestored: true },
        });
        return void sendError(
          res, 500,
          `Cannot ${verb} KMS config: re-encrypting the platform secrets under the new config failed before any was written: ${secretsError}. The previous config was restored; nothing else changed. Check the new config with POST .../kms-config/test and retry.`,
        );
      }
      // Otherwise secrets may be partially re-encrypted. Surface the error
      // loud so on-call can finish the migration manually.
    }
  }

  const runnerKeys = await reencryptRunnerSigningKeys({ orgId, previousKmsConfig });
  if (!runnerKeys.ok) {
    logger.error(`KMS config ${verb}: runner signing key re-encryption failed after config change`, { orgId, error: runnerKeys.error });
  }

  audit(req, action, {
    targetType: 'org-kms-config',
    targetId: orgId,
    affectedOrgId: orgId,
    details: {
      ...(next ? { keyId: next.keyId } : {}),
      ...(reencryptCounts ?? {}),
      ...(secretsError ? { secretsReencryptError: secretsError } : {}),
      ...runnerKeyDetails(runnerKeys),
    },
    // A secret a stale replica wrote under the OLD key mid-migration is now
    // unreadable — the change landed, but that secret must be re-entered.
    ...(secretsError || !runnerKeys.ok || reencryptCounts?.unreadableConcurrentWrites.length ? { outcome: 'failure' as const } : {}),
  });

  if (secretsError) {
    const runnerNote = !runnerKeys.ok ? ` Also, ${runnerKeys.error}.` : '';
    return void sendError(
      res, 500,
      `KMS config ${done} but re-encryption failed mid-flight: ${secretsError}. Some secrets may now be unreadable. Re-enter them via their respective admin endpoints.${runnerNote}`,
    );
  }

  if (!runnerKeys.ok) {
    return void sendError(
      res, 500,
      `KMS config ${done}${reencrypt ? ' and platform secrets re-encrypted' : ''}, but ${runnerKeys.error}. That org's pipeline runners cannot sign until the pipeline re-encrypt is rerun for it.`,
    );
  }

  sendSuccess(res, 200, {
    configured: next !== null,
    ...(next ? { keyId: next.keyId } : {}),
    ...(reencryptCounts ?? {}),
    ...runnerKeyDetails(runnerKeys),
  });
}

/** PUT /api/admin/orgs/:orgId/kms-config?reencrypt=true (default true) — see {@link changeKmsConfig}. */
export const putOrgKmsConfig = withController('Put org KMS config', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  const orgId = String(req.params.orgId);

  const parsed = validateBody(orgKmsConfigSchema, req.body, res);
  if (!parsed) return;

  const org = await Organization.findById(toOrgId(orgId));
  if (!org) return sendError(res, 404, 'Organization not found');

  await changeKmsConfig(req, res, orgId, org, parsed, 'upsert');
});

/**
 * DELETE /api/admin/orgs/:orgId/kms-config?reencrypt=true (default true)
 *
 * The org falls back to the shared provider. Its platform secrets were wrapped
 * under a key derived from its CMK, which the shared provider cannot open, so
 * they are migrated exactly as a PUT migrates them ({@link changeKmsConfig}).
 */
export const deleteOrgKmsConfig = withController('Delete org KMS config', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  const orgId = String(req.params.orgId);

  const org = await Organization.findById(toOrgId(orgId));
  if (!org) return sendError(res, 404, 'Organization not found');

  if (!org.kmsConfig?.keyId) {
    return sendSuccess(res, 200, { configured: false, message: 'No KMS config to clear' });
  }

  await changeKmsConfig(req, res, orgId, org, null, 'delete');
});

/**
 * POST /api/admin/orgs/:orgId/kms-config/test  — dry-run a proposed config.
 *
 * Operators want to verify (a) the KMS CMK exists, (b) the platform's IAM
 * role can `kms:Decrypt` it, and (c) the wrapped master is well-formed
 * BEFORE committing the config and triggering re-encryption of every
 * stored secret. Failures at PUT time leave the org in a half-rotated
 * state; this endpoint surfaces the failure first.
 *
 * Returns a SHA-256 fingerprint (first 12 hex chars) of the derived
 * per-org key on success — lets the operator confirm two test runs
 * derive the same key (which proves config stability) without ever
 * exposing the key itself.
 */
export const testOrgKmsConfig = withController('Test org KMS config', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  const orgId = String(req.params.orgId);

  const parsed = validateBody(orgKmsConfigSchema, req.body, res);
  if (!parsed) return;

  const org = await Organization.findById(toOrgId(orgId)).select('_id').lean();
  if (!org) return sendError(res, 404, 'Organization not found');

  // Construct an ephemeral PerOrgKmsKeyProvider with the proposed config. Its
  // resolver ALWAYS answers with that config, so the fallback is never
  // consulted — and it must not be built from the environment: an
  // `EnvKeyProvider` throws at construction when `SECRET_ENCRYPTION_KEY` is
  // unset, which is exactly a KMS-only deployment (base master KMS-wrapped),
  // so the dry-run would fail on every call before touching KMS at all.
  try {
    const provider = new PerOrgKmsKeyProvider({
      resolver: async () => ({ keyId: parsed.keyId, ciphertextBase64: parsed.ciphertextBase64 }),
      fallback: UNREACHABLE_FALLBACK,
    });
    const derived = await provider.deriveKeyAsync(orgId);
    const fingerprint = createHash('sha256').update(derived).digest('hex').slice(0, 12);
    logger.info('KMS config test succeeded', { orgId, keyId: parsed.keyId, fingerprint });
    return sendSuccess(res, 200, {
      ok: true,
      keyId: parsed.keyId,
      keyFingerprint: fingerprint,
      message: 'KMS Decrypt succeeded; derived a 32-byte per-org key.',
    });
  } catch (err) {
    const message = errorMessage(err);
    logger.warn('KMS config test failed', { orgId, keyId: parsed.keyId, error: message });
    return sendError(res, 400, `KMS test failed: ${message}`);
  }
});
