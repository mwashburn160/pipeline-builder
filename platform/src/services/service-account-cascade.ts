// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org-teardown half of service accounts — deliberately its OWN module.
 *
 * `org-cascade-service` runs inside the org purge, and everything it imports
 * becomes part of that graph. The full `service-account-service` reaches the
 * key service and the token signer (it has to: it MINTS credentials), which the
 * teardown needs none of. Keeping the two org-scoped operations here means the
 * cascade pulls in three model modules and nothing else.
 *
 * Both operations are keyed by the owning org, and neither touches a user: a
 * service account belongs to the ORG, so the org's lifecycle is what ends it.
 */

import { Types } from 'mongoose';
import { toOrgId } from '../helpers/org-id.js';
import PersonalAccessToken from '../models/personal-access-token.js';
import RoleAssignment from '../models/role-assignment.js';
import ServiceAccount from '../models/service-account.js';

/** Every service-account id owned by `orgId`. */
async function accountIdsForOrg(orgId: string): Promise<Types.ObjectId[]> {
  const docs = await ServiceAccount.find({ organizationId: toOrgId(orgId) }).select('_id').lean();
  return docs.map((d) => d._id as Types.ObjectId);
}

/**
 * HARD-delete every service account of an org, with its keys and its Role
 * assignments — the org purge leg. Returns the row counts for the cascade
 * report.
 *
 * Order matters: keys first, then assignments, then the accounts. An interrupted
 * purge can therefore only ever leave an account with FEWER credentials, never a
 * live key whose account is gone.
 */
export async function deleteServiceAccountsForOrg(orgId: string): Promise<{ accounts: number; keys: number }> {
  const ids = await accountIdsForOrg(orgId);
  if (ids.length === 0) return { accounts: 0, keys: 0 };

  const keys = await PersonalAccessToken.deleteMany({ serviceAccountId: { $in: ids } });
  await RoleAssignment.deleteMany({ serviceAccountId: { $in: ids } });
  const accounts = await ServiceAccount.deleteMany({ _id: { $in: ids } });
  return { accounts: accounts.deletedCount ?? 0, keys: keys.deletedCount ?? 0 };
}

/**
 * REVOKE (but keep) every key of every service account in an org — the
 * SOFT-delete leg, mirroring how a member's PATs are revoked on tombstone.
 *
 * A service account has no session and no `tokenVersion`, so the member-session
 * cut-off does not reach it; without this its automation would keep writing to a
 * tombstoned org for the whole retention window. Revoking (not deleting) is what
 * lets a restore within the window keep the accounts and their Roles — the
 * operator reissues keys. Returns how many keys were revoked.
 */
export async function revokeServiceAccountKeysForOrg(orgId: string): Promise<number> {
  const ids = await accountIdsForOrg(orgId);
  if (ids.length === 0) return 0;
  const res = await PersonalAccessToken.updateMany(
    { serviceAccountId: { $in: ids }, revoked: false },
    { $set: { revoked: true, revokedAt: new Date() } },
  );
  return res.modifiedCount ?? 0;
}
