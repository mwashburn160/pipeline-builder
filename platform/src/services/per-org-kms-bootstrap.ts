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
 *   1. Initializes and WARMS the base provider via `initSecretEncryption()` —
 *      the KMS-wrapped shared master when `SECRET_ENCRYPTION_KMS_KEY_ID` +
 *      `_CIPHERTEXT` are set, else the plaintext `SECRET_ENCRYPTION_KEY`.
 *      This happens whether or not per-org KMS is on.
 *   2. Builds a resolver that reads the per-org KMS config from
 *      `Organization.kmsConfig` (operator-populated via the admin API).
 *   3. When the per-org flag is on, registers a `PerOrgKmsKeyProvider` over
 *      that resolver with the BASE provider from step 1 as its fallback, so
 *      orgs without their own CMK inherit the base mode rather than being
 *      pinned to the plaintext env master.
 *
 * Per-org is opt-in via `SECRET_ENCRYPTION_PER_ORG_KMS=true`; off by default so
 * single-tenant / dev deploys stay on the simple env-key path. The two axes are
 * independent — KMS-wrapped shared master and per-org CMKs can be used
 * separately or together.
 */

import {
  EnvKeyProvider,
  PerOrgKmsKeyProvider,
  createLogger,
  initSecretEncryption,
  setKeyProvider,
  type PerOrgKmsConfig,
  type PerOrgKmsResolver,
} from '@pipeline-builder/api-core';
import { envLite } from '../config/env-lite.js';
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
 * ALWAYS initializes the base provider, per-org or not: `initSecretEncryption()`
 * selects between the KMS-wrapped master and the plaintext env master and warms
 * whichever it picked. Returning early when the per-org flag is off would leave
 * a configured `KmsKeyProvider` unwarmed, and its `deriveKey` refuses to work
 * cold — so every secret read would throw.
 *
 * Returns the mode actually installed, for the boot log.
 *
 * Idempotent: the last `setKeyProvider` wins, so a second call is wasteful but
 * not unsafe. Tests reset via `resetDefaultKeyProvider()`.
 */
export async function bootstrapPerOrgKmsProvider(): Promise<{ mode: 'env' | 'kms'; perOrg: boolean }> {
  // Install + WARM the KMS-wrapped shared master if one is configured. Returns
  // a null provider (and leaves the lazy EnvKeyProvider alone) when it is not,
  // so an install with no KMS keeps its current behaviour exactly.
  const { provider: kmsBase, mode } = await initSecretEncryption();

  if (!envLite.perOrgKmsEnabled) {
    logger.info('Secret encryption initialized', { mode, perOrgKms: false });
    return { mode, perOrg: false };
  }

  // Layer per-org CMKs over the base. Handing the SAME warmed instance down as
  // the fallback is the point: orgs without their own CMK then inherit whatever
  // the base mode is, so turning on the shared KMS master covers them too. This
  // used to construct a fresh `EnvKeyProvider` unconditionally, which pinned
  // every no-CMK org to the plaintext env master however KMS was configured.
  // With no KMS base, that env provider is still the right fallback — and
  // `SECRET_ENCRYPTION_KEY` is genuinely required here, since per-org KMS
  // explicitly promises those orgs fall through to the shared master.
  const fallback = kmsBase ?? new EnvKeyProvider();
  setKeyProvider(new PerOrgKmsKeyProvider({ resolver: perOrgKmsResolver, fallback }));
  logger.info('Per-org KMS provider installed (SECRET_ENCRYPTION_PER_ORG_KMS=true)', { fallbackMode: mode });
  return { mode, perOrg: true };
}
