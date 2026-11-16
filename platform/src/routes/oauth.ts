// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { audited } from '@pipeline-builder/api-core';
import { Router } from 'express';
import { getProviders, getAuthUrl, handleCallback } from '../controllers/oauth.js';
import { authDiscoveryLimiter, signInLimiter } from '../middleware/auth-limiters.js';

const router: Router = Router();

/** GET /oauth/providers - List enabled OAuth providers. The sign-in page asks on
 *  every load, so it is on the generous discovery bucket, never the sign-in one. */
router.get('/providers', authDiscoveryLimiter, getProviders);

/** GET /oauth/:provider/url - Get authorization URL for redirect */
router.get('/:provider/url', authDiscoveryLimiter, getAuthUrl);

/** POST /oauth/:provider/callback - Exchange authorization code for tokens */
router.post('/:provider/callback', signInLimiter, audited('user.login', 'user.login.failed'), handleCallback);

export default router;
