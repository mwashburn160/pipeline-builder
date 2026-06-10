// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * User-grant admin endpoints (sysadmin-gated).
 *
 *   POST   /api/admin/users/:id/grants  add a grant to a user
 *   DELETE /api/admin/users/:id/grants  remove a grant from a user
 *
 * Both require `{ "grant": "<name>" }` in the body. Generic path keeps
 * the privilege surface from being telegraphed in access logs; future
 * grants (e.g. audit-read, data-export) slot in without new routes.
 *
 * Today's only grant is `platform-admin`, which maps to `User.isSuperAdmin`.
 * Used by an existing sysadmin to promote peers (steady-state); the first
 * sysadmin in a fresh deploy comes from `BOOTSTRAP_SUPERADMIN_EMAILS`.
 *
 * Both endpoints are idempotent — re-granting an already-granted user is
 * a no-op + 200; same for re-revoking. The audit log captures only actual
 * state transitions (not no-ops) so on-call isn't flooded with churn.
 *
 * Self-revoke guard: an active sysadmin can't revoke their own
 * `platform-admin` grant. Operators with two grants (one in
 * BOOTSTRAP_SUPERADMIN_EMAILS, one via this endpoint) lose ONLY the
 * endpoint grant — the bootstrap re-promotes on next boot. Without the
 * guard, a misclicking sysadmin could lock the org out of administrative
 * access until a deploy.
 */

import { sendError, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { requireSystemAdmin, withController } from '../helpers/controller-helper.js';
import { User } from '../models/index.js';

/** All grant names this endpoint understands. */
type GrantName = 'platform-admin';
const KNOWN_GRANTS: readonly GrantName[] = ['platform-admin'] as const;

function parseBody(body: unknown): { grant: GrantName } | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'body must be a JSON object' };
  const g = (body as { grant?: unknown }).grant;
  if (typeof g !== 'string') return { error: 'grant is required and must be a string' };
  if (!(KNOWN_GRANTS as readonly string[]).includes(g)) {
    return { error: `grant must be one of: ${KNOWN_GRANTS.join(', ')}` };
  }
  return { grant: g as GrantName };
}

/** POST /api/admin/users/:id/grants */
export const addUserGrant = withController('Add user grant', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  const userId = String(req.params.id);

  const parsed = parseBody(req.body);
  if ('error' in parsed) return sendError(res, 400, parsed.error);

  const user = await User.findById(userId).select('email isSuperAdmin');
  if (!user) return sendError(res, 404, 'User not found');

  if (parsed.grant === 'platform-admin') {
    if (user.isSuperAdmin === true) {
      // Idempotent — no state change, no audit event.
      return sendSuccess(res, 200, { userId, grant: parsed.grant, changed: false });
    }
    user.isSuperAdmin = true;
    await user.save();
    audit(req, 'admin.superadmin.grant', {
      targetType: 'user',
      targetId: userId,
      details: { email: user.email, source: 'admin-api', grant: parsed.grant },
    });
    return sendSuccess(res, 200, { userId, grant: parsed.grant, changed: true });
  }

  // Defensive — `parseBody` should have caught unknown grants.
  return sendError(res, 400, `unsupported grant: ${parsed.grant}`);
});

/** DELETE /api/admin/users/:id/grants */
export const removeUserGrant = withController('Remove user grant', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  const userId = String(req.params.id);

  const parsed = parseBody(req.body);
  if ('error' in parsed) return sendError(res, 400, parsed.error);

  if (parsed.grant === 'platform-admin') {
    // Self-revoke guard. Without this, a sysadmin who fat-fingers their
    // own user id could leave the org with no administrative access
    // until the next deploy.
    if (req.user?.sub === userId) {
      return sendError(
        res, 400,
        'Sysadmins cannot revoke their own platform-admin grant. Ask another sysadmin to revoke you.',
      );
    }

    const user = await User.findById(userId).select('email isSuperAdmin');
    if (!user) return sendError(res, 404, 'User not found');

    if (user.isSuperAdmin !== true) {
      return sendSuccess(res, 200, { userId, grant: parsed.grant, changed: false });
    }

    user.isSuperAdmin = false;
    await user.save();
    audit(req, 'admin.superadmin.revoke', {
      targetType: 'user',
      targetId: userId,
      details: { email: user.email, source: 'admin-api', grant: parsed.grant },
    });
    return sendSuccess(res, 200, { userId, grant: parsed.grant, changed: true });
  }

  return sendError(res, 400, `unsupported grant: ${parsed.grant}`);
});
