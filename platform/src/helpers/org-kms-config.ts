// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { PerOrgKmsConfig } from '@pipeline-builder/api-core';

/**
 * The org's per-org KMS config as the providers read it, or null when it has
 * none (a stored doc missing either field counts as none: the org uses the
 * shared provider). The one reading of `Organization.kmsConfig`, shared by the
 * platform resolver, the internal route and the admin rotation flow.
 */
export function activeKmsConfig(cfg: { keyId?: string | null; ciphertextBase64?: string | null } | null | undefined): PerOrgKmsConfig | null {
  return cfg?.keyId && cfg?.ciphertextBase64 ? { keyId: cfg.keyId, ciphertextBase64: cfg.ciphertextBase64 } : null;
}
