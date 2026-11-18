// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An organization's "setup guide" flag — read and update.
 *
 *   GET   /organization/:id/setup-guide
 *   PATCH /organization/:id/setup-guide   { dismissed: boolean }
 *
 * The dashboard offers org admins a one-time "finish setting up your org" guide
 * (install the CLI, store tokens, set up events) until one of them dismisses it.
 * `dismissed: true` stamps when and by whom (idempotent — a second dismiss keeps
 * the first stamp); `dismissed: false` clears both, so a "show the setup guide
 * again" link can re-arm it.
 *
 * Gated on `org_settings:write` at the route and on `canManageOrgScope` here —
 * the same tenancy rule as the org policy routes, so a parent-org admin may
 * dismiss a team's guide. Unlike those routes there is NO step-up: this is a UI
 * preference, not a security control, and nothing about the org's protection
 * changes with it.
 */

import { getParam, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { canManageOrgScope, ensureAuthenticated, forbid, withController } from '../helpers/controller-helper.js';
import { readSetupGuide, writeSetupGuide } from '../services/org-setup-guide-service.js';
import { updateSetupGuideSchema, validateBody } from '../utils/validation.js';

export const getSetupGuide = withController('Get setup guide', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const id = getParam(req.params, 'id')!;
  if (!(await canManageOrgScope(req, id))) {
    return forbid(req, res, 'org-admin', 'You can only view the setup guide of an organization you administer');
  }
  const view = await readSetupGuide(id);
  if (!view) return sendError(res, 404, 'Organization not found');
  sendSuccess(res, 200, view);
});

export const updateSetupGuide = withController('Update setup guide', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const id = getParam(req.params, 'id')!;
  if (!(await canManageOrgScope(req, id))) {
    return forbid(req, res, 'org-admin', 'You can only change the setup guide of an organization you administer');
  }

  const body = validateBody(updateSetupGuideSchema, req.body, res);
  if (!body) return;

  const before = await readSetupGuide(id);
  if (!before) return sendError(res, 404, 'Organization not found');

  const after = await writeSetupGuide(id, body.dismissed, req.user!.sub);
  // Deleted between the read and the write.
  if (!after) return sendError(res, 404, 'Organization not found');

  audit(req, 'org.setup_guide.update', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: id,
    details: { dismissed: { from: before.dismissedAt !== null, to: after.dismissedAt !== null } },
  });

  sendSuccess(res, 200, after, body.dismissed ? 'Setup guide dismissed' : 'Setup guide re-enabled');
});
