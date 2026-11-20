// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { PLATFORM_INTERNAL, contractRoute, requireInternalService } from '@pipeline-builder/api-core';
import { Router } from 'express';
import { getOrgKmsConfigInternal } from '../controllers/kms-config-internal.js';
import { requireServiceAuth } from '../middleware/index.js';

/**
 * `/internal/kms-config/:orgId` — an org's per-org KMS config, for the pipeline
 * service, which encrypts that org's runner signing keys under it when
 * `SECRET_ENCRYPTION_PER_ORG_KMS=true`. INTERNAL and named-caller gated; the
 * mesh policy on the Istio targets names the same caller, compose relies on
 * this gate alone. No user token is admitted.
 */
/** Where `mount.ts` mounts this router — the contract's path is under it. */
export const KMS_CONFIG_INTERNAL_MOUNT = '/internal/kms-config';

const { orgKmsConfig: KMS_CONFIG } = PLATFORM_INTERNAL;

const router: Router = Router();

router.get(
  contractRoute(KMS_CONFIG, KMS_CONFIG_INTERNAL_MOUNT),
  requireServiceAuth,
  requireInternalService({ callers: [...KMS_CONFIG.callers] }),
  getOrgKmsConfigInternal,
);

export default router;
