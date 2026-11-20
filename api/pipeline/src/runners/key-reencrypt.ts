// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Re-encrypt `pipeline_runner_signing_keys.private_key_enc` after a master-key
 * rotation (platform's secret re-encrypt covers MongoDB only).
 *
 *  - No `orgId`: every non-retired row, after a `SECRET_ENCRYPTION_KEY` (or KMS
 *    master) rotation. Reads fall back to `SECRET_ENCRYPTION_KEY_PREVIOUS` as
 *    `decryptSecret` does; writes use the current provider.
 *  - `orgId`: that org's rows, after its per-org KMS config changed. Reads use
 *    a provider over `previousKmsConfig` (or the shared provider when it is
 *    null); the cached config is dropped first, so writes use the new one.
 *
 * Each row is rewritten in its own transaction (re-read `FOR UPDATE`, version
 * bumped). A row that fails is left untouched and reported (kid and a short
 * reason, never key material). One `keys` invalidation per affected org.
 */

import { actorId, decryptSecret, encryptSecret, errorMessage, getDefaultKeyProvider, isEncryptedBlob, PerOrgKmsKeyProvider, SYSTEM_ORG_ID, type KeyProvider, type PerOrgKmsConfig } from '@pipeline-builder/api-core';
import type { RunnerDeps } from './deps.js';
import { baseKeyProvider, evictOrgKms } from './key-crypto.js';

export interface ReencryptInput {
  orgId?: string;
  previousKmsConfig?: PerOrgKmsConfig | null;
}

export interface ReencryptResult {
  scanned: number;
  reencrypted: number;
  failures: Array<{ orgId: string; kid: string; error: string }>;
}

/** Providers for one run (injectable for tests). */
export interface ReencryptProviders {
  /** Decrypts the existing blob. */
  read: KeyProvider;
  /** Encrypts the new blob. */
  write: KeyProvider;
}

/** The read/write providers for an input, per the module comment. */
export function reencryptProviders(input: ReencryptInput): ReencryptProviders {
  const current = getDefaultKeyProvider();
  if (!input.orgId) return { read: current, write: current };
  evictOrgKms(input.orgId);
  const base = baseKeyProvider() ?? current;
  const read = input.previousKmsConfig
    ? new PerOrgKmsKeyProvider({ resolver: async () => input.previousKmsConfig ?? null, fallback: base })
    : base;
  return { read, write: getDefaultKeyProvider() };
}

/** A short, material-free reason for a failed row. */
function reasonOf(err: unknown): string {
  const m = errorMessage(err);
  if (/mismatch/i.test(m)) return 'kms key id mismatch';
  if (/authenticate|auth tag|unable to/i.test(m)) return 'decrypt failed';
  return m.slice(0, 120);
}

export async function reencryptRunnerKeys(deps: RunnerDeps, input: ReencryptInput = {}, providers: ReencryptProviders = reencryptProviders(input)): Promise<ReencryptResult> {
  const orgId = input.orgId?.toLowerCase();
  const rows = await deps.keyStore.encryptedKeyIds(orgId);
  const result: ReencryptResult = { scanned: rows.length, reencrypted: 0, failures: [] };
  const affected = new Set<string>();
  for (const { id, orgId: rowOrg, kid } of rows) {
    try {
      const changed = await deps.keyStore.transaction(async (tx) => {
        const row = await tx.lockKeyById(id);
        if (!row || row.state === 'retired' || !row.privateKeyEnc) return false;
        const blob: unknown = JSON.parse(row.privateKeyEnc);
        if (!isEncryptedBlob(blob)) throw new Error('stored key is not an encrypted blob');
        const pem = await decryptSecret(blob, row.orgId, providers.read);
        const next = JSON.stringify(await encryptSecret(pem, row.orgId, providers.write));
        await tx.updateKey(row.id, { privateKeyEnc: next });
        return true;
      });
      if (changed) { result.reencrypted++; affected.add(rowOrg.toLowerCase()); }
    } catch (err) {
      result.failures.push({ orgId: rowOrg, kid, error: reasonOf(err) });
    }
  }
  for (const org of affected) deps.publishKeyInvalidation({ kind: 'keys', orgIds: [org] });
  deps.audit({
    action: 'pipeline.runner.key.reencrypt',
    actorId: actorId({ userId: null }),
    orgId: SYSTEM_ORG_ID,
    ...(orgId ? { affectedOrgId: orgId } : {}),
    targetType: 'organization',
    targetId: orgId ?? '*',
    ...(result.failures.length > 0 ? { outcome: 'failure' as const } : {}),
    details: { scanned: result.scanned, reencrypted: result.reencrypted, failed: result.failures.length },
  });
  return result;
}
