// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Automatic plugin version tidying (services/tidy/, docs/plugin-publishing.md
 * "Automatic tidying"), mounted at `/plugins` behind the shared auth + org
 * chain and BEFORE the read routes (their `/:id` would catch `tidy`). The
 * caller's OWN org only; each route owns its gate:
 *
 *   GET  /plugins/tidy/preview               plugins:read         the dry run: what would be warned / deactivated / retired, why each protected version is skipped, the bytes freed; the org's settings
 *   PUT  /plugins/tidy/settings              org_settings:write   pluginRetention.autoTidy (off | notify | on) and staleAfterDays (min 30)
 *   POST /plugins/tidy/versions/:id/keep     plugins:write        Keep one version: restart its clock (a deactivated one is active again)
 *   PUT  /plugins/by-name/:name/never-tidy   plugins:write        a plugin's "never tidy"
 */

import { audited, ErrorCode, hasPermission, recordAudit, requirePermission, sendSuccess, type Permission } from '@pipeline-builder/api-core';
import { Router, type RequestHandler } from 'express';

import { bodyFrom, ecosystemRoute, param } from './ecosystem-route.js';
import { shapePlugin } from '../helpers/plugin-helpers.js';
import { EcosystemError } from '../services/ecosystem/context.js';
import { tidyPreview } from '../services/tidy/pass.js';
import { isListedPluginName, isPluginName, NeverTidyWriteSchema, readTidySettings, TidySettingsWriteSchema, writeTidySettings } from '../services/tidy/settings.js';
import { keepVersion, setNeverTidy } from '../services/tidy/usage.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The tidy routes (mounted at `/plugins`). */
export function createTidyRoutes(): Router {
  const router = Router();
  const read = requirePermission('plugins:read') as RequestHandler;
  const write = requirePermission('plugins:write') as RequestHandler;

  router.get('/tidy/preview', read, ecosystemRoute(async ({ res, caller }) => {
    const [report, settings] = await Promise.all([tidyPreview(caller.orgId), readTidySettings(caller.orgId)]);
    const perms = caller.permissions as Permission[];
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, 200, {
      settings,
      report,
      canEdit: hasPermission(perms, 'org_settings:write', caller.isSuperAdmin),
      canKeep: hasPermission(perms, 'plugins:write', caller.isSuperAdmin),
    });
  }));

  router.put('/tidy/settings', requirePermission('org_settings:write') as RequestHandler, audited('plugin.tidy.settings.update') as RequestHandler, ecosystemRoute(async ({ req, res, caller }) => {
    const body = bodyFrom(req, TidySettingsWriteSchema);
    const before = await readTidySettings(caller.orgId);
    const settings = await writeTidySettings(caller.orgId, body, caller.userId);
    recordAudit({
      action: 'plugin.tidy.settings.update',
      actorId: caller.userId,
      orgId: caller.orgId,
      targetType: 'org',
      targetId: caller.orgId,
      details: { before: { autoTidy: before.autoTidy, staleAfterDays: before.staleAfterDays }, after: { autoTidy: settings.autoTidy, staleAfterDays: settings.staleAfterDays } },
    });
    sendSuccess(res, 200, { settings });
  }));

  router.post('/tidy/versions/:id/keep', write, audited('plugin.tidy.kept') as RequestHandler, ecosystemRoute(async ({ req, res, caller }) => {
    const id = param(req, 'id');
    if (!UUID.test(id)) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'id must be a plugin version id');
    const kept = await keepVersion(caller.orgId, id, caller.userId);
    if (!kept) throw new EcosystemError(ErrorCode.NOT_FOUND, 'No version of yours with that id.');
    sendSuccess(res, 200, { plugin: shapePlugin(kept) });
  }));

  router.put('/by-name/:name/never-tidy', write, audited('plugin.tidy.kept') as RequestHandler, ecosystemRoute(async ({ req, res, caller }) => {
    const name = param(req, 'name');
    const { neverTidy } = bodyFrom(req, NeverTidyWriteSchema);
    // Adding takes a lowercase name only; clearing also takes one an older list holds in another case.
    if (!(neverTidy ? isPluginName(name) : isListedPluginName(name))) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'name must be a plugin name');
    const settings = await setNeverTidy(caller.orgId, name, neverTidy, caller.userId);
    sendSuccess(res, 200, { name, neverTidy, settings });
  }));

  return router;
}
