// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-org KMS configuration admin endpoints.
 *
 *   GET    /api/admin/orgs/:orgId/kms-config  read current config
 *   PUT    /api/admin/orgs/:orgId/kms-config  upsert (set keyId + ciphertextBase64)
 *   DELETE /api/admin/orgs/:orgId/kms-config  clear (org falls back to shared master)
 *
 * Sysadmin-gated. Maintains the per-org KMS posture: when
 * `SECRET_ENCRYPTION_PER_ORG_KMS=true`, the `PerOrgKmsKeyProvider` reads
 * `Organization.kmsConfig` to wrap each org's secrets under its own CMK.
 * Orgs without a config fall through to the shared base master.
 *
 * After PUT, the in-process provider's cache for the affected org is
 * evicted so the next write/read picks up the new key without a restart.
 * PUT and DELETE then have the pipeline service re-wrap the org's runner
 * signing keys (services/runner-key-reencrypt.ts).
 *
 * The endpoint never returns the wrapped master ciphertext in GET responses —
 * it's safe to log / commit (only the KMS CMK can unwrap it), but echoing
 * it on read serves no legitimate purpose and reduces accidental exposure
 * surfaces. Operators can re-derive from the KMS console if needed.
 */

import { createHash } from 'crypto';
import {
  PerOrgKmsKeyProvider,
  type KeyProvider,
  createLogger,
  getDefaultKeyProvider,
  sendError,
  sendSuccess,
  errorMessage,
} from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { requireSystemAdmin, withController } from '../helpers/controller-helper.js';
import { toOrgId } from '../helpers/org-id.js';
import { activeKmsConfig } from '../helpers/org-kms-config.js';
import { Organization } from '../models/index.js';
import { reencryptRunnerSigningKeys, type RunnerKeyReencryptResult } from '../services/runner-key-reencrypt.js';
import { captureOrgSecrets, reencryptOrgSecrets } from '../services/secret-reencrypt.js';
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
 *  PerOrgKmsKeyProvider. No-op for any other provider. */
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

/** PUT /api/admin/orgs/:orgId/kms-config?reencrypt=true (default true)
 *
 * Three-phase rotation:
 *  1. Capture all encrypted secrets under the org with the OLD provider active.
 *  2. Save the new kmsConfig + evict the per-org cache so the NEW provider
 *     becomes active on the next encrypt call.
 *  3. Re-encrypt the captured plaintexts under the NEW provider.
 *
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
export const putOrgKmsConfig = withController('Put org KMS config', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  const orgId = String(req.params.orgId);
  const reencrypt = String(req.query.reencrypt ?? 'true').toLowerCase() !== 'false';

  const parsed = validateBody(orgKmsConfigSchema, req.body, res);
  if (!parsed) return;

  const org = await Organization.findById(toOrgId(orgId));
  if (!org) return sendError(res, 404, 'Organization not found');

  // Capture plaintexts under the OLD provider, before any state changes.
  // If decryption fails, abort — we'd rather refuse the rotation than
  // leave the org with unreadable secrets.
  let captured;
  if (reencrypt) {
    try {
      captured = await captureOrgSecrets(orgId);
    } catch (err) {
      logger.warn('KMS rotation aborted: pre-rotation capture failed', {
        orgId,
        error: errorMessage(err),
      });
      return sendError(
        res, 409,
        `Cannot rotate KMS config: failed to decrypt existing platform secrets under the current provider. ${errorMessage(err)}. Repair the failing row OR retry with ?reencrypt=false, which skips only the platform secret re-encrypt (existing platform secrets — AI provider keys, the SSO client secret — will become unreadable; the org's runner signing keys are still re-wrapped).`,
      );
    }
  }

  const previousKmsConfig = activeKmsConfig(org.kmsConfig);
  org.kmsConfig = { keyId: parsed.keyId, ciphertextBase64: parsed.ciphertextBase64 };
  org.markModified('kmsConfig');
  await org.save();

  evictPerOrgCache(orgId);

  // Once the config is saved the previous one survives only in this request,
  // so the runner keys are re-wrapped even when the Mongo pass failed —
  // skipping them would strand them under a config nothing can name again.
  let reencryptCounts;
  let secretsError: string | undefined;
  if (reencrypt && captured) {
    try {
      reencryptCounts = await reencryptOrgSecrets(orgId, captured);
    } catch (err) {
      // Mid-flight failure: secrets are partially re-encrypted. Surface
      // the error loud so on-call can finish the migration manually.
      secretsError = errorMessage(err);
      logger.error('KMS rotation: re-encryption failed after config change', { orgId, error: secretsError });
    }
  }

  const runnerKeys = await reencryptRunnerSigningKeys({ orgId, previousKmsConfig });
  if (!runnerKeys.ok) {
    logger.error('KMS rotation: runner signing key re-encryption failed after config change', { orgId, error: runnerKeys.error });
  }

  audit(req, 'admin.org.kms-config.upsert', {
    targetType: 'org-kms-config',
    targetId: orgId,
    affectedOrgId: orgId,
    details: {
      keyId: parsed.keyId,
      ...(reencryptCounts ?? {}),
      ...(secretsError ? { secretsReencryptError: secretsError } : {}),
      ...runnerKeyDetails(runnerKeys),
    },
    ...(secretsError || !runnerKeys.ok ? { outcome: 'failure' as const } : {}),
  });

  if (secretsError) {
    const runnerNote = !runnerKeys.ok ? ` Also, ${runnerKeys.error}.` : '';
    return sendError(
      res, 500,
      `KMS config saved but re-encryption failed mid-flight: ${secretsError}. Some secrets may now be unreadable. Re-enter them via their respective admin endpoints.${runnerNote}`,
    );
  }

  if (!runnerKeys.ok) {
    return sendError(
      res, 500,
      `KMS config saved${reencrypt ? ' and platform secrets re-encrypted' : ''}, but ${runnerKeys.error}. That org's pipeline runners cannot sign until the pipeline re-encrypt is rerun for it.`,
    );
  }

  sendSuccess(res, 200, { configured: true, keyId: parsed.keyId, ...(reencryptCounts ?? {}), ...runnerKeyDetails(runnerKeys) });
});

/** DELETE /api/admin/orgs/:orgId/kms-config */
export const deleteOrgKmsConfig = withController('Delete org KMS config', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  const orgId = String(req.params.orgId);

  const org = await Organization.findById(toOrgId(orgId));
  if (!org) return sendError(res, 404, 'Organization not found');

  if (!org.kmsConfig?.keyId) {
    return sendSuccess(res, 200, { configured: false, message: 'No KMS config to clear' });
  }

  const previousKmsConfig = activeKmsConfig(org.kmsConfig);
  org.kmsConfig = undefined;
  org.markModified('kmsConfig');
  await org.save();

  evictPerOrgCache(orgId);

  // The org's runner signing keys move from its CMK to the shared provider.
  const runnerKeys = await reencryptRunnerSigningKeys({ orgId, previousKmsConfig });
  if (!runnerKeys.ok) {
    logger.error('KMS config cleared: runner signing key re-encryption failed', { orgId, error: runnerKeys.error });
  }

  audit(req, 'admin.org.kms-config.delete', {
    targetType: 'org-kms-config',
    targetId: orgId,
    affectedOrgId: orgId,
    details: runnerKeyDetails(runnerKeys),
    ...(runnerKeys.ok ? {} : { outcome: 'failure' as const }),
  });

  if (!runnerKeys.ok) {
    return sendError(
      res, 500,
      `KMS config cleared, but ${runnerKeys.error}. That org's pipeline runners cannot sign until the pipeline re-encrypt is rerun for it.`,
    );
  }

  sendSuccess(res, 200, { configured: false, ...runnerKeyDetails(runnerKeys) });
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
