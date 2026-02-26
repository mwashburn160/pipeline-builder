import { sendSuccess } from '@mwashburn160/api-core';
import { Router } from 'express';
import { config } from '../config';

const router = Router();

/** GET /config - Public endpoint returning feature flags */
router.get('/', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  sendSuccess(res, 200, {
    billingEnabled: config.billing.enabled,
    emailEnabled: config.email.enabled,
    oauthEnabled: config.oauth.google.enabled,
  });
});

export default router;
