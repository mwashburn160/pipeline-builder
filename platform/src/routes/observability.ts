// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requirePermission } from '@pipeline-builder/api-core';
import { Router } from 'express';
import {
  listAlertDestinations,
  listAllAlertDestinations,
  createAlertDestination,
  updateAlertDestination,
  deleteAlertDestination,
  testAlertDestination,
  alertWebhook,
} from '../controllers/alert-destinations.js';
import {
  listAlertRules,
  createAlertRule,
  updateAlertRule,
  deleteAlertRule,
  materializeAlertRules,
} from '../controllers/alert-rules.js';
import { requireAuth } from '../middleware/index.js';
import {
  observabilityQuery,
  observabilityLogs,
  observabilityCatalog,
  observabilityAlerts,
  observabilitySilencesList,
  observabilitySilenceCreate,
  observabilitySilenceDelete,
} from '../observability/controller.js';

const router: Router = Router();

/** GET /observability/query  Prometheus instant/range by catalog key */
router.get('/query', requireAuth, observabilityQuery);

/** GET /observability/logs  Loki range by catalog key */
router.get('/logs', requireAuth, observabilityLogs);

/** GET /observability/catalog  list catalog keys (drives the editor's panel-add picker) */
router.get('/catalog', requireAuth, observabilityCatalog);

/** GET /observability/alerts  currently-firing + suppressed alerts (org-scoped) */
router.get('/alerts', requireAuth, observabilityAlerts);

/** GET /observability/silences  active + recent silences */
router.get('/silences', requireAuth, observabilitySilencesList);

/** POST /observability/silences  create a silence (auto-scoped to caller's org) */
router.post('/silences', requireAuth, observabilitySilenceCreate);

/** DELETE /observability/silences/:id  expire a silence (must own it) */
router.delete('/silences/:id', requireAuth, observabilitySilenceDelete);

/** Per-org alert notification destinations (multi-tenant alerting) */
router.get('/alert-destinations', requireAuth, listAlertDestinations);
// Sysadmin cross-tenant viewer — `/all` literal must come before `/:id`
// so it isn't captured as an id parameter.
router.get('/alert-destinations/all', requireAuth, listAllAlertDestinations);
// Static `observability:write` capability gated at the route so it's auditable
// from the route table (handlers no longer re-check). The per-org data scoping
// (findById(id, orgId)) inside the handlers is orthogonal to this gate.
router.post('/alert-destinations', requireAuth, requirePermission('observability:write'), createAlertDestination);
router.put('/alert-destinations/:id', requireAuth, requirePermission('observability:write'), updateAlertDestination);
router.delete('/alert-destinations/:id', requireAuth, requirePermission('observability:write'), deleteAlertDestination);
// Send a labeled test notification to a destination (org-scoped, observability:write).
router.post('/alert-destinations/:id/test', requireAuth, requirePermission('observability:write'), testAlertDestination);

/**
 * Alertmanager webhook relay  shared-secret auth, not JWT. Mounted on the
 * `/observability/*` prefix so it's covered by the existing per-org rate
 * limiter (Alertmanager bursts can be smoothed but rarely block; the
 * per-destination delivery timeout in alert-relay.ts is the real backpressure).
 */
router.post('/alert-webhook', alertWebhook);

/**  per-org operator-authored alert rules.
 * Materialized endpoint MUST come BEFORE the `/:id` routes so the
 * literal `materialized.yml` path doesn't get captured as an:id. */
router.get('/alert-rules/materialized.yml', requireAuth, materializeAlertRules);
router.get('/alert-rules', requireAuth, listAlertRules);
// Static `observability:write` capability gated at the route (auditable); the
// handlers no longer re-check. Org-scoping (prepareRuleExpr / org-scoped
// service ops) is separate from this capability gate.
router.post('/alert-rules', requireAuth, requirePermission('observability:write'), createAlertRule);
router.put('/alert-rules/:id', requireAuth, requirePermission('observability:write'), updateAlertRule);
router.delete('/alert-rules/:id', requireAuth, requirePermission('observability:write'), deleteAlertRule);

export default router;
