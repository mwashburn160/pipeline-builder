// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /internal/kms-config/:orgId` → `{ kmsConfig }` — the org's per-org KMS
 * config (`Organization.kmsConfig`, the same source as `perOrgKmsResolver`), for
 * the pipeline service's `PerOrgKmsKeyProvider` that wraps the org's runner
 * signing keys. INTERNAL: the `pipeline` service's signed token only.
 *
 * Only the two fields the provider needs leave platform: the CMK id and the
 * KMS-WRAPPED master (useless without `kms:Decrypt` on that key). No plaintext
 * key material is read or returned, and the ciphertext is never logged.
 * `kmsConfig: null` = the org has no per-org config and uses the shared provider.
 */

import { PLATFORM_INTERNAL, contractErrorMessage, parseContractParams, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { withController } from '../helpers/controller-helper.js';
import { toOrgId } from '../helpers/org-id.js';
import { Organization } from '../models/index.js';

const { orgKmsConfig: KMS_CONFIG } = PLATFORM_INTERNAL;

/** 404 for an unknown or soft-deleted org; 400 for a malformed id. */
export const getOrgKmsConfigInternal = withController('Org KMS config (internal)', async (req, res) => {
  const params = parseContractParams(KMS_CONFIG, req);
  if (!params.ok) return sendError(res, 400, contractErrorMessage(params));
  const org = await Organization.findById(toOrgId(params.value.orgId)).select('kmsConfig deletedAt').lean() as
    { kmsConfig?: { keyId?: string; ciphertextBase64?: string }; deletedAt?: Date | null } | null;
  if (!org || org.deletedAt) return sendError(res, 404, 'Organization not found');
  const cfg = org.kmsConfig;
  const kmsConfig = cfg?.keyId && cfg?.ciphertextBase64 ? { keyId: cfg.keyId, ciphertextBase64: cfg.ciphertextBase64 } : null;
  return sendSuccess(res, 200, { kmsConfig });
});
