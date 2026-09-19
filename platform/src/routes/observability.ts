// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { audited, requirePermission, requireStepUp } from '@pipeline-builder/api-core';
import { Router } from 'express';
import {
  listAlertDestinations,
  listAllAlertDestinations,
  listDeletedAlertDestinations,
  createAlertDestination,
  updateAlertDestination,
  deleteAlertDestination,
  restoreAlertDestination,
  purgeAlertDestination,
  testAlertDestination,
  alertWebhook,
} from '../controllers/alert-destinations.js';
import {
  listAlertRules,
  listDeletedAlertRules,
  createAlertRule,
  updateAlertRule,
  deleteAlertRule,
  restoreAlertRule,
  purgeAlertRule,
  materializeAlertRules,
} from '../controllers/alert-rules.js';
import { requireAuth, requireSystemAdmin } from '../middleware/index.js';
import {
  observabilityQuery,
  observabilityAuditQuery,
  observabilityCatalog,
  observabilityAlerts,
  observabilitySilencesList,
  observabilitySilenceCreate,
  observabilitySilenceDelete,
} from '../observability/controller.js';
import {
  logContext,
  logExport,
  logRaw,
  logSearch,
  logVolume,
} from '../observability/log-controller.js';

const router: Router = Router();

// READS carry the `observability:read` capability (in the built-in Member
// bundle, so no role loses access) rather than bare `requireAuth`: they are the
// Prometheus/Loki/Alertmanager data plane, and a custom Role that withholds
// observability must not still see the org's metrics, logs and firing alerts.
// Per-route, never a router-level `use`, so nothing leaks onto the siblings.
// The in-controller `$ORG` substitution / org-scoped filtering stays orthogonal
// to this capability gate. The two cross-tenant reads take `requireSystemAdmin`
// instead, mirroring their handlers' own gate.

/** GET /observability/query  Prometheus instant/range by catalog key */
router.get('/query', requireAuth, requirePermission('observability:read'), observabilityQuery);

/**
 * GET /observability/audit-query  the MongoDB AUDIT trail by catalog key.
 *
 * Renamed from `/logs`, which now means what it says (application logs, below).
 * An endpoint called "logs" that served the audit trail was a standing trap.
 */
router.get('/audit-query', requireAuth, requirePermission('observability:read'), observabilityAuditQuery);

// ---------------------------------------------------------------------------
// Logs  Loki-backed application logs. Tenancy is the Loki tenant header,
// resolved from the VERIFIED token (never nginx's injected `x-org-id`), so an
// org physically cannot read another org's lines.
//
// Viewing rides `observability:read` like its siblings above. DOWNLOAD needs
// `logs:export` too: bulk egress that leaves the building is a different risk
// class from paging a list in the UI, and an admin may withhold it.
// ---------------------------------------------------------------------------

/** GET /observability/logs  search */
router.get('/logs', requireAuth, requirePermission('observability:read'), logSearch);
/** GET /observability/logs/volume  per-level histogram for the window */
router.get('/logs/volume', requireAuth, requirePermission('observability:read'), logVolume);
/** GET /observability/logs/context  lines either side of one entry */
router.get('/logs/context', requireAuth, requirePermission('observability:read'), logContext);
/** GET /observability/logs/raw  the caller's slice of one stream as text/plain */
router.get('/logs/raw', requireAuth, requirePermission('observability:read'), logRaw);
/** GET /observability/logs/export  streamed download (bytes + wall-clock capped) */
router.get('/logs/export', requireAuth, requirePermission('logs:export'), logExport);

/** GET /observability/catalog  list catalog keys (drives the editor's panel-add picker) */
router.get('/catalog', requireAuth, requirePermission('observability:read'), observabilityCatalog);

/** GET /observability/alerts  currently-firing + suppressed alerts (org-scoped) */
router.get('/alerts', requireAuth, requirePermission('observability:read'), observabilityAlerts);

/** GET /observability/silences  active + recent silences */
router.get('/silences', requireAuth, requirePermission('observability:read'), observabilitySilencesList);

// Static `observability:write` capability gated at the route so it matches the
// sibling alerting mutations (`/alert-destinations`, `/alert-rules`). Creating
// or deleting a silence SUPPRESSES the org's alerts (detection-evasion), so a
// plain member with only `observability:read` must NOT be able to do it. The
// in-controller per-org scoping stays orthogonal to this capability gate.
/** POST /observability/silences  create a silence (auto-scoped to caller's org) */
router.post('/silences', requireAuth, requirePermission('observability:write'), audited('observability.silence.create'), observabilitySilenceCreate);

/** DELETE /observability/silences/:id  expire a silence (must own it) */
router.delete('/silences/:id', requireAuth, requirePermission('observability:write'), audited('observability.silence.delete'), observabilitySilenceDelete);

/** Per-org alert notification destinations (multi-tenant alerting) */
router.get('/alert-destinations', requireAuth, requirePermission('observability:read'), listAlertDestinations);
// Sysadmin cross-tenant viewer — `/all` literal must come before `/:id`
// so it isn't captured as an id parameter.
router.get('/alert-destinations/all', requireAuth, requireSystemAdmin, listAllAlertDestinations);
// Restorable tombstones for the "recently deleted" panel. Another LITERAL path
// that must precede the `/:id` routes. Same read capability + org scope (and the
// same target masking) as the live list.
router.get('/alert-destinations/deleted', requireAuth, requirePermission('observability:read'), listDeletedAlertDestinations);
// Static `observability:write` capability gated at the route so it's auditable
// from the route table (handlers no longer re-check). The per-org data scoping
// (findById(id, orgId)) inside the handlers is orthogonal to this gate.
router.post('/alert-destinations', requireAuth, requirePermission('observability:write'), audited('alert.destination.create'), createAlertDestination);
router.put('/alert-destinations/:id', requireAuth, requirePermission('observability:write'), audited('alert.destination.update'), updateAlertDestination);
router.delete('/alert-destinations/:id', requireAuth, requirePermission('observability:write'), audited('alert.destination.delete'), deleteAlertDestination);
router.post('/alert-destinations/:id/restore', requireAuth, requirePermission('observability:write'), requireStepUp, audited('alert.destination.restore'), restoreAlertDestination);
// Purge finalizes a soft-delete ahead of the retention sweep — irreversible, so
// it carries the same write capability + step-up as restore.
router.post('/alert-destinations/:id/purge', requireAuth, requirePermission('observability:write'), requireStepUp, audited('alert.destination.purge'), purgeAlertDestination);
// Send a labeled test notification to a destination (org-scoped, observability:write).
router.post('/alert-destinations/:id/test', requireAuth, requirePermission('observability:write'), audited('alert.destination.test'), testAlertDestination);

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
router.get('/alert-rules/materialized.yml', requireAuth, requireSystemAdmin, materializeAlertRules);
// `/deleted` is likewise a LITERAL path and must precede the `/:id` routes.
router.get('/alert-rules/deleted', requireAuth, requirePermission('observability:read'), listDeletedAlertRules);
router.get('/alert-rules', requireAuth, requirePermission('observability:read'), listAlertRules);
// Static `observability:write` capability gated at the route (auditable); the
// handlers no longer re-check. Org-scoping (prepareRuleExpr / org-scoped
// service ops) is separate from this capability gate.
router.post('/alert-rules', requireAuth, requirePermission('observability:write'), audited('alert.rule.create'), createAlertRule);
router.put('/alert-rules/:id', requireAuth, requirePermission('observability:write'), audited('alert.rule.update'), updateAlertRule);
router.delete('/alert-rules/:id', requireAuth, requirePermission('observability:write'), audited('alert.rule.delete'), deleteAlertRule);
router.post('/alert-rules/:id/restore', requireAuth, requirePermission('observability:write'), requireStepUp, audited('alert.rule.restore'), restoreAlertRule);
// Irreversible finalization of a soft-delete — same gate as restore, plus step-up.
router.post('/alert-rules/:id/purge', requireAuth, requirePermission('observability:write'), requireStepUp, audited('alert.rule.purge'), purgeAlertRule);

export default router;
