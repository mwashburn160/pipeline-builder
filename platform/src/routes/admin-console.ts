// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * GET /admin/console-check — the gateway's admin-console gate.
 *
 * nginx on the AWS targets fronts pgAdmin, mongo-express, Grafana and Kiali
 * (each a direct line to a datastore or to every tenant's telemetry). When an
 * operator turns those routes on (ADMIN_UIS_ENABLED, off by default), every
 * request to them first makes an `auth_request` subrequest HERE, carrying the
 * caller's access token (from the `pb_admin_console` cookie the dashboard sets
 * when a superadmin opens a console — nginx copies it into `Authorization`).
 * 204 lets the request through; anything else stops it at the gateway.
 *
 * The gate is the same one the rest of the admin surface uses — an access
 * token for a live session (requireAuth: signature, type, tokenVersion) of a
 * PLATFORM administrator (requireSystemAdmin; org admins do not qualify) whose
 * session reached AAL2 (a second factor) — and it reads nothing else, so it is
 * cheap enough to run per request.
 */

import { requireAssurance } from '@pipeline-builder/api-core';
import { Router } from 'express';
import { requireAuth, requireSystemAdmin } from '../middleware/index.js';

const router: Router = Router();

router.get('/', requireAuth, requireSystemAdmin, requireAssurance({ minAssurance: 2 }), (_req, res) => {
  res.status(204).end();
});

export default router;
