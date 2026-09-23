// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-org plugin security notification settings (docs/plugin-publishing.md
 * "Scan gates"). ORG-LOCAL routes, mounted at `/plugins` behind the shared auth
 * + org chain (before the read routes, so `/:id` never sees them):
 *
 *   GET  /plugins/security-notifications       plugins:read   the org's settings (secret/address never returned)
 *   PUT  /plugins/security-notifications       org:settings   update; a new external address gets a confirmation link
 *   POST /plugins/security-notifications/test  org:settings   one test notice on every configured channel
 *
 * and the anonymous confirmation, mounted at `/public/plugin-security-notifications`
 * (nginx: a POST-only exact location, credentials stripped):
 *
 *   POST /public/plugin-security-notifications/confirm  { token }  consume the single-use link
 */

import { audited, hasPermission, proposable, requirePermission, sendSuccess, type Permission } from '@pipeline-builder/api-core';
import { rateLimitByOrg } from '@pipeline-builder/api-server';
import { Router, type Request, type RequestHandler, type Response } from 'express';

import { bodyOf, ecosystemRoute } from './ecosystem-route.js';
import {
  confirmExternalEmail, getSecurityPrefs, putSecurityPrefs, sendTestNotice,
} from '../services/plugin-security-notifications.js';

/** The org-local settings routes (mounted at `/plugins`). */
export function createSecurityNotificationRoutes(): Router {
  const router = Router();

  router.get('/security-notifications', requirePermission('plugins:read') as RequestHandler, ecosystemRoute(async ({ res, caller }) => {
    const canEdit = hasPermission(caller.permissions as Permission[], 'org:settings', caller.isSuperAdmin);
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, 200, { preferences: await getSecurityPrefs(caller.orgId, canEdit) });
  }));

  router.put('/security-notifications', requirePermission('org:settings') as RequestHandler,
    audited('plugin.security_notifications.update') as RequestHandler,
    proposable as RequestHandler,
    ecosystemRoute(async ({ req, res, caller }) => {
      sendSuccess(res, 200, { preferences: await putSecurityPrefs(caller.orgId, caller.userId, bodyOf(req), req.headers) });
    }));

  // A test send can reach people and an external endpoint: throttle it per org.
  const testLimit = rateLimitByOrg({ name: 'plugin-security-notification-test', max: 5, windowMs: 60_000 }) as RequestHandler;
  router.post('/security-notifications/test', requirePermission('org:settings') as RequestHandler, testLimit,
    audited('plugin.security_notifications.test') as RequestHandler,
    ecosystemRoute(async ({ res, caller }) => {
      sendSuccess(res, 200, { result: await sendTestNotice(caller.orgId, caller.userId) });
    }));

  return router;
}

/** The anonymous confirmation route (mounted at `/public/plugin-security-notifications`). */
export function createPublicSecurityNotificationRoutes(limits: { perMinute?: number } = {}): Router {
  const router = Router();
  router.use((_req: Request, res: Response, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const limit = rateLimitByOrg({ name: 'plugin-security-confirm', keyBy: 'ip', max: limits.perMinute ?? 10, windowMs: 60_000 }) as RequestHandler;

  router.post('/confirm', limit, audited('plugin.security_notifications.external_email.verify') as RequestHandler,
    ecosystemRoute(async ({ req, res }) => {
      sendSuccess(res, 200, await confirmExternalEmail(bodyOf(req).token), 'Address confirmed');
    }, { requireOrgId: false }));

  return router;
}
