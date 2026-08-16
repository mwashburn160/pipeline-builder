// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, getPrimarySupportAlias, getAllSupportAliases } from '@pipeline-builder/api-core';
import { Router } from 'express';
import { config } from '../config/index.js';

const router: Router = Router();

/** GET /config - Public endpoint returning service feature flags.
 *  `sendSuccess` uses res.status().json() and never touches Cache-Control,
 *  so the explicit `res.set('Cache-Control', ...)` above survives. */
router.get('/', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  sendSuccess(res, 200, {
    serviceFeatures: {
      billing: config.billing.enabled,
      email: config.email.enabled,
      oauth: config.oauth.google.enabled,
    },
    // Primary support alias (from SUPPORT_ALIASES) so the UI's compose "To"
    // field prefills the configured value instead of a hardcoded string.
    supportAlias: getPrimarySupportAlias(),
    // ALL configured support aliases, so the compose recipient picker can list
    // every support inbox (support@, help@, …) as a distinct suggestion.
    supportAliases: getAllSupportAliases(),
  });
});

export default router;
