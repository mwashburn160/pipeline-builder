// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import {
  observabilityQuery,
  observabilityLogs,
  observabilityCatalog,
  observabilityAlerts,
  observabilitySilencesList,
  observabilitySilenceCreate,
  observabilitySilenceDelete,
} from '../observability/controller';
import { requireAuth } from '../middleware';

const router = Router();

/** GET /observability/query — Prometheus instant/range by catalog key */
router.get('/query', requireAuth, observabilityQuery);

/** GET /observability/logs — Loki range by catalog key */
router.get('/logs', requireAuth, observabilityLogs);

/** GET /observability/catalog — list catalog keys (drives the editor's panel-add picker) */
router.get('/catalog', requireAuth, observabilityCatalog);

/** GET /observability/alerts — currently-firing + suppressed alerts (org-scoped) */
router.get('/alerts', requireAuth, observabilityAlerts);

/** GET /observability/silences — active + recent silences */
router.get('/silences', requireAuth, observabilitySilencesList);

/** POST /observability/silences — create a silence (auto-scoped to caller's org) */
router.post('/silences', requireAuth, observabilitySilenceCreate);

/** DELETE /observability/silences/:id — expire a silence (must own it) */
router.delete('/silences/:id', requireAuth, observabilitySilenceDelete);

export default router;
