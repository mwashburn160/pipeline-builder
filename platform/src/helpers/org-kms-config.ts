// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { PER_ORG_KMS_CACHE_TTL_MS, type PerOrgKmsConfig } from '@pipeline-builder/api-core';

/**
 * The org's per-org KMS config as the providers read it, or null when it has
 * none (a stored doc missing either field counts as none: the org uses the
 * shared provider). The one reading of `Organization.kmsConfig`, shared by the
 * platform resolver, the internal route and the admin rotation flow.
 */
export function activeKmsConfig(cfg: { keyId?: string | null; ciphertextBase64?: string | null } | null | undefined): PerOrgKmsConfig | null {
  return cfg?.keyId && cfg?.ciphertextBase64 ? { keyId: cfg.keyId, ciphertextBase64: cfg.ciphertextBase64 } : null;
}

/** Past the per-org cache TTL by this much, so a replica whose cache entry was
 *  refreshed just before the change has certainly dropped it. */
const KMS_VERIFY_MARGIN_MS = 60_000;

/** How long after a KMS config change its verification comes due
 *  (services/kms-config-verify.ts): every replica's per-org key cache has lapsed. */
export const KMS_VERIFY_DELAY_MS = PER_ORG_KMS_CACHE_TTL_MS + KMS_VERIFY_MARGIN_MS;

/** The `$set` fragment a KMS config change writes alongside its new config:
 *  the durable `Organization.kmsVerifyDueAt` marker the verification sweep reads. */
export function kmsVerifySchedule(now: number = Date.now()): { kmsVerifyDueAt: Date } {
  return { kmsVerifyDueAt: new Date(now + KMS_VERIFY_DELAY_MS) };
}
