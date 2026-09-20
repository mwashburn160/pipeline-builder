// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Make TURNING ON an org's "administrative actions require MFA" policy take
 * effect NOW rather than at each member's next token refresh. (Turning it off
 * is left to refresh: a stale token is then stricter, never weaker.)
 *
 * The policy travels to the services as the `org_admin_aal` claim, which is
 * decided when a token is ISSUED. A token minted before the change still says
 * whatever the policy used to say — so turning the policy on would otherwise
 * leave every outstanding single-factor session able to act as an admin until
 * it next refreshed. This bumps `tokenVersion` for every ACTIVE member of the
 * org AND of its teams (a parent's setting applies to them, strictest wins),
 * and publishes the new versions so the stateless services refuse the old
 * tokens immediately — the same "privilege change ⇒ bump" rule every role,
 * membership and tier change follows.
 *
 * The ACTOR is excluded: invalidating their own token would bounce them to the
 * sign-in screen mid-save. Their current access token keeps the old claim until
 * it expires (one access-token lifetime) and the next refresh picks it up.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { expandOrgScope } from '../helpers/org-hierarchy.js';
import { toOrgId } from '../helpers/org-id.js';
import { publishUsersRevocation } from '../helpers/session-revocation.js';
import { User, UserOrganization } from '../models/index.js';

const logger = createLogger('admin-mfa-claims');

/**
 * Bump `tokenVersion` for every active member of `orgId` and its live teams,
 * except `actorUserId`. Returns how many accounts were bumped.
 */
export async function refreshAdminPolicyClaims(orgId: string, actorUserId: string): Promise<number> {
  const scope = await expandOrgScope(orgId);
  const memberships = await UserOrganization.find({
    organizationId: { $in: scope.map((id) => toOrgId(id)) },
    isActive: true,
  }).select('userId').lean();

  const ids = [...new Set(memberships.map((m) => String(m.userId)))].filter((id) => id !== actorUserId);
  if (ids.length === 0) return 0;

  await User.updateMany({ _id: { $in: ids } }, { $inc: { tokenVersion: 1 } });
  await publishUsersRevocation(ids);
  logger.info('Admin-actions MFA policy changed; member sessions refreshed', { orgId, count: ids.length });
  return ids.length;
}
