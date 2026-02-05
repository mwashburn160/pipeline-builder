/**
 * @module routes/oauth
 * @description OAuth authentication routes.
 *
 * All routes are public (no JWT required).
 *
 *   GET  /auth/oauth/providers              — list enabled providers
 *   GET  /auth/oauth/:provider/url          — get authorization URL
 *   POST /auth/oauth/:provider/callback     — exchange code for JWT
 */

import { Router } from 'express';
import { getProviders, getAuthUrl, handleCallback } from '../controllers/oauth.controller';

const router = Router();

/** GET /oauth/providers - List enabled OAuth providers */
router.get('/providers', getProviders);

/** GET /oauth/:provider/url - Get authorization URL for redirect */
router.get('/:provider/url', getAuthUrl);

/** POST /oauth/:provider/callback - Exchange authorization code for tokens */
router.post('/:provider/callback', handleCallback);

export default router;
