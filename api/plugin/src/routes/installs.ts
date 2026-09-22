// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Installs, the org consumption policy and the in-app catalog
 * (docs/plugin-publishing.md). ORG-LOCAL routes: they decide
 * only what the caller's own org (and, for a root org, its teams) may use —
 * never anything in the ecosystem:
 *
 *   GET /plugins/catalog plugins:read
 *   GET /plugins/listings/:publisher/:name/install-state plugins:read
 *   GET /plugins/installs plugins:read
 *   POST /plugins/installs plugins:install install, or request it (approval policy)
 *   PATCH /plugins/installs/:id plugins:install upgrade / change the version policy
 *   GET /plugins/installs/change-requests plugin_installs:manage the org's pending install changes
 *   POST /plugins/installs/:id/change-requests plugins:install request a change that needs an approver
 *   POST /plugins/installs/:id/change-requests/approve plugin_installs:manage apply it
 *   POST /plugins/installs/:id/change-requests/reject plugin_installs:manage drop it (reason)
 *   DELETE /plugins/installs/:id plugins:install uninstall / withdraw a request
 *   POST /plugins/installs/:id/approve plugin_installs:manage
 *   POST /plugins/installs/:id/deny plugin_installs:manage
 *   GET /plugins/install-policy plugins:read
 *   PUT /plugins/install-policy plugin_installs:manage + step-up
 *   GET /plugins/shadowing plugins:read
 */

import { audited, requirePermission, requireStepUp, sendSuccess } from '@pipeline-builder/api-core';
import { Router, type RequestHandler } from 'express';

import { bodyOf, ecosystemRoute, param } from './ecosystem-route.js';
import {
  approveInstall, approveInstallChange, catalog, createInstall, denyInstall, getPolicy, installState, listInstallChangeRequests, listInstalls,
  putPolicy, rejectInstallChange, removeInstall, requestInstallChange, shadowing, updateInstall,
} from '../services/ecosystem/installs.js';

const query = (q: unknown): Record<string, unknown> => (q && typeof q === 'object' ? q as Record<string, unknown> : {});

/** Build the install router (mounted at `/plugins`, behind the shared auth + org chain). */
export function createInstallRoutes(): Router {
  const router = Router();

  router.get('/catalog', requirePermission('plugins:read') as RequestHandler, ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, await catalog(caller, query(req.query)));
  }));

  router.get('/listings/:publisher/:name/install-state', requirePermission('plugins:read') as RequestHandler, ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, await installState(caller, param(req, 'publisher'), param(req, 'name')));
  }));

  router.get('/installs', requirePermission('plugins:read') as RequestHandler, ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, await listInstalls(caller, query(req.query)));
  }));

  router.post('/installs', requirePermission('plugins:install') as RequestHandler,
    audited('plugin.install.create', 'plugin.install.request') as RequestHandler,
    ecosystemRoute(async ({ req, res, caller }) => {
      sendSuccess(res, 201, await createInstall(caller, bodyOf(req)));
    }));

  // Before `/installs/:id…`, so `change-requests` is never read as an install id.
  router.get('/installs/change-requests', requirePermission('plugin_installs:manage') as RequestHandler, ecosystemRoute(async ({ res, caller }) => {
    sendSuccess(res, 200, await listInstallChangeRequests(caller));
  }));

  router.post('/installs/:id/change-requests', requirePermission('plugins:install') as RequestHandler, audited('plugin.install.change-request') as RequestHandler,
    ecosystemRoute(async ({ req, res, caller }) => {
      sendSuccess(res, 201, await requestInstallChange(caller, param(req, 'id'), bodyOf(req)));
    }));

  router.post('/installs/:id/change-requests/approve', requirePermission('plugin_installs:manage') as RequestHandler,
    audited('plugin.install.change-approve', 'plugin.install.upgrade') as RequestHandler,
    ecosystemRoute(async ({ req, res, caller }) => {
      sendSuccess(res, 200, await approveInstallChange(caller, param(req, 'id')));
    }));

  router.post('/installs/:id/change-requests/reject', requirePermission('plugin_installs:manage') as RequestHandler,
    audited('plugin.install.change-reject') as RequestHandler,
    ecosystemRoute(async ({ req, res, caller }) => {
      sendSuccess(res, 200, await rejectInstallChange(caller, param(req, 'id'), bodyOf(req).reason));
    }));

  router.patch('/installs/:id', requirePermission('plugins:install') as RequestHandler, audited('plugin.install.upgrade') as RequestHandler,
    ecosystemRoute(async ({ req, res, caller }) => {
      sendSuccess(res, 200, await updateInstall(caller, param(req, 'id'), bodyOf(req)));
    }));

  router.delete('/installs/:id', requirePermission('plugins:install') as RequestHandler, audited('plugin.install.remove') as RequestHandler,
    ecosystemRoute(async ({ req, res, caller }) => {
      sendSuccess(res, 200, await removeInstall(caller, param(req, 'id')));
    }));

  router.post('/installs/:id/approve', requirePermission('plugin_installs:manage') as RequestHandler, audited('plugin.install.approve') as RequestHandler,
    ecosystemRoute(async ({ req, res, caller }) => {
      sendSuccess(res, 200, await approveInstall(caller, param(req, 'id')));
    }));

  router.post('/installs/:id/deny', requirePermission('plugin_installs:manage') as RequestHandler, audited('plugin.install.deny') as RequestHandler,
    ecosystemRoute(async ({ req, res, caller }) => {
      sendSuccess(res, 200, await denyInstall(caller, param(req, 'id'), bodyOf(req).reason));
    }));

  router.get('/install-policy', requirePermission('plugins:read') as RequestHandler, ecosystemRoute(async ({ res, caller }) => {
    sendSuccess(res, 200, await getPolicy(caller));
  }));

  router.put('/install-policy', requirePermission('plugin_installs:manage') as RequestHandler, requireStepUp as RequestHandler,
    audited('org.plugin-install-policy.update') as RequestHandler,
    ecosystemRoute(async ({ req, res, caller }) => {
      sendSuccess(res, 200, await putPolicy(caller, req.body));
    }));

  router.get('/shadowing', requirePermission('plugins:read') as RequestHandler, ecosystemRoute(async ({ res, caller }) => {
    sendSuccess(res, 200, await shadowing(caller));
  }));

  return router;
}
