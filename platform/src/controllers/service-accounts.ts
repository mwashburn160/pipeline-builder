// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Org service-account management (#2).
 *
 * Route gating (see routes/organization.ts): `requirePermission('service_accounts:manage')`
 * is the capability, `requireOrgScope` the tenancy, and `requireStepUp` guards
 * every WRITE — creating an account or issuing a key mints a long-lived bearer
 * credential, exactly the class of action PAT creation is step-up gated for, and
 * step-up also blocks credential-chaining (a service-account key can never
 * produce the step-up token another key would need, because api-core's
 * `requireStepUp` refuses the principal outright).
 *
 * The Role ceiling is enforced in `roles-service.setServiceAccountRoles` from
 * the actor context assembled here, so "a service account can never exceed its
 * creator's permissions" is checked by the same code that checks it for people.
 */

import { sendSuccess } from '@pipeline-builder/api-core';
import type { TokenScope } from '@pipeline-builder/api-core';
import type { Request } from 'express';
import { audit } from '../helpers/audit.js';
import { clientInfoOf } from '../helpers/client-info.js';
import {
  getAdminContext,
  requireAuth,
  requireOrgScope,
  withController,
} from '../helpers/controller-helper.js';
import type { RoleAssignmentActor } from '../services/index.js';
import {
  RL_ASSIGN_EXCEEDS_CEILING,
  RL_REQUIRES_SUPERADMIN,
  RL_ROLE_NOT_FOUND,
} from '../services/roles-errors.js';
import {
  SA_INVALID_BUDGET,
  SA_INVALID_IP_ALLOWLIST,
  SA_INVALID_NAME,
  SA_INVALID_SCOPE,
  SA_KEY_EXPIRY_INVALID,
  SA_KEY_LIMIT,
  SA_KEY_NOT_FOUND,
  SA_LIMIT,
  SA_NAME_TAKEN,
  SA_NOT_FOUND,
  SA_ORG_NOT_FOUND,
} from '../services/service-account-errors.js';
import {
  createServiceAccount,
  createServiceAccountKey,
  deleteServiceAccount,
  getServiceAccount,
  listServiceAccounts,
  revokeServiceAccountKey,
  serviceAccountBillingSummary,
  updateServiceAccount,
} from '../services/service-account-service.js';
import {
  createServiceAccountKeySchema,
  createServiceAccountSchema,
  updateServiceAccountSchema,
  validateBody,
} from '../utils/validation.js';

/** Errors every service-account route maps the same way. */
const serviceAccountErrors = {
  [SA_NOT_FOUND]: { status: 404, message: 'Service account not found' },
  [SA_ORG_NOT_FOUND]: { status: 404, message: 'Organization not found' },
  [SA_NAME_TAKEN]: { status: 409, message: 'A service account with this name already exists' },
  [SA_INVALID_NAME]: { status: 400, message: 'name must be 2-64 characters of lowercase letters, digits, hyphen or underscore' },
  [SA_LIMIT]: { status: 409, message: 'This organization has reached its service-account limit' },
  [SA_INVALID_BUDGET]: { status: 400, message: 'tokenBudget must be a positive integer, or -1 for unlimited' },
  [SA_KEY_LIMIT]: { status: 409, message: 'This service account already has the maximum number of active keys — revoke one first' },
  [SA_KEY_EXPIRY_INVALID]: { status: 400, message: 'expiresIn must be a positive number of seconds, at most 365 days' },
  [SA_INVALID_IP_ALLOWLIST]: { status: 400, message: 'ipAllowlist entries must be IP addresses or CIDR blocks' },
  [SA_KEY_NOT_FOUND]: { status: 404, message: 'Key not found or already revoked' },
  [SA_INVALID_SCOPE]: { status: 400, message: 'scope is not a recognised capability scope' },
  [RL_ROLE_NOT_FOUND]: { status: 404, message: 'One or more roles do not exist in this organization' },
  [RL_REQUIRES_SUPERADMIN]: { status: 403, message: 'Only a platform superadmin can grant a superadmin role' },
  [RL_ASSIGN_EXCEEDS_CEILING]: { status: 403, message: 'You cannot grant a service account a role carrying permissions you do not hold yourself' },
};

/**
 * The actor context the Role ceiling is evaluated against — identical to the
 * one `organization-roles.ts` builds for assigning a Role to a person, plus the
 * creator identity recorded on a new account for attribution.
 */
function assignmentActor(req: Request): RoleAssignmentActor & { userId?: string; email?: string } {
  const admin = getAdminContext(req);
  return {
    isSuperAdmin: admin.isSuperAdmin,
    isOrgAdmin: admin.isOrgAdmin,
    permissions: req.user?.permissions ?? [],
    ...(req.user?.sub ? { userId: req.user.sub } : {}),
    ...(req.user?.email ? { email: req.user.email } : {}),
  };
}

/** GET /organization/:id/service-accounts — list the org's accounts + their keys. */
export const getOrganizationServiceAccounts = withController('List service accounts', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const id = req.params.id as string;
  // Same gate as the writes: the route carries `service_accounts:manage`, and
  // this adds the tenancy scope (own org, a managed team, or a sysadmin). Key
  // SECRETS are never in this payload, but the inventory itself is not
  // something a plain member has any reason to read.
  if (!(await requireOrgScope(req, res, id))) return;
  const [serviceAccounts, billing] = await Promise.all([
    listServiceAccounts(id),
    serviceAccountBillingSummary(id),
  ]);
  sendSuccess(res, 200, { serviceAccounts, billing });
}, serviceAccountErrors);

/** GET /organization/:id/service-accounts/:accountId — one account + its keys. */
export const getOrganizationServiceAccount = withController('Get service account', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const id = req.params.id as string;
  if (!(await requireOrgScope(req, res, id))) return;
  sendSuccess(res, 200, { serviceAccount: await getServiceAccount(id, req.params.accountId as string) });
}, serviceAccountErrors);

/** POST /organization/:id/service-accounts — create an account (step-up gated). */
export const createOrganizationServiceAccount = withController('Create service account', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const id = req.params.id as string;
  if (!(await requireOrgScope(req, res, id))) return;

  const body = validateBody(createServiceAccountSchema, req.body, res);
  if (!body) return;

  const account = await createServiceAccount(id, body, assignmentActor(req));
  audit(req, 'org.service-account.create', {
    targetType: 'service-account',
    targetId: account.id,
    affectedOrgId: id,
    details: {
      name: account.name,
      roles: account.roles.map((r) => r.name),
      tokenBudget: account.tokenBudget,
      // The billing rule, recorded with the grant it applies to.
      seatsConsumed: 0,
    },
  });
  sendSuccess(res, 201, { serviceAccount: account }, 'Service account created');
}, serviceAccountErrors);

/** PATCH /organization/:id/service-accounts/:accountId — description/budget/disabled/roles. */
export const updateOrganizationServiceAccount = withController('Update service account', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const id = req.params.id as string;
  const accountId = req.params.accountId as string;
  if (!(await requireOrgScope(req, res, id))) return;

  const body = validateBody(updateServiceAccountSchema, req.body, res);
  if (!body) return;

  const account = await updateServiceAccount(id, accountId, body, assignmentActor(req));
  audit(req, 'org.service-account.update', {
    targetType: 'service-account',
    targetId: account.id,
    affectedOrgId: id,
    details: {
      name: account.name,
      // Which fields the request actually asked to change (never their secrets —
      // there are none on an account).
      changed: Object.keys(body),
      roles: account.roles.map((r) => r.name),
      disabled: account.disabled,
      tokenBudget: account.tokenBudget,
    },
  });
  sendSuccess(res, 200, { serviceAccount: account }, 'Service account updated');
}, serviceAccountErrors);

/** DELETE /organization/:id/service-accounts/:accountId — delete account + keys. */
export const deleteOrganizationServiceAccount = withController('Delete service account', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const id = req.params.id as string;
  const accountId = req.params.accountId as string;
  if (!(await requireOrgScope(req, res, id))) return;

  const account = await deleteServiceAccount(id, accountId);
  audit(req, 'org.service-account.delete', {
    targetType: 'service-account',
    targetId: account.id,
    affectedOrgId: id,
    details: { name: account.name, keysDeleted: account.keys.length },
  });
  sendSuccess(res, 200, undefined, 'Service account deleted');
}, serviceAccountErrors);

/**
 * POST /organization/:id/service-accounts/:accountId/keys — issue a `pb_sa_` key.
 * The raw key is returned ONCE; only its hash is stored.
 */
export const createOrganizationServiceAccountKey = withController('Create service-account key', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const id = req.params.id as string;
  const accountId = req.params.accountId as string;
  if (!(await requireOrgScope(req, res, id))) return;

  const body = validateBody(createServiceAccountKeySchema, req.body, res);
  if (!body) return;

  const { key, view } = await createServiceAccountKey(id, accountId, {
    name: body.name,
    ...(body.expiresIn !== undefined ? { expiresInSeconds: body.expiresIn } : {}),
    ...(body.ipAllowlist ? { ipAllowlist: body.ipAllowlist } : {}),
    ...(body.scope ? { scope: body.scope as TokenScope } : {}),
    client: clientInfoOf(req),
  });
  audit(req, 'org.service-account.key.create', {
    targetType: 'service-account',
    targetId: accountId,
    affectedOrgId: id,
    details: {
      keyId: view.id,
      name: view.name,
      expiresAt: view.expiresAt,
      // The narrow capability this key carries INSTEAD of the account's Roles
      // (null when it carries the account's full authority) — the single most
      // useful field for answering "how much could this credential do?".
      scope: view.scope,
      // WHETHER an allowlist was set, and how many entries — not the addresses,
      // which are infrastructure detail an audit reader doesn't need.
      ipAllowlistEntries: view.ipAllowlist?.length ?? 0,
    },
  });
  sendSuccess(res, 201, { key, accessKey: view }, 'Key created');
}, serviceAccountErrors);

/** DELETE /organization/:id/service-accounts/:accountId/keys/:keyId — revoke one key. */
export const revokeOrganizationServiceAccountKey = withController('Revoke service-account key', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const id = req.params.id as string;
  const accountId = req.params.accountId as string;
  if (!(await requireOrgScope(req, res, id))) return;

  const revoked = await revokeServiceAccountKey(id, accountId, req.params.keyId as string);
  audit(req, 'org.service-account.key.revoke', {
    targetType: 'service-account',
    targetId: accountId,
    affectedOrgId: id,
    details: { keyId: revoked.id, name: revoked.name },
  });
  sendSuccess(res, 200, { revoked: true }, 'Key revoked');
}, serviceAccountErrors);
