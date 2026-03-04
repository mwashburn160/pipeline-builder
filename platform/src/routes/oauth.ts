import { Router } from 'express';
import { getProviders, getAuthUrl, handleCallback } from '../controllers/oauth';

const router = Router();

/** GET /oauth/providers - List enabled OAuth providers */
router.get('/providers', getProviders);

/** GET /oauth/:provider/url - Get authorization URL for redirect */
router.get('/:provider/url', getAuthUrl);

/** POST /oauth/:provider/callback - Exchange authorization code for tokens */
router.post('/:provider/callback', handleCallback);

export default router;
