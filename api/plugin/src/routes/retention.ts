// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Superseded system plugin version retention (services/retention/). SYSTEM-ORG
 * routes: system org + `plugins:moderate` (the Ecosystem Manager's catalogue
 * moderation, which already yanks versions) + an aal2 session; the run also
 * needs a step-up. Mounted at `/plugins` behind the shared auth + org chain,
 * before the read routes so `/:id` never sees them:
 *
 *   GET  /plugins/retention/plan   the dry run: every system plugin's versions, what the pass would do and why
 *   POST /plugins/retention/run    run one pass now (whatever PLUGIN_RETENTION_ENABLED says); the same report with each action taken
 */

import { audited, requireStepUp, requireSystemOrgPermission, sendSuccess } from '@pipeline-builder/api-core';
import { extendRequestTimeout, withRoute } from '@pipeline-builder/api-server';
import { Router, type RequestHandler } from 'express';

import { runRetentionPass } from '../services/retention/retire.js';

/**
 * The plan and the run walk every system plugin in turn, refreshing each one's
 * declared resolutions. At 129 plugins that takes ~27s, past the server-wide 25s
 * request deadline, so the console's plan always answered 503 "Request timeout".
 * Kept under nginx's `/api/plugins/*` proxy_read_timeout (the 60s default), so
 * the service still answers before the proxy gives up.
 */
export const RETENTION_ROUTE_TIMEOUT_MS = 55_000;

/** The retention routes (mounted at `/plugins`). */
export function createRetentionRoutes(): Router {
  const router = Router();
  const moderate = requireSystemOrgPermission('plugins:moderate');
  const stepUp = requireStepUp as RequestHandler;
  const deadline = extendRequestTimeout(RETENTION_ROUTE_TIMEOUT_MS);

  router.get('/retention/plan', ...moderate, deadline, withRoute(async ({ res }) => {
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, 200, await runRetentionPass({ dryRun: true }));
  }));

  router.post('/retention/run', ...moderate, stepUp, deadline, audited('plugin.version.retire') as RequestHandler, withRoute(async ({ res, ctx }) => {
    const report = await runRetentionPass({ dryRun: false });
    ctx.log('COMPLETED', 'Plugin retention pass run on demand', { ...report.totals });
    sendSuccess(res, 200, report);
  }));

  return router;
}
