// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * One-shot backfill for clear-text secrets on Organization.aiProviderKeys
 * and OrgIdpConfig.clientSecretEncrypted.
 *
 * Background: prior to mandatory secret encryption, both fields could hold
 * either a clear-text string (when SECRET_ENCRYPTION_KEY was unset on the
 * env that wrote the document) OR a JSON-stringified EncryptedBlob. The
 * read paths used a permissive "if it's not a blob, return raw" fallback —
 * which is the back-compat shim we're removing.
 *
 * Before flipping the read paths to encrypted-only, every existing
 * clear-text record needs to be re-saved as encrypted. This module is
 * that migration. It runs at platform startup, AFTER the per-org KMS
 * provider has been installed (so backfills land under the right
 * provider) and BEFORE the read paths can serve traffic that would hit
 * the fallback.
 *
 * Idempotent — re-saving an already-encrypted record is a no-op (the
 * detection uses the same `isEncryptedBlob` shape check the read path
 * uses). Safe to run on every boot. Operationally one boot is enough to
 * clear the corpus; subsequent boots see zero clear-text records and
 * complete in milliseconds.
 */

import { createLogger, isEncryptedBlob } from '@pipeline-builder/api-core';
import { Organization } from '../models';
import OrgIdpConfig from '../models/org-idp-config';
import { looksEncrypted as looksLikeBlobShape, wrapEncrypted } from '../utils/secret-blob';

const logger = createLogger('secret-backfill');

/** Names of the AI provider key slots on Organization. */
const AI_PROVIDERS = ['anthropic', 'openai', 'google', 'xai', 'amazon-bedrock'] as const;

/** Backfill-grade encryption probe: the shared `looksEncrypted` does the
 *  cheap `startsWith('{')` check, but the migration must also confirm the
 *  JSON actually parses to an `EncryptedBlob` shape so we don't double-
 *  encrypt a clear-text value that merely happens to begin with `{`. */
function isAlreadyEncrypted(raw: string | undefined): boolean {
  if (!raw || !looksLikeBlobShape(raw)) return false;
  try {
    return isEncryptedBlob(JSON.parse(raw));
  } catch {
    return false;
  }
}

interface BackfillResult {
  aiKeysScanned: number;
  aiKeysEncrypted: number;
  idpSecretsScanned: number;
  idpSecretsEncrypted: number;
}

/**
 * Re-encrypt every clear-text secret in the platform's Mongo collections.
 *
 * Two collections are touched:
 *   - `organizations.aiProviderKeys` — per-provider AI keys (5 slots per org)
 *   - `org_idp_configs.clientSecretEncrypted` — OAuth client secrets per IdP
 *
 * Both are written in-place; the field shape stays the same string, just
 * with the contents changed from raw to JSON-stringified EncryptedBlob.
 */
export async function backfillSecrets(): Promise<BackfillResult> {
  const result: BackfillResult = {
    aiKeysScanned: 0,
    aiKeysEncrypted: 0,
    idpSecretsScanned: 0,
    idpSecretsEncrypted: 0,
  };

  // ----- AI provider keys -----
  // Stream organizations one-at-a-time so a fleet of thousands doesn't
  // hold the entire collection in memory. Mongo's cursor iteration is
  // event-loop friendly and a single Bookmark restarts after a crash.
  const orgCursor = Organization.find({}, { _id: 1, aiProviderKeys: 1 }).cursor();
  for await (const org of orgCursor) {
    const keys = (org as { aiProviderKeys?: Record<string, string | undefined> }).aiProviderKeys;
    if (!keys) continue;

    let dirty = false;
    for (const provider of AI_PROVIDERS) {
      const raw = keys[provider];
      if (!raw) continue;
      result.aiKeysScanned++;
      if (isAlreadyEncrypted(raw)) continue;
      keys[provider] = wrapEncrypted(raw, String(org._id));
      result.aiKeysEncrypted++;
      dirty = true;
    }

    if (dirty) {
      // Direct $set bypasses the schema validator's `markModified` quirk on
      // Map-typed fields; we know exactly what we're writing.
      await Organization.updateOne({ _id: org._id }, { $set: { aiProviderKeys: keys } });
    }
  }

  // ----- IdP client secrets -----
  const idpCursor = OrgIdpConfig.find({}, { _id: 1, orgId: 1, clientSecretEncrypted: 1 }).cursor();
  for await (const doc of idpCursor) {
    const raw = (doc as { clientSecretEncrypted?: string }).clientSecretEncrypted;
    if (!raw) continue;
    result.idpSecretsScanned++;
    if (isAlreadyEncrypted(raw)) continue;

    const orgId = (doc as { orgId: string }).orgId;
    const encrypted = wrapEncrypted(raw, orgId);
    await OrgIdpConfig.updateOne({ _id: doc._id }, { $set: { clientSecretEncrypted: encrypted } });
    result.idpSecretsEncrypted++;
  }

  if (result.aiKeysEncrypted > 0 || result.idpSecretsEncrypted > 0) {
    logger.warn('Backfilled clear-text secrets to encrypted form', result);
  } else {
    logger.info('Secret backfill: no clear-text records found', result);
  }

  return result;
}
