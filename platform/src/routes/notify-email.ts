// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import { notifyEmail } from '../controllers/notify-email.js';
import { requireServiceAuth } from '../middleware/index.js';

const router: Router = Router();

/** POST /internal/notify-email - Internal service-to-service email send (service token only). */
router.post('/', requireServiceAuth, notifyEmail);

export default router;
