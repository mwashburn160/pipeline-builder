// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Re-encrypt an org's at-rest secrets under a (possibly new) key provider.
 *
 * When an operator adopts per-org KMS — or rotates an existing org's CMK —
 * the wrapped master changes. Every previously-encrypted secret carries
 * the OLD kid in `EncryptedBlob.kid`, so:
 *
 *   - On the first decrypt after rotation, `decryptSecret` either:
 *       (a) refuses with "KMS key id mismatch" (new kid matches, old blob's
 *           kid is different), or
 *       (b) silently derives a different HKDF key under the new master and
 *           fails the AES-GCM auth tag.
 *   Either way the secret is unreadable. The migration is mandatory.
 *
 * This helper does the migration in three phases:
 *   1. Capture every encrypted blob under the org while the OLD provider
 *      is still active in the process — decrypt to plaintext.
 *   2. Caller-supplied callback flips the kmsConfig + evicts the per-org
 *      cache so the NEW provider is what `encryptSecret` resolves to.
 *   3. Re-encrypt every plaintext and write back.
 *
 * Failure mode: the helper aborts mid-phase only by throwing. The caller
 * holds the transaction boundary; the PUT controller wraps this in a
 * try/catch and on failure reverts the kmsConfig change so the org isn't
 * left in a half-rotated state.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { Organization } from '../models/index.js';
import OrgIdpConfig from '../models/org-idp-config.js';
import { unwrapEncrypted, wrapEncrypted } from '../utils/secret-blob.js';

const logger = createLogger('secret-reencrypt');

const AI_PROVIDERS = ['anthropic', 'openai', 'google', 'xai', 'amazon-bedrock'] as const;

interface CapturedSecrets {
  /** Provider name → plaintext API key. */
  aiKeys: Partial<Record<string, string>>;
  /** Decrypted IdP client secret, if the org has one configured. */
  idpClientSecret?: string;
}

/**
 * Phase 1 — Capture decrypted plaintexts for every at-rest secret on the
 * org. Run BEFORE the operator flips the kmsConfig; this is the last
 * moment the OLD wrapping is still valid.
 */
export async function captureOrgSecrets(orgId: string): Promise<CapturedSecrets> {
  const captured: CapturedSecrets = { aiKeys: {} };

  const org = await Organization.findById(orgId).select('aiProviderKeys').lean();
  if (org?.aiProviderKeys) {
    for (const provider of AI_PROVIDERS) {
      const raw = (org.aiProviderKeys as Record<string, string | undefined>)[provider];
      if (!raw) continue;
      try {
        captured.aiKeys[provider] = unwrapEncrypted(raw, orgId, `aiProviderKeys.${provider}`);
      } catch (err) {
        throw new Error(`Failed to decrypt aiProviderKeys.${provider} for org ${orgId} (cannot proceed with rotation without first repairing this row): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const idp = await OrgIdpConfig.findOne({ orgId }).select('clientSecretEncrypted').lean();
  if (idp?.clientSecretEncrypted) {
    try {
      captured.idpClientSecret = unwrapEncrypted(idp.clientSecretEncrypted, orgId, 'idpClientSecret');
    } catch (err) {
      throw new Error(`Failed to decrypt IdP clientSecret for org ${orgId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return captured;
}

/**
 * Phase 3 — Re-encrypt the captured plaintexts under whatever provider is
 * active when this is called. Run AFTER the operator has updated the
 * kmsConfig (and evicted the per-org cache).
 *
 * Returns counts so the caller can include them in the audit log.
 */
export async function reencryptOrgSecrets(orgId: string, captured: CapturedSecrets): Promise<{ aiKeysReencrypted: number; idpSecretReencrypted: boolean }> {
  let aiKeysReencrypted = 0;
  let idpSecretReencrypted = false;

  const orgDoc = await Organization.findById(orgId);
  if (orgDoc && Object.keys(captured.aiKeys).length > 0) {
    if (!orgDoc.aiProviderKeys) orgDoc.aiProviderKeys = {};
    for (const [provider, plaintext] of Object.entries(captured.aiKeys)) {
      if (!plaintext) continue;
      (orgDoc.aiProviderKeys as Record<string, string | undefined>)[provider] = wrapEncrypted(plaintext, orgId);
      aiKeysReencrypted++;
    }
    orgDoc.markModified('aiProviderKeys');
    await orgDoc.save();
  }

  if (captured.idpClientSecret) {
    const wrapped = wrapEncrypted(captured.idpClientSecret, orgId);
    await OrgIdpConfig.updateOne({ orgId }, { $set: { clientSecretEncrypted: wrapped } });
    idpSecretReencrypted = true;
  }

  logger.info('Re-encrypted org secrets under new provider', { orgId, aiKeysReencrypted, idpSecretReencrypted });
  return { aiKeysReencrypted, idpSecretReencrypted };
}
