// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Org service-account management.
 *
 * Route gating (see routes/organization.ts): `requirePermission('service_accounts:manage')`
 * is the capability, `requireOrgScope` the tenancy, and `requireStepUp` guards
 * every WRITE — creating an account or issuing a key mints a long-lived bearer
 * credential, exactly the class of action PAT creation is step-up gated for, and
 * step-up also blocks credential-chaining (a service-account key can never
 * produce the step-up token another key would need, because api-core's
 * `requireStepUp` refuses the principal outright).
 *
 * The Role ceiling is enforced in `service-account-roles.setServiceAccountRoles` from
 * the actor context assembled here, so "a service account can never exceed its
 * creator's permissions" is checked by the same code that checks it for people.
 */

import { sendSuccess } from '@pipeline-builder/api-core';
import type { TokenScope } from '@pipeline-builder/api-core';
import type { Request } from 'express';
import { audit } from '../helpers/audit.js';
import { clientInfoOf } from '../helpers/client-info.js';
import {
  roleAssignmentActor,
  ensureAuthenticated,
  requireOrgScope,
  withController,
} from '../helpers/controller-helper.js';
import type { AccessKeyView } from '../services/api-key-service.js';
import type { RoleAssignmentActor } from '../services/index.js';
import {
  RL_ASSIGN_EXCEEDS_CEILING,
  RL_REQUIRES_SUPERADMIN,
  RL_ROLE_NOT_FOUND,
  RL_SYSTEM_ORG_ROLE_OUTSIDE_SYSTEM_ORG,
  RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN,
} from '../services/roles-errors.js';
import {
  SA_BUILTIN_ROLE_MISSING,
  SA_INVALID_BUDGET,
  SA_INVALID_IP_ALLOWLIST,
  SA_INVALID_NAME,
  SA_INVALID_SCOPE,
  SA_SCOPE_NOT_PERMITTED,
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
  findServiceAccountByName,
  getServiceAccount,
  listServiceAccounts,
  resolveBuiltinRoleId,
  revokeServiceAccountKey,
  serviceAccountBillingSummary,
  snapshotOf,
  updateServiceAccount,
  type ServiceAccountView,
} from '../services/service-account-service.js';
import {
  createServiceAccountKeySchema,
  createServiceAccountSchema,
  provisionServiceAccountKeySchema,
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
  [SA_BUILTIN_ROLE_MISSING]: { status: 409, message: 'This organization has no built-in Role for the requested role. Every organization is seeded with it at creation, so it was removed outside the API — recreate it, then retry' },
  [SA_SCOPE_NOT_PERMITTED]: { status: 403, message: 'You cannot issue a key with this capability: scim needs organization admin (or members:manage and roles:manage) on an SSO-entitled organization, and registry:push needs plugins:write' },
  [RL_ROLE_NOT_FOUND]: { status: 404, message: 'One or more roles do not exist in this organization' },
  [RL_REQUIRES_SUPERADMIN]: { status: 403, message: 'Only a platform superadmin can grant a superadmin role' },
  [RL_ASSIGN_EXCEEDS_CEILING]: { status: 403, message: 'You cannot grant a service account a role carrying permissions you do not hold yourself' },
  [RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN]: { status: 403, message: 'Only a platform superadmin can grant an ecosystem-management role' },
  [RL_SYSTEM_ORG_ROLE_OUTSIDE_SYSTEM_ORG]: { status: 400, message: 'An ecosystem-management role can only be held in the system organization' },
};

/**
 * The actor context the Role ceiling is evaluated against — identical to the
 * one `organization-roles.ts` builds for assigning a Role to a person, plus the
 * creator identity recorded on a new account for attribution.
 */
/** The shared actor, plus the identity this controller records on the audit row. */
function assignmentActor(req: Request): RoleAssignmentActor & { userId?: string; email?: string } {
  return {
    ...roleAssignmentActor(req),
    ...(req.user?.sub ? { userId: req.user.sub } : {}),
    ...(req.user?.email ? { email: req.user.email } : {}),
  };
}

/*
 * The audit rows of the three credential writes. Shared by the individual
 * routes and by provision-key, so a provisioned credential leaves EXACTLY the
 * trail the same steps taken one at a time would.
 */

/** `org.service-account.create`. */
function auditAccountCreated(req: Request, orgId: string, account: ServiceAccountView): void {
  audit(req, 'org.service-account.create', {
    targetType: 'service-account',
    targetId: account.id,
    affectedOrgId: orgId,
    details: {
      name: account.name,
      roles: account.roles.map((r) => r.name),
      tokenBudget: account.tokenBudget,
      // The billing rule, recorded with the grant it applies to.
      seatsConsumed: 0,
    },
  });
}

/** `org.service-account.key.create`. */
function auditKeyCreated(req: Request, orgId: string, accountId: string, view: AccessKeyView): void {
  audit(req, 'org.service-account.key.create', {
    targetType: 'access-key',
    targetId: view.id,
    affectedOrgId: orgId,
    details: {
      serviceAccountId: accountId,
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
}

/** `org.service-account.key.revoke`. */
function auditKeyRevoked(req: Request, orgId: string, accountId: string, revoked: AccessKeyView): void {
  audit(req, 'org.service-account.key.revoke', {
    targetType: 'access-key',
    targetId: revoked.id,
    affectedOrgId: orgId,
    details: { serviceAccountId: accountId, keyId: revoked.id, name: revoked.name },
  });
}

/** GET /organization/:id/service-accounts — list the org's accounts + their keys. */
export const getOrganizationServiceAccounts = withController('List service accounts', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
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
  if (!ensureAuthenticated(req, res)) return;
  const id = req.params.id as string;
  if (!(await requireOrgScope(req, res, id))) return;
  sendSuccess(res, 200, { serviceAccount: await getServiceAccount(id, req.params.accountId as string) });
}, serviceAccountErrors);

/** POST /organization/:id/service-accounts — create an account (step-up gated). */
export const createOrganizationServiceAccount = withController('Create service account', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const id = req.params.id as string;
  if (!(await requireOrgScope(req, res, id))) return;

  const body = validateBody(createServiceAccountSchema, req.body, res);
  if (!body) return;

  const account = await createServiceAccount(id, body, assignmentActor(req));
  auditAccountCreated(req, id, account);
  sendSuccess(res, 201, { serviceAccount: account }, 'Service account created');
}, serviceAccountErrors);

/** PATCH /organization/:id/service-accounts/:accountId — description/budget/disabled/roles. */
export const updateOrganizationServiceAccount = withController('Update service account', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const id = req.params.id as string;
  const accountId = req.params.accountId as string;
  if (!(await requireOrgScope(req, res, id))) return;

  const body = validateBody(updateServiceAccountSchema, req.body, res);
  if (!body) return;

  const { account, before } = await updateServiceAccount(id, accountId, body, assignmentActor(req));
  audit(req, 'org.service-account.update', {
    targetType: 'service-account',
    targetId: account.id,
    affectedOrgId: id,
    details: {
      name: account.name,
      // Which fields the request actually asked to change (never their secrets —
      // there are none on an account).
      changed: Object.keys(body),
      before,
      after: snapshotOf(account),
    },
  });
  sendSuccess(res, 200, { serviceAccount: account }, 'Service account updated');
}, serviceAccountErrors);

/** DELETE /organization/:id/service-accounts/:accountId — delete account + keys. */
export const deleteOrganizationServiceAccount = withController('Delete service account', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const id = req.params.id as string;
  const accountId = req.params.accountId as string;
  if (!(await requireOrgScope(req, res, id))) return;

  const account = await deleteServiceAccount(id, accountId, roleAssignmentActor(req));
  audit(req, 'org.service-account.delete', {
    targetType: 'service-account',
    targetId: account.id,
    affectedOrgId: id,
    details: { name: account.name, keysDeleted: account.keys.length },
  });
  sendSuccess(res, 200, undefined, 'Service account deleted');
}, {
  ...serviceAccountErrors,
  // Deleting strips every Role the account holds — refused like removing one.
  [RL_REQUIRES_SUPERADMIN]: { status: 403, message: 'Only a platform superadmin can delete a service account holding a superadmin role' },
  [RL_ASSIGN_EXCEEDS_CEILING]: { status: 403, message: 'You cannot delete this service account: it holds a role granting permissions you do not hold yourself' },
});

/**
 * POST /organization/:id/service-accounts/:accountId/keys — issue a `pb_sa_` key.
 * The raw key is returned ONCE; only its hash is stored.
 */
export const createOrganizationServiceAccountKey = withController('Create service-account key', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
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
  }, assignmentActor(req));
  auditKeyCreated(req, id, accountId, view);
  sendSuccess(res, 201, { key, accessKey: view }, 'Key created');
}, serviceAccountErrors);

/** DELETE /organization/:id/service-accounts/:accountId/keys/:keyId — revoke one key. */
export const revokeOrganizationServiceAccountKey = withController('Revoke service-account key', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const id = req.params.id as string;
  const accountId = req.params.accountId as string;
  if (!(await requireOrgScope(req, res, id))) return;

  const revoked = await revokeServiceAccountKey(id, accountId, req.params.keyId as string);
  auditKeyRevoked(req, id, accountId, revoked);
  sendSuccess(res, 200, { revoked: true }, 'Key revoked');
}, serviceAccountErrors);

/** A thrown service error's code (the services throw `new Error(CODE)`). */
function errorCode(err: unknown): string | undefined {
  return err instanceof Error ? err.message : undefined;
}

/**
 * POST /organization/:id/service-accounts/provision-key — the whole of
 * `pipeline-manager infra store-token`'s provisioning behind ONE step-up.
 *
 * The gates are the union of the create-account and issue-key routes (see
 * routes/organization.ts), and every step is the SAME service call those routes
 * make — with the same ceiling and the same audit row:
 *   1. find the account by name; if there is none, create it, granting the org's
 *      built-in Role for `role` (through the creator's ceiling). An EXISTING
 *      account's Roles are never touched — an operator who narrowed them by
 *      hand must not have that undone by the next run. A concurrent create
 *      (`SA_NAME_TAKEN`) is resolved by re-reading;
 *   2. issue the key; at the active-key cap (`SA_KEY_LIMIT`, which the service
 *      raises only once the mint is otherwise allowed), revoke the OLDEST active
 *      key and retry once — the credential a re-run replaces is the one that
 *      should go.
 *
 * Nothing the caller was holding is revoked beyond that: the CLI stores the new
 * key first and retires the old one itself, so a failure leaves a working
 * credential in place.
 */
export const provisionOrganizationServiceAccountKey = withController('Provision service-account key', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const id = req.params.id as string;
  if (!(await requireOrgScope(req, res, id))) return;

  const body = validateBody(provisionServiceAccountKeySchema, req.body, res);
  if (!body) return;
  const actor = assignmentActor(req);

  let account = await findServiceAccountByName(id, body.accountName);
  let created = false;
  if (!account) {
    const roleIds = body.role ? [await resolveBuiltinRoleId(id, body.role)] : [];
    try {
      account = await createServiceAccount(id, {
        name: body.accountName,
        ...(body.description !== undefined ? { description: body.description } : {}),
        roleIds,
      }, actor);
      created = true;
      auditAccountCreated(req, id, account);
    } catch (err) {
      if (errorCode(err) !== SA_NAME_TAKEN) throw err;
      // Another run created it between the read and the write: use theirs.
      account = await findServiceAccountByName(id, body.accountName);
      if (!account) throw err;
    }
  }
  const accountId = account.id;

  const keyInput = {
    name: body.key.name,
    expiresInSeconds: body.key.expiresIn,
    ...(body.scope ? { scope: body.scope as TokenScope } : {}),
    client: clientInfoOf(req),
  };
  const retiredKeyIds: string[] = [];
  let minted: { key: string; view: AccessKeyView };
  try {
    minted = await createServiceAccountKey(id, accountId, keyInput, actor);
  } catch (err) {
    if (errorCode(err) !== SA_KEY_LIMIT) throw err;
    const { keys } = await getServiceAccount(id, accountId);
    const oldest = keys
      .filter((k) => k.status === 'active')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!oldest) throw err;
    const revoked = await revokeServiceAccountKey(id, accountId, oldest.id);
    auditKeyRevoked(req, id, accountId, revoked);
    retiredKeyIds.push(revoked.id);
    minted = await createServiceAccountKey(id, accountId, keyInput, actor);
  }
  auditKeyCreated(req, id, accountId, minted.view);

  sendSuccess(res, 201, {
    organizationId: id,
    serviceAccount: { id: accountId, name: account.name, created },
    key: minted.key,
    accessKey: { id: minted.view.id, expiresAt: minted.view.expiresAt, scope: minted.view.scope },
    retiredKeyIds,
  }, 'Key provisioned');
}, serviceAccountErrors);
