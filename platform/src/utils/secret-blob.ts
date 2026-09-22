// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Single source of truth for encrypted-secret-blob storage, shared by the
 * secret-handling services (`organization-service`, `org-idp-service`,
 * `secret-reencrypt`) so the JSON-wrap-around-EncryptedBlob format cannot
 * drift between writer and reader and silently break the round-trip.
 *
 * `SECRET_ENCRYPTION_KEY` is a hard requirement at platform boot (see
 * `config/index.ts`); reaching `wrapEncrypted` without it set is a
 * programmer error and the underlying `encryptSecret` throws.
 *
 * Both helpers are ASYNC because the underlying api-core primitives are: a
 * per-org KMS provider needs one KMS Decrypt the first time it sees an org, and
 * deriving a key before that resolves would silently encrypt under the shared
 * master and make the secret unreadable afterwards.
 */

import { type EncryptedBlob, decryptSecret, encryptSecret, isEncryptedBlob, errorMessage } from '@pipeline-builder/api-core';

/**
 * Quick heuristic — does this raw string look like one of our stored
 * encrypted blobs (a JSON object) rather than clear-text? Used by the
 * reencrypt job to skip rows that are already encrypted.
 * Does NOT validate the blob structure; use {@link unwrapEncrypted} for that.
 */
export function looksEncrypted(raw: string): boolean {
  return typeof raw === 'string' && raw.startsWith('{');
}

/**
 * Encrypt a plaintext secret and stringify the resulting `EncryptedBlob`
 * for at-rest storage.
 */
export async function wrapEncrypted(plaintext: string, orgId: string): Promise<string> {
  return JSON.stringify(await encryptSecret(plaintext, orgId));
}

/**
 * Decrypt a JSON-stringified `EncryptedBlob` from disk. Throws when the
 * stored value isn't a well-formed blob — the clear-text fallback was
 * removed alongside the mandatory-encryption cutover.
 *
 * `fieldLabel` is included in the error so on-call can identify which
 * record needs repair without leaking the (encrypted) value itself.
 */
export async function unwrapEncrypted(raw: string, orgId: string, fieldLabel: string): Promise<string> {
  if (!looksEncrypted(raw)) {
    throw new Error(`Stored secret "${fieldLabel}" is not a JSON-encoded EncryptedBlob`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Stored secret "${fieldLabel}" is not valid JSON: ${errorMessage(err)}`);
  }
  if (!isEncryptedBlob(parsed)) {
    throw new Error(`Stored secret "${fieldLabel}" does not match the EncryptedBlob shape`);
  }
  return decryptSecret(parsed as EncryptedBlob, orgId);
}
