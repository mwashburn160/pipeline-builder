// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Single source of truth for encrypted-secret-blob storage. The
 * secret-handling services (`organization-service`, `org-idp-service`,
 * `secret-reencrypt`) previously each re-implemented the same
 * JSON-wrap-around-EncryptedBlob pattern, with subtly different
 * error message text — drift between them would have broken the
 * round-trip silently.
 *
 * `SECRET_ENCRYPTION_KEY` is a hard requirement at platform boot (see
 * `config/index.ts`); reaching `wrapEncrypted` without it set is a
 * programmer error and the underlying `encryptSecret` throws.
 */

import { type EncryptedBlob, decryptSecret, encryptSecret, isEncryptedBlob } from '@pipeline-builder/api-core';

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
export function wrapEncrypted(plaintext: string, orgId: string): string {
  return JSON.stringify(encryptSecret(plaintext, orgId));
}

/**
 * Decrypt a JSON-stringified `EncryptedBlob` from disk. Throws when the
 * stored value isn't a well-formed blob — the clear-text fallback was
 * removed alongside the mandatory-encryption cutover.
 *
 * `fieldLabel` is included in the error so on-call can identify which
 * record needs repair without leaking the (encrypted) value itself.
 */
export function unwrapEncrypted(raw: string, orgId: string, fieldLabel: string): string {
  if (!looksEncrypted(raw)) {
    throw new Error(`Stored secret "${fieldLabel}" is not a JSON-encoded EncryptedBlob`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Stored secret "${fieldLabel}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isEncryptedBlob(parsed)) {
    throw new Error(`Stored secret "${fieldLabel}" does not match the EncryptedBlob shape`);
  }
  return decryptSecret(parsed as EncryptedBlob, orgId);
}
