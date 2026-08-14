// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-org SSO (OIDC) login routes. Mounted under `/auth/sso` (behind the same
 * `authLimiter` as the rest of `/auth`). These are UNAUTHENTICATED by design —
 * they ARE the login path — so enforcement (enabled + `sso`-entitled) is applied
 * inside the controllers, not by an auth middleware.
 */

import { Router } from 'express';
import { discoverSso, getSsoAuthUrl, handleSsoCallback } from '../controllers/sso.js';

const router: Router = Router();

/** POST /auth/sso/discover - Is this email forced through SSO? (login page hint) */
router.post('/discover', discoverSso);

/** GET /auth/sso/:orgId/authorize - Get the IdP authorize URL for redirect */
router.get('/:orgId/authorize', getSsoAuthUrl);

/** POST /auth/sso/:orgId/callback - Exchange code + validate id_token → tokens */
router.post('/:orgId/callback', handleSsoCallback);

export default router;
