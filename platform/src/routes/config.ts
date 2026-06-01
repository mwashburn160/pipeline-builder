// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess } from '@pipeline-builder/api-core';
import { Router } from 'express';
import { config } from '../config';

const router = Router();

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
  });
});

export default router;
