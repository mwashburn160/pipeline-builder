// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import { observabilityQuery, observabilityLogs } from '../observability/controller';
import { requireAuth } from '../middleware';

const router = Router();

/** GET /observability/query — Prometheus instant/range by catalog key (sysadmin only) */
router.get('/query', requireAuth, observabilityQuery);

/** GET /observability/logs — Loki range by catalog key (sysadmin only) */
router.get('/logs', requireAuth, observabilityLogs);

export default router;
