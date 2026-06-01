// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendError, sendSuccess } from '@pipeline-builder/api-core';
import { isSystemAdmin, requireAuth, withController } from '../helpers/controller-helper';
import * as logService from '../services/log-service';

/**
 * Query logs with automatic org-scoped filtering.
 *
 * Sysadmins may pass `orgId` (or omit it for all-org search); everyone else
 * is force-scoped to their own org. Returns at most 1000 entries; `start`/`end`
 * default to (now-1h, now) and accept ISO 8601 or epoch ms.
 */
export const queryLogs = withController('Query logs', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const isSuperAdmin = isSystemAdmin(req);
  const userOrgId = req.user!.organizationId;

  // Determine effective orgId
  let effectiveOrgId: string | undefined;
  if (isSuperAdmin) {
    // System admins can specify any orgId, or omit for all
    effectiveOrgId = (req.query.orgId as string) || undefined;
  } else {
    // Regular users must have an org and are always scoped to it
    if (!userOrgId) {
      return sendError(res, 400, 'You must belong to an organization to view logs');
    }
    effectiveOrgId = userOrgId;
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 100, 1), 1000);
  const direction = req.query.direction === 'forward' ? 'forward' : 'backward';

  const result = await logService.queryLogs({
    service: req.query.service as string,
    level: req.query.level as string,
    search: req.query.search as string,
    orgId: effectiveOrgId,
    start: req.query.start as string,
    end: req.query.end as string,
    limit,
    direction,
  });

  sendSuccess(res, 200, result);
});

/**
 * Get available service names from Loki.
 */
export const getLogServices = withController('Get log services', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const services = await logService.getServiceNames();
  sendSuccess(res, 200, { services });
});

/**
 * Get available log levels from Loki.
 */
export const getLogLevels = withController('Get log levels', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const levels = await logService.getLogLevels();
  sendSuccess(res, 200, { levels });
});
