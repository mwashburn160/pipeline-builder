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
 *
 * {@link reencryptAllStoredSecrets} is the fleet-wide variant used by a
 * `SECRET_ENCRYPTION_KEY` rotation (scripts/reencrypt-secrets.ts) rather than a
 * per-org KMS swap: it rewrites EVERY stored blob under the currently-active
 * key, reading each one through the `SECRET_ENCRYPTION_KEY_PREVIOUS` fallback
 * that api-core's `decryptSecret` applies during the overlap window.
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { toOrgId } from '../helpers/org-id.js';
import { Organization, UserTotp } from '../models/index.js';
import OrgIdpConfig from '../models/org-idp-config.js';
import SamlSpKey from '../models/saml-sp-key.js';
import { unwrapEncrypted, wrapEncrypted } from '../utils/secret-blob.js';

const logger = createLogger('secret-reencrypt');

const AI_PROVIDERS = ['anthropic', 'openai', 'google', 'xai', 'amazon-bedrock'] as const;

/** Encryption context the SAML SP keys are wrapped under (services/saml-sp-keys.ts). */
const SAML_SP_SECRET_CONTEXT = 'saml-sp-keys';

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

  const org = await Organization.findById(toOrgId(orgId)).select('aiProviderKeys').lean();
  if (org?.aiProviderKeys) {
    for (const provider of AI_PROVIDERS) {
      const raw = (org.aiProviderKeys as Record<string, string | undefined>)[provider];
      if (!raw) continue;
      try {
        captured.aiKeys[provider] = await unwrapEncrypted(raw, orgId, `aiProviderKeys.${provider}`);
      } catch (err) {
        throw new Error(`Failed to decrypt aiProviderKeys.${provider} for org ${orgId} (cannot proceed with rotation without first repairing this row): ${errorMessage(err)}`);
      }
    }
  }

  const idp = await OrgIdpConfig.findOne({ organizationId: orgId }).select('clientSecretEncrypted').lean();
  if (idp?.clientSecretEncrypted) {
    try {
      captured.idpClientSecret = await unwrapEncrypted(idp.clientSecretEncrypted, orgId, 'idpClientSecret');
    } catch (err) {
      throw new Error(`Failed to decrypt IdP clientSecret for org ${orgId}: ${errorMessage(err)}`);
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

  const orgDoc = await Organization.findById(toOrgId(orgId));
  if (orgDoc && Object.keys(captured.aiKeys).length > 0) {
    if (!orgDoc.aiProviderKeys) orgDoc.aiProviderKeys = {};
    for (const [provider, plaintext] of Object.entries(captured.aiKeys)) {
      if (!plaintext) continue;
      (orgDoc.aiProviderKeys as Record<string, string | undefined>)[provider] = await wrapEncrypted(plaintext, orgId);
      aiKeysReencrypted++;
    }
    orgDoc.markModified('aiProviderKeys');
    await orgDoc.save();
  }

  if (captured.idpClientSecret) {
    const wrapped = await wrapEncrypted(captured.idpClientSecret, orgId);
    await OrgIdpConfig.updateOne({ organizationId: orgId }, { $set: { clientSecretEncrypted: wrapped } });
    idpSecretReencrypted = true;
  }

  logger.info('Re-encrypted org secrets under new provider', { orgId, aiKeysReencrypted, idpSecretReencrypted });
  return { aiKeysReencrypted, idpSecretReencrypted };
}

/** Per-row outcome counts for a fleet-wide re-encryption run. */
export interface ReencryptAllSummary {
  orgsScanned: number;
  aiKeysReencrypted: number;
  idpSecretsReencrypted: number;
  /** Authenticator-app secrets (`UserTotp.secret`), keyed by user, not org. */
  totpSecretsReencrypted: number;
  /** SAML service-provider private keys (`SamlSpKey.privateKeyEncrypted`). */
  samlSpKeysReencrypted: number;
  /** Rows that could not be decrypted (neither current nor previous key) — each
   *  needs the operator to re-enter the secret. Non-fatal for the rest of the run.
   *  `orgId` carries the owning scope: an org id, `user:<id>` for a TOTP row, or
   *  `saml-sp-keys` for the SP identity. */
  failures: Array<{ orgId: string; field: string; error: string }>;
}

/**
 * Re-encrypt EVERY stored secret under the currently-active key provider.
 *
 * Run during a `SECRET_ENCRYPTION_KEY` rotation, while the outgoing key is
 * still set as `SECRET_ENCRYPTION_KEY_PREVIOUS`: each read falls back to the
 * previous key when needed, each write uses the new one. When it reports zero
 * failures, the previous key can be removed.
 *
 * Idempotent: re-running re-wraps the same plaintexts (fresh IVs), which is
 * harmless. A row that cannot be decrypted is RECORDED, not thrown — one
 * unreadable secret must not stop the other orgs from being migrated — and the
 * caller (the script) exits non-zero so the failure is never a silent green.
 *
 * Covers EVERY blob the platform wraps with the master key:
 * `Organization.aiProviderKeys.*`, `OrgIdpConfig.clientSecretEncrypted`,
 * `UserTotp.secret` (salt `user:<userId>`) and `SamlSpKey.privateKeyEncrypted`
 * (salt `saml-sp-keys`). Missing any of these was a live foot-gun: the sweep
 * reported success, the operator dropped `SECRET_ENCRYPTION_KEY_PREVIOUS`, and
 * every authenticator enrolment and the SAML SP identity became unreadable.
 * A per-org KMS `kmsConfig.ciphertextBase64` is deliberately NOT here — that
 * blob is wrapped by the org's CMK, not by this key, and is migrated by the
 * per-org rotation path above.
 * Soft-deleted orgs are included deliberately: they can still be restored.
 */
export async function reencryptAllStoredSecrets(): Promise<ReencryptAllSummary> {
  const summary: ReencryptAllSummary = {
    orgsScanned: 0,
    aiKeysReencrypted: 0,
    idpSecretsReencrypted: 0,
    totpSecretsReencrypted: 0,
    samlSpKeysReencrypted: 0,
    failures: [],
  };

  for await (const org of Organization.find({}).select('aiProviderKeys').cursor()) {
    summary.orgsScanned++;
    const orgId = org._id.toString();
    const keys = org.aiProviderKeys as Record<string, string | undefined> | undefined;
    if (!keys) continue;
    let modified = false;
    for (const provider of AI_PROVIDERS) {
      const raw = keys[provider];
      if (!raw) continue;
      try {
        const plaintext = await unwrapEncrypted(raw, orgId, `aiProviderKeys.${provider}`);
        keys[provider] = await wrapEncrypted(plaintext, orgId);
        modified = true;
        summary.aiKeysReencrypted++;
      } catch (err) {
        summary.failures.push({ orgId, field: `aiProviderKeys.${provider}`, error: errorMessage(err) });
      }
    }
    if (modified) {
      org.markModified('aiProviderKeys');
      await org.save();
    }
  }

  for await (const idp of OrgIdpConfig.find({}).select('organizationId clientSecretEncrypted').cursor()) {
    if (!idp.clientSecretEncrypted) continue;
    const orgId = String(idp.organizationId);
    try {
      const plaintext = await unwrapEncrypted(idp.clientSecretEncrypted, orgId, 'idpClientSecret');
      await OrgIdpConfig.updateOne({ _id: idp._id }, { $set: { clientSecretEncrypted: await wrapEncrypted(plaintext, orgId) } });
      summary.idpSecretsReencrypted++;
    } catch (err) {
      summary.failures.push({ orgId, field: 'idpClientSecret', error: errorMessage(err) });
    }
  }

  // Authenticator secrets are salted `user:<userId>`, NOT by org — a TOTP row
  // has no org at all, so it can only be found by sweeping the collection.
  // `select('+secret')` is required: the field is `select: false` by default.
  for await (const totp of UserTotp.find({}).select('+secret userId').cursor()) {
    const scope = `user:${String(totp.userId)}`;
    if (!totp.secret) continue;
    try {
      const plaintext = await unwrapEncrypted(totp.secret, scope, 'totp.secret');
      await UserTotp.updateOne({ _id: totp._id }, { $set: { secret: await wrapEncrypted(plaintext, scope) } });
      summary.totpSecretsReencrypted++;
    } catch (err) {
      summary.failures.push({ orgId: scope, field: 'totp.secret', error: errorMessage(err) });
    }
  }

  // The SAML SP signing/encryption keys are deployment-wide (salt `saml-sp-keys`),
  // so they belong to no org either. Losing these unreadable would break every
  // org's SAML connection at once, with no way to re-enter the value by hand.
  for await (const key of SamlSpKey.find({}).cursor()) {
    if (!key.privateKeyEncrypted) continue;
    try {
      const plaintext = await unwrapEncrypted(key.privateKeyEncrypted, SAML_SP_SECRET_CONTEXT, `saml-sp.${String(key._id)}`);
      await SamlSpKey.updateOne(
        { _id: key._id },
        { $set: { privateKeyEncrypted: await wrapEncrypted(plaintext, SAML_SP_SECRET_CONTEXT) } },
      );
      summary.samlSpKeysReencrypted++;
    } catch (err) {
      summary.failures.push({
        orgId: SAML_SP_SECRET_CONTEXT,
        field: `saml-sp.${String(key._id)}`,
        error: errorMessage(err),
      });
    }
  }

  logger.info('Fleet-wide secret re-encryption finished', { ...summary, failures: summary.failures.length });
  return summary;
}
