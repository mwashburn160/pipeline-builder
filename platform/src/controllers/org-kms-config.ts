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
 * Orgs without a config fall through to `EnvKeyProvider`.
 *
 * After PUT, the in-process provider's cache for the affected org is
 * evicted so the next write/read picks up the new key without a restart.
 *
 * The endpoint never returns the wrapped master ciphertext in GET responses —
 * it's safe to log / commit (only the KMS CMK can unwrap it), but echoing
 * it on read serves no legitimate purpose and reduces accidental exposure
 * surfaces. Operators can re-derive from the KMS console if needed.
 */

import { createHash } from 'crypto';
import {
  EnvKeyProvider,
  PerOrgKmsKeyProvider,
  createLogger,
  getDefaultKeyProvider,
  sendError,
  sendSuccess,
} from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { requireSystemAdmin, withController } from '../helpers/controller-helper.js';
import { Organization } from '../models/index.js';
import { captureOrgSecrets, reencryptOrgSecrets } from '../services/secret-reencrypt.js';

const logger = createLogger('org-kms-config-controller');

/** Parse + validate a `PUT` body. */
function parseKmsConfigBody(body: unknown): { keyId: string; ciphertextBase64: string } | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  if (typeof b.keyId !== 'string' || b.keyId.length === 0) {
    return { error: 'keyId is required (KMS CMK alias or ARN)' };
  }
  if (typeof b.ciphertextBase64 !== 'string' || b.ciphertextBase64.length === 0) {
    return { error: 'ciphertextBase64 is required (KMS-wrapped 32-byte master)' };
  }
  // Cheap shape check — proper base64 validation will land at the SDK call
  // when the provider runs Decrypt. We just guard against blatantly wrong
  // input that would otherwise fail much later in the next encrypt path.
  if (!/^[A-Za-z0-9+/=]+$/.test(b.ciphertextBase64)) {
    return { error: 'ciphertextBase64 must be valid base64' };
  }
  return { keyId: b.keyId, ciphertextBase64: b.ciphertextBase64 };
}

/** Evict the cached master for `orgId` from the active provider if it's a
 *  PerOrgKmsKeyProvider. No-op for EnvKeyProvider or any other provider. */
function evictPerOrgCache(orgId: string): void {
  const provider = getDefaultKeyProvider();
  if (provider instanceof PerOrgKmsKeyProvider) {
    provider.evict(orgId);
    logger.info('Evicted per-org KMS cache after config change', { orgId });
  }
}

/** GET /api/admin/orgs/:orgId/kms-config */
export const getOrgKmsConfig = withController('Get org KMS config', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  const orgId = String(req.params.orgId);
  const org = await Organization.findById(orgId).select('kmsConfig').lean();
  if (!org) return sendError(res, 404, 'Organization not found');

  const cfg = (org as { kmsConfig?: { keyId?: string; ciphertextBase64?: string } }).kmsConfig;
  if (!cfg?.keyId || !cfg?.ciphertextBase64) {
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
 * Opt out with `?reencrypt=false` only when you know the org has no
 * stored secrets yet — otherwise existing secrets become unreadable.
 */
export const putOrgKmsConfig = withController('Put org KMS config', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  const orgId = String(req.params.orgId);
  const reencrypt = String(req.query.reencrypt ?? 'true').toLowerCase() !== 'false';

  const parsed = parseKmsConfigBody(req.body);
  if ('error' in parsed) return sendError(res, 400, parsed.error);

  const org = await Organization.findById(orgId);
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
        error: err instanceof Error ? err.message : String(err),
      });
      return sendError(
        res, 409,
        `Cannot rotate KMS config: failed to decrypt existing secrets under the current provider. ${err instanceof Error ? err.message : String(err)}. Repair the failing row OR retry with ?reencrypt=false (existing secrets will become unreadable).`,
      );
    }
  }

  org.kmsConfig = { keyId: parsed.keyId, ciphertextBase64: parsed.ciphertextBase64 };
  org.markModified('kmsConfig');
  await org.save();

  evictPerOrgCache(orgId);

  let reencryptCounts;
  if (reencrypt && captured) {
    try {
      reencryptCounts = await reencryptOrgSecrets(orgId, captured);
    } catch (err) {
      // Mid-flight failure: secrets are partially re-encrypted. Surface
      // the error loud so on-call can finish the migration manually.
      logger.error('KMS rotation: re-encryption failed after config change', {
        orgId,
        error: err instanceof Error ? err.message : String(err),
      });
      return sendError(
        res, 500,
        `KMS config saved but re-encryption failed mid-flight: ${err instanceof Error ? err.message : String(err)}. Some secrets may now be unreadable. Re-enter them via their respective admin endpoints.`,
      );
    }
  }

  audit(req, 'admin.org.kms-config.upsert', {
    targetType: 'org-kms-config',
    targetId: orgId,
    affectedOrgId: orgId,
    details: { keyId: parsed.keyId, ...(reencryptCounts ?? {}) },
  });

  sendSuccess(res, 200, { configured: true, keyId: parsed.keyId, ...(reencryptCounts ?? {}) });
});

/** DELETE /api/admin/orgs/:orgId/kms-config */
export const deleteOrgKmsConfig = withController('Delete org KMS config', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  const orgId = String(req.params.orgId);

  const org = await Organization.findById(orgId);
  if (!org) return sendError(res, 404, 'Organization not found');

  if (!org.kmsConfig?.keyId) {
    return sendSuccess(res, 200, { configured: false, message: 'No KMS config to clear' });
  }

  org.kmsConfig = undefined;
  org.markModified('kmsConfig');
  await org.save();

  evictPerOrgCache(orgId);

  audit(req, 'admin.org.kms-config.delete', {
    targetType: 'org-kms-config',
    targetId: orgId,
    affectedOrgId: orgId,
  });

  sendSuccess(res, 200, { configured: false });
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

  const parsed = parseKmsConfigBody(req.body);
  if ('error' in parsed) return sendError(res, 400, parsed.error);

  const org = await Organization.findById(orgId).select('_id').lean();
  if (!org) return sendError(res, 404, 'Organization not found');

  // Construct an ephemeral PerOrgKmsKeyProvider with the proposed config.
  // The fallback is `EnvKeyProvider` (the same shared master the live
  // provider uses) so the test never accidentally leaves Mongo touched.
  try {
    const provider = new PerOrgKmsKeyProvider({
      resolver: async () => ({ keyId: parsed.keyId, ciphertextBase64: parsed.ciphertextBase64 }),
      fallback: new EnvKeyProvider(),
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
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('KMS config test failed', { orgId, keyId: parsed.keyId, error: message });
    return sendError(res, 400, `KMS test failed: ${message}`);
  }
});
