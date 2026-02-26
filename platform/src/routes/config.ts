import { Router } from 'express';
import { config } from '../config';

const router = Router();

/** GET /config - Public endpoint returning feature flags */
router.get('/', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    success: true,
    statusCode: 200,
    data: {
      billingEnabled: config.billing.enabled,
      emailEnabled: config.email.enabled,
      oauthEnabled: config.oauth.google.enabled,
    },
  });
});

export default router;
