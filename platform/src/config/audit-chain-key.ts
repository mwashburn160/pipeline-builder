// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

const isDev = (process.env.NODE_ENV || 'development') === 'development';

/**
 * The audit hash-chain HMAC key (`AUDIT_CHAIN_HMAC_KEY`). Every chain link is
 * `HMAC-SHA256(key, canonical event)`, so a party with WRITE access to Mongo —
 * but not to this secret — cannot recompute a consistent chain after editing,
 * deleting or inserting rows. It must therefore live OUTSIDE the database
 * (env / KMS-backed secret), never in any collection. Refuse to boot in
 * production without it; dev gets a deterministic, documented-insecure
 * placeholder so single-machine runs need no setup.
 *
 * Read on use (audit-chain caches it) and asserted at boot in `index.ts`, not
 * at config load. A module of its own (like `webauthn-validate.ts`) so the
 * audit append path doesn't have to load the whole config graph.
 */
export function requireAuditChainHmacKey(): string {
  const value = process.env.AUDIT_CHAIN_HMAC_KEY;
  if (value) {
    if (value.length < 32) {
      throw new Error('AUDIT_CHAIN_HMAC_KEY must be at least 32 characters (generate with: head -c 32 /dev/urandom | base64)');
    }
    return value;
  }
  if (isDev) return 'dev-insecure-audit-chain-hmac-key-do-not-use-in-prod';
  throw new Error(
    'AUDIT_CHAIN_HMAC_KEY is required in production. '
    + 'Generate with: head -c 32 /dev/urandom | base64',
  );
}
