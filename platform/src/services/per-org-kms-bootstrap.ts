// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap the per-org KMS key provider at platform startup.
 *
 * Background: AI provider keys, IdP client secrets, and other org-scoped
 * secrets are encrypted via api-core's `encryptSecret` / `decryptSecret`.
 * Out of the box they use `EnvKeyProvider` (HKDF off a shared
 * `SECRET_ENCRYPTION_KEY` master). A KMS compromise of that one master
 * decrypts every org's secrets.
 *
 * `PerOrgKmsKeyProvider` (in api-core) lets each org wrap its master under
 * its own KMS CMK. This module is the platform-side glue that:
 *
 *   1. Builds a resolver that reads the per-org KMS config from
 *      `Organization.kmsConfig` (operator-populated via the admin API).
 *   2. Constructs a `PerOrgKmsKeyProvider` with that resolver and an
 *      `EnvKeyProvider` fallback (so orgs without per-org KMS keep working).
 *   3. Registers the provider via `setKeyProvider(...)` so all subsequent
 *      `encryptSecret`/`decryptSecret` calls in this process use it.
 *
 * Opt-in via `SECRET_ENCRYPTION_PER_ORG_KMS=true`. Off by default so
 * existing single-tenant / dev deploys stay on the simple env-key path.
 */

import {
  EnvKeyProvider,
  PerOrgKmsKeyProvider,
  createLogger,
  setKeyProvider,
  type PerOrgKmsConfig,
  type PerOrgKmsResolver,
} from '@pipeline-builder/api-core';
import { toOrgId } from '../helpers/org-id.js';
import { Organization } from '../models/index.js';

const logger = createLogger('per-org-kms-bootstrap');

/**
 * Resolver that fetches an org's KMS config from Mongo. Returns null when
 * the org has no per-org config — the provider falls through to the
 * fallback (shared) key. Lean projection so we only pull the two fields
 * we need; the secret-encryption code path is hot.
 */
export const perOrgKmsResolver: PerOrgKmsResolver = async (orgId) => {
  const org = await Organization.findById(toOrgId(orgId)).select('kmsConfig').lean();
  const cfg = org?.kmsConfig;
  if (!cfg?.keyId || !cfg?.ciphertextBase64) return null;
  const out: PerOrgKmsConfig = {
    keyId: cfg.keyId,
    ciphertextBase64: cfg.ciphertextBase64,
  };
  return out;
};

/**
 * Install the per-org KMS provider as the process-wide default if opted in.
 *
 * Returns `true` when the provider was installed, `false` when the feature
 * is disabled (env unset) — caller can use this for an informational log
 * line at boot.
 *
 * Idempotent (no-op on subsequent calls): the last `setKeyProvider` wins,
 * so calling this twice is wasteful but not unsafe. Bootstrapping happens
 * exactly once at startup; tests can reset via `resetDefaultKeyProvider()`.
 */
export function bootstrapPerOrgKmsProvider(): boolean {
  if ((process.env.SECRET_ENCRYPTION_PER_ORG_KMS || '').toLowerCase() !== 'true') {
    return false;
  }

  // Fallback for orgs without per-org KMS config: the existing env-keyed
  // HKDF provider. Reads `SECRET_ENCRYPTION_KEY` — if that's not set this
  // throws synchronously and aborts startup, which is exactly right.
  const fallback = new EnvKeyProvider();

  const provider = new PerOrgKmsKeyProvider({
    resolver: perOrgKmsResolver,
    fallback,
  });

  setKeyProvider(provider);
  logger.info('Per-org KMS provider installed (SECRET_ENCRYPTION_PER_ORG_KMS=true)');
  return true;
}
