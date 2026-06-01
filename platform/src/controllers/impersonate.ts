// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sysadmin impersonation — read-only "view as user X".
 *
 *   POST /api/admin/impersonate/:userId
 *
 * Sysadmin + step-up gated. Returns an access token that grants the
 * caller the target user's identity for the next 15 minutes. The token
 * carries `impersonationReadOnly: true` so the `requireWriteAccess`
 * middleware rejects any state-changing request — operators can
 * reproduce a tenant's view for support work without risk of acting
 * destructively under that identity.
 *
 * No refresh token is issued. The frontend stores the token, swaps it
 * into the api client, and clears it on "Stop impersonating".
 */

import { createLogger, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit';
import { requireSystemAdmin, withController } from '../helpers/controller-helper';
import { User } from '../models';
import { issueImpersonationToken } from '../utils/token';

const logger = createLogger('impersonate');

export const impersonateUser = withController('Impersonate user', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  // Disallow impersonating from within an impersonation session — keeps
  // the audit trail straightforward (always sysadmin → user, never chained).
  if (req.user?.impersonatorId) {
    return sendError(res, 400, 'Cannot impersonate from within an impersonation session');
  }

  const impersonatorId = req.user!.sub;
  const targetUserId = String(req.params.userId);
  if (targetUserId === impersonatorId) {
    return sendError(res, 400, 'Cannot impersonate yourself');
  }

  // `+isSuperAdmin` opts in to a schema field with `select: false`. Without
  // this, the check below would silently see `undefined` and let an
  // attacker (or a careless admin) impersonate a fellow sysadmin —
  // exactly the laundering-of-authority case the check is meant to
  // prevent.
  const target = await User.findById(targetUserId).select('+isSuperAdmin');
  if (!target) return sendError(res, 404, 'User not found');

  // Refuse to impersonate another sysadmin — defense against a compromised
  // sysadmin laundering authority by impersonating peers. Two sysadmins
  // should not be able to mask their action trails under each other.
  if ((target as { isSuperAdmin?: boolean }).isSuperAdmin === true) {
    return sendError(res, 400, 'Cannot impersonate another sysadmin');
  }

  const { accessToken, expiresIn } = await issueImpersonationToken(target, impersonatorId);

  audit(req, 'admin.impersonate.start', {
    targetType: 'user',
    targetId: targetUserId,
    details: { impersonatorId, expiresIn },
  });
  logger.info('Sysadmin impersonation started', { impersonatorId, targetUserId, expiresIn });

  sendSuccess(res, 200, { accessToken, expiresIn, targetUserId });
});
