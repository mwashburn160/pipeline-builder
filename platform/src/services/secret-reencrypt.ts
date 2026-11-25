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
 * The migration runs in three phases:
 *   1. {@link captureOrgSecrets}: decrypt every blob under the org while the
 *      OLD provider is still active in the process.
 *   2. The caller (controllers/org-kms-config.ts) saves the new kmsConfig and
 *      evicts the per-org cache, so `encryptSecret` resolves to the NEW provider.
 *   3. {@link reencryptOrgSecrets}: wrap every plaintext under the new provider,
 *      THEN write them back.
 *
 * Failure mode: phase 3 throws an {@link OrgSecretsReencryptError} whose
 * `written` says whether any row was touched. Wrapping everything before the
 * first write means a KMS failure under the new config (the likely one) leaves
 * nothing written, so the caller can restore the previous config cleanly.
 *
 * {@link reencryptAllStoredSecrets} is the fleet-wide variant used by a
 * `SECRET_ENCRYPTION_KEY` rotation (scripts/reencrypt-secrets.ts) rather than a
 * per-org KMS swap: it rewrites EVERY stored blob under the currently-active
 * key, reading each one through the `SECRET_ENCRYPTION_KEY_PREVIOUS` fallback
 * that api-core's `decryptSecret` applies during the overlap window.
 */

import { AI_KEY_PROVIDER_IDS, createLogger, errorMessage } from '@pipeline-builder/api-core';
import { toOrgId } from '../helpers/org-id.js';
import { Organization, UserTotp } from '../models/index.js';
import OrgIdpConfig from '../models/org-idp-config.js';
import SamlSpKey from '../models/saml-sp-key.js';
import { unwrapEncrypted, wrapEncrypted } from '../utils/secret-blob.js';

const logger = createLogger('secret-reencrypt');

/** The org-key providers (catalog-derived) whose stored keys this re-wraps. */
const AI_PROVIDERS = AI_KEY_PROVIDER_IDS;

/** Encryption context the SAML SP keys are wrapped under (services/saml-sp-keys.ts). */
const SAML_SP_SECRET_CONTEXT = 'saml-sp-keys';

interface CapturedSecrets {
  /** Provider name → plaintext API key. */
  aiKeys: Partial<Record<string, string>>;
  /** Decrypted IdP client secret, if the org has one configured. */
  idpClientSecret?: string;
  /**
   * The exact stored (encrypted) blobs the plaintexts were read from. Phase 3
   * writes each re-wrapped secret only where its field still holds this value,
   * so a secret set or deleted in between is never overwritten or resurrected.
   */
  blobs: {
    aiKeys: Partial<Record<string, string>>;
    idpClientSecret?: string;
  };
}

/**
 * Phase 1 — Capture decrypted plaintexts for every at-rest secret on the
 * org. Run BEFORE the operator flips the kmsConfig; this is the last
 * moment the OLD wrapping is still valid.
 */
export async function captureOrgSecrets(orgId: string): Promise<CapturedSecrets> {
  const captured: CapturedSecrets = { aiKeys: {}, blobs: { aiKeys: {} } };

  const org = await Organization.findById(toOrgId(orgId)).select('aiProviderKeys').lean();
  if (org?.aiProviderKeys) {
    for (const provider of AI_PROVIDERS) {
      const raw = (org.aiProviderKeys as Record<string, string | undefined>)[provider];
      if (!raw) continue;
      try {
        captured.aiKeys[provider] = await unwrapEncrypted(raw, orgId, `aiProviderKeys.${provider}`);
        captured.blobs.aiKeys[provider] = raw;
      } catch (err) {
        throw new Error(`Failed to decrypt aiProviderKeys.${provider} for org ${orgId} (cannot proceed with rotation without first repairing this row): ${errorMessage(err)}`);
      }
    }
  }

  const idp = await OrgIdpConfig.findOne({ organizationId: orgId }).select('clientSecretEncrypted').lean();
  if (idp?.clientSecretEncrypted) {
    try {
      captured.idpClientSecret = await unwrapEncrypted(idp.clientSecretEncrypted, orgId, 'idpClientSecret');
      captured.blobs.idpClientSecret = idp.clientSecretEncrypted;
    } catch (err) {
      throw new Error(`Failed to decrypt IdP clientSecret for org ${orgId}: ${errorMessage(err)}`);
    }
  }

  return captured;
}

/**
 * The post-change verification (services/kms-config-verify.ts): try to decrypt
 * every secret {@link captureOrgSecrets} covers under whatever provider is
 * active now, and name each one that does not open. Unlike the capture it never
 * stops at the first failure — the operator and the org's admins need the whole
 * list. Field names only (`aiProviderKeys.<provider>`, `idpClientSecret`), never
 * a value or the decrypt error. A database error still throws.
 */
export async function findUnreadableOrgSecrets(orgId: string): Promise<string[]> {
  const unreadable: string[] = [];
  const opens = async (raw: string, field: string): Promise<void> => {
    try {
      await unwrapEncrypted(raw, orgId, field);
    } catch {
      unreadable.push(field);
    }
  };

  const org = await Organization.findById(toOrgId(orgId)).select('aiProviderKeys').lean();
  const keys = (org?.aiProviderKeys ?? {}) as Record<string, string | undefined>;
  for (const provider of AI_PROVIDERS) {
    const raw = keys[provider];
    if (raw) await opens(raw, `aiProviderKeys.${provider}`);
  }

  const idp = await OrgIdpConfig.findOne({ organizationId: orgId }).select('clientSecretEncrypted').lean();
  if (idp?.clientSecretEncrypted) await opens(idp.clientSecretEncrypted, 'idpClientSecret');

  return unreadable;
}

/**
 * Thrown by {@link reencryptOrgSecrets}. `written` is false when it failed
 * before writing anything — every stored blob is still the one captured under
 * the OLD provider, so restoring the previous config leaves the org consistent.
 * Once a write has been attempted it is true, and a restore would strand what
 * was written under the new config. A conditional write that missed (the secret
 * changed meanwhile) writes nothing; it sets `written` only when the concurrent
 * value is itself under the new config, which a restore would strand too.
 */
export class OrgSecretsReencryptError extends Error {
  constructor(message: string, readonly written: boolean) {
    super(message);
    this.name = 'OrgSecretsReencryptError';
  }
}

/** What {@link reencryptOrgSecrets} did — field names only, never values. */
export interface OrgSecretsReencryptResult {
  aiKeysReencrypted: number;
  idpSecretReencrypted: boolean;
  /**
   * Fields (`aiProviderKeys.<provider>`, `idpClientSecret`) that no longer held
   * the captured blob at write time: set, replaced or deleted by a concurrent
   * writer. Left as that writer left them — never overwritten or resurrected.
   */
  concurrentlyChanged: string[];
  /**
   * The subset of {@link concurrentlyChanged} whose concurrent value does NOT
   * decrypt under the now-active provider: written by a replica still holding
   * the outgoing key (before the eviction reached it, or within the cache TTL).
   * This pass cannot open it, so the secret must be re-entered.
   */
  unreadableConcurrentWrites: string[];
}

/**
 * Phase 3 — Re-encrypt the captured plaintexts under whatever provider is
 * active when this is called. Run AFTER the operator has updated the
 * kmsConfig (and evicted the per-org cache). Every value is wrapped before
 * any is written; failures throw {@link OrgSecretsReencryptError}.
 *
 * Each secret is written with its own conditional update, filtered on the
 * exact blob it was captured from. A miss means the secret changed since the
 * capture; it is reported in `concurrentlyChanged` and left alone. Its current
 * value is then checked against the new provider: a writer that had already
 * picked up the new config wrapped it under the new key (nothing to do), but a
 * replica whose cache still held the outgoing key wrapped it under the OLD one,
 * which nothing can now open — that lands in `unreadableConcurrentWrites`.
 *
 * Returns counts so the caller can include them in the audit log.
 */
export async function reencryptOrgSecrets(orgId: string, captured: CapturedSecrets): Promise<OrgSecretsReencryptResult> {
  let written = false;
  const concurrentlyChanged: string[] = [];
  const unreadableConcurrentWrites: string[] = [];

  /** A conditional write missed: classify the value a concurrent writer left. */
  const noteConcurrentChange = async (field: string, current: string | undefined): Promise<void> => {
    concurrentlyChanged.push(field);
    if (!current) {
      logger.warn('Secret removed during KMS re-encryption; not restoring it', { orgId, field });
      return;
    }
    try {
      await unwrapEncrypted(current, orgId, field);
      // The store now holds a blob only the NEW config opens, so restoring the
      // previous config after a later failure would strand it.
      written = true;
      logger.warn('Secret changed during KMS re-encryption; kept the concurrent value (already under the new key)', { orgId, field });
    } catch (err) {
      unreadableConcurrentWrites.push(field);
      logger.error('Secret changed during KMS re-encryption under a key the new config cannot open; it must be re-entered', {
        orgId, field, error: errorMessage(err),
      });
    }
  };

  /** Run one conditional write; true when it matched. */
  const conditionalWrite = async (write: () => Promise<{ matchedCount?: number }>): Promise<boolean> => {
    const before = written;
    written = true; // a throw mid-write may still have landed
    const result = await write();
    if (result.matchedCount === 0) {
      written = before;
      return false;
    }
    return true;
  };

  try {
    const aiKeys: Array<{ provider: string; blob: string; wrapped: string }> = [];
    for (const [provider, plaintext] of Object.entries(captured.aiKeys)) {
      const blob = captured.blobs.aiKeys[provider];
      if (plaintext && blob) aiKeys.push({ provider, blob, wrapped: await wrapEncrypted(plaintext, orgId) });
    }
    const idpBlob = captured.blobs.idpClientSecret;
    const idpWrapped = captured.idpClientSecret && idpBlob ? await wrapEncrypted(captured.idpClientSecret, orgId) : undefined;

    let aiKeysReencrypted = 0;
    const missedAiKeys: string[] = [];
    for (const { provider, blob, wrapped } of aiKeys) {
      const path = `aiProviderKeys.${provider}`;
      const matched = await conditionalWrite(() => Organization.updateOne(
        { _id: toOrgId(orgId), [path]: blob },
        { $set: { [path]: wrapped } },
      ));
      if (matched) aiKeysReencrypted++;
      else missedAiKeys.push(provider);
    }
    if (missedAiKeys.length > 0) {
      const org = await Organization.findById(toOrgId(orgId)).select('aiProviderKeys').lean();
      const current = (org?.aiProviderKeys ?? {}) as Record<string, string | undefined>;
      for (const provider of missedAiKeys) await noteConcurrentChange(`aiProviderKeys.${provider}`, current[provider]);
    }

    let idpSecretReencrypted = false;
    if (idpWrapped) {
      idpSecretReencrypted = await conditionalWrite(() => OrgIdpConfig.updateOne(
        { organizationId: orgId, clientSecretEncrypted: idpBlob },
        { $set: { clientSecretEncrypted: idpWrapped } },
      ));
      if (!idpSecretReencrypted) {
        const idp = await OrgIdpConfig.findOne({ organizationId: orgId }).select('clientSecretEncrypted').lean();
        await noteConcurrentChange('idpClientSecret', idp?.clientSecretEncrypted);
      }
    }

    const result = { aiKeysReencrypted, idpSecretReencrypted, concurrentlyChanged, unreadableConcurrentWrites };
    logger.info('Re-encrypted org secrets under new provider', { orgId, ...result });
    return result;
  } catch (err) {
    throw new OrgSecretsReencryptError(errorMessage(err), written);
  }
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
 * harmless. Every write is conditional on the exact blob read, so a secret a
 * live writer sets, replaces or removes mid-sweep is kept as it left it (it
 * wrote under the current key) — never overwritten with or resurrected from
 * the stale read. A row that cannot be decrypted is RECORDED, not thrown — one
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

  /** One row's conditional write; true when it matched. A miss means a live
   *  writer replaced or removed the blob since it was read — that writer used
   *  the current key, so its value is kept and the row is simply not counted. */
  const writeIfUnchanged = async (field: string, write: () => Promise<{ matchedCount?: number }>): Promise<boolean> => {
    if ((await write()).matchedCount !== 0) return true;
    logger.warn('Secret changed during fleet-wide re-encryption; kept the concurrent value', { field });
    return false;
  };

  for await (const org of Organization.find({}).select('aiProviderKeys').lean().cursor()) {
    summary.orgsScanned++;
    const orgId = String(org._id);
    const keys = (org.aiProviderKeys ?? {}) as Record<string, string | undefined>;
    for (const provider of AI_PROVIDERS) {
      const raw = keys[provider];
      if (!raw) continue;
      const path = `aiProviderKeys.${provider}`;
      try {
        const wrapped = await wrapEncrypted(await unwrapEncrypted(raw, orgId, path), orgId);
        if (await writeIfUnchanged(path, () => Organization.updateOne({ _id: org._id, [path]: raw }, { $set: { [path]: wrapped } }))) {
          summary.aiKeysReencrypted++;
        }
      } catch (err) {
        summary.failures.push({ orgId, field: path, error: errorMessage(err) });
      }
    }
  }

  for await (const idp of OrgIdpConfig.find({}).select('organizationId clientSecretEncrypted').lean().cursor()) {
    const raw = idp.clientSecretEncrypted;
    if (!raw) continue;
    const orgId = String(idp.organizationId);
    try {
      const wrapped = await wrapEncrypted(await unwrapEncrypted(raw, orgId, 'idpClientSecret'), orgId);
      if (await writeIfUnchanged('idpClientSecret', () => OrgIdpConfig.updateOne(
        { _id: idp._id, clientSecretEncrypted: raw },
        { $set: { clientSecretEncrypted: wrapped } },
      ))) summary.idpSecretsReencrypted++;
    } catch (err) {
      summary.failures.push({ orgId, field: 'idpClientSecret', error: errorMessage(err) });
    }
  }

  // Authenticator secrets are salted `user:<userId>`, NOT by org — a TOTP row
  // has no org at all, so it can only be found by sweeping the collection.
  // `select('+secret')` is required: the field is `select: false` by default.
  // The write is conditional on the secret read: a user who re-enrols mid-sweep
  // keeps the new secret instead of having it replaced by the old one.
  for await (const totp of UserTotp.find({}).select('+secret userId').lean().cursor()) {
    const scope = `user:${String(totp.userId)}`;
    const raw = totp.secret;
    if (!raw) continue;
    try {
      const wrapped = await wrapEncrypted(await unwrapEncrypted(raw, scope, 'totp.secret'), scope);
      if (await writeIfUnchanged('totp.secret', () => UserTotp.updateOne({ _id: totp._id, secret: raw }, { $set: { secret: wrapped } }))) {
        summary.totpSecretsReencrypted++;
      }
    } catch (err) {
      summary.failures.push({ orgId: scope, field: 'totp.secret', error: errorMessage(err) });
    }
  }

  // The SAML SP signing/encryption keys are deployment-wide (salt `saml-sp-keys`),
  // so they belong to no org either. Losing these unreadable would break every
  // org's SAML connection at once, with no way to re-enter the value by hand.
  for await (const key of SamlSpKey.find({}).lean().cursor()) {
    const raw = key.privateKeyEncrypted;
    if (!raw) continue;
    const field = `saml-sp.${String(key._id)}`;
    try {
      const wrapped = await wrapEncrypted(await unwrapEncrypted(raw, SAML_SP_SECRET_CONTEXT, field), SAML_SP_SECRET_CONTEXT);
      if (await writeIfUnchanged(field, () => SamlSpKey.updateOne(
        { _id: key._id, privateKeyEncrypted: raw },
        { $set: { privateKeyEncrypted: wrapped } },
      ))) summary.samlSpKeysReencrypted++;
    } catch (err) {
      summary.failures.push({ orgId: SAML_SP_SECRET_CONTEXT, field, error: errorMessage(err) });
    }
  }

  logger.info('Fleet-wide secret re-encryption finished', { ...summary, failures: summary.failures.length });
  return summary;
}
