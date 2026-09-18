// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ORG-ADMIN SELF-SERVICE for IdP group → Role mappings (3a).
 *
 *   GET    /organization/:id/idp/group-mappings            → list
 *   POST   /organization/:id/idp/group-mappings            → create
 *   PUT    /organization/:id/idp/group-mappings/:mappingId → update
 *   DELETE /organization/:id/idp/group-mappings/:mappingId → delete
 *
 * Layered gates, one per question:
 *   - route:      `requirePermission('roles:manage')` — a mapping IS a Role
 *                 grant, so it is governed by the capability that governs Roles,
 *                 NOT by `org:idp` (which controls the login connection). An org
 *                 can therefore let one delegate run the IdP connection and
 *                 another decide what its groups are worth.
 *   - controller: `requireOwnOrgSso` — own org / managed team, AND the org is
 *                 `sso`-entitled (JIT ships inside the SSO entitlement).
 *   - service:    the Role ceiling + the owner/platform-admin refusal
 *                 (`assertMappableRoleSet`), so a delegate can never author a
 *                 rule granting more than they hold themselves.
 *
 * The sibling IdP-connection routes live in `controllers/org-idp-self.ts`.
 */

import { getParam, sendSuccess } from '@pipeline-builder/api-core';
import type { Request } from 'express';
import { audit } from '../helpers/audit.js';
import { getAdminContext, requireAuth, withController } from '../helpers/controller-helper.js';
import { requireOwnOrgSso } from '../helpers/sso-enforcement.js';
import { idpGroupMappingService, MAX_MAPPINGS_PER_ORG } from '../services/idp-group-mapping-service.js';
import {
  IGM_FORBIDDEN_GRANT,
  IGM_GROUP_TAKEN,
  IGM_LIMIT,
  IGM_NOT_CONFIGURED,
  IGM_NOT_FOUND,
  IGM_PROVIDER_UNSUPPORTED,
} from '../services/idp-mapping-errors.js';
import { RL_ASSIGN_EXCEEDS_CEILING, RL_ROLE_NOT_FOUND } from '../services/roles-errors.js';
import type { RoleAssignmentActor } from '../services/roles-service.js';
import { idpGroupMappingCreateSchema, idpGroupMappingUpdateSchema, validateBody } from '../utils/validation.js';

/**
 * The actor context for authoring a mapping — identical to the one a direct Role
 * assignment uses, because a mapping grants exactly the same thing: a superadmin
 * or an org admin/owner may map any of the org's Roles; a delegate holding only
 * `roles:manage` may map a Role only when its permissions are within their own.
 */
function mappingActor(req: Request): RoleAssignmentActor {
  const admin = getAdminContext(req);
  return {
    isSuperAdmin: admin.isSuperAdmin,
    isOrgAdmin: admin.isOrgAdmin,
    permissions: req.user?.permissions ?? [],
  };
}

/** Shared status map — the same refusal means the same thing on every verb. */
const MAPPING_ERROR_MAP = {
  [IGM_NOT_CONFIGURED]: { status: 409, message: 'Configure an identity provider for this organization before mapping its groups' },
  [IGM_PROVIDER_UNSUPPORTED]: {
    status: 400,
    message: 'Group-to-Role mapping is not available for Google: Google\'s OIDC tokens carry no group claim. Use a generic OIDC or Cognito identity provider.',
  },
  [IGM_GROUP_TAKEN]: { status: 409, message: 'A mapping for this group already exists' },
  [IGM_NOT_FOUND]: { status: 404, message: 'Group mapping not found' },
  [IGM_LIMIT]: { status: 409, message: `An organization can hold at most ${MAX_MAPPINGS_PER_ORG} group mappings` },
  [IGM_FORBIDDEN_GRANT]: { status: 403, message: 'A group mapping cannot grant organization ownership or platform-administrator authority' },
  [RL_ROLE_NOT_FOUND]: { status: 404, message: 'One or more roles do not exist in this organization' },
  [RL_ASSIGN_EXCEEDS_CEILING]: { status: 403, message: 'You cannot map a role granting permissions you do not hold yourself' },
} as const;

/** GET /organization/:id/idp/group-mappings — list this org's mappings. */
export const listOrgIdpGroupMappings = withController('List IdP group mappings', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const orgId = getParam(req.params, 'id')!;
  if (!(await requireOwnOrgSso(req, res, orgId))) return;

  const mappings = await idpGroupMappingService.list(orgId);
  sendSuccess(res, 200, { mappings });
}, MAPPING_ERROR_MAP);

/** POST /organization/:id/idp/group-mappings — map a group to a Role set. */
export const createOrgIdpGroupMapping = withController('Create IdP group mapping', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const orgId = getParam(req.params, 'id')!;
  if (!(await requireOwnOrgSso(req, res, orgId))) return;

  const body = validateBody(idpGroupMappingCreateSchema, req.body, res);
  if (!body) return;

  const mapping = await idpGroupMappingService.create(orgId, req.user!.sub as string, body, mappingActor(req));
  audit(req, 'org.idp.mapping.upsert', {
    targetType: 'idp-group-mapping',
    targetId: mapping.id,
    affectedOrgId: orgId,
    details: { group: mapping.group, roleIds: mapping.roleIds, created: true },
  });
  sendSuccess(res, 201, { mapping }, 'Group mapping created');
}, MAPPING_ERROR_MAP);

/** PUT /organization/:id/idp/group-mappings/:mappingId — edit group and/or Roles. */
export const updateOrgIdpGroupMapping = withController('Update IdP group mapping', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const orgId = getParam(req.params, 'id')!;
  if (!(await requireOwnOrgSso(req, res, orgId))) return;

  const body = validateBody(idpGroupMappingUpdateSchema, req.body, res);
  if (!body) return;

  const mappingId = getParam(req.params, 'mappingId')!;
  const mapping = await idpGroupMappingService.update(orgId, mappingId, req.user!.sub as string, body, mappingActor(req));
  audit(req, 'org.idp.mapping.upsert', {
    targetType: 'idp-group-mapping',
    targetId: mapping.id,
    affectedOrgId: orgId,
    details: { group: mapping.group, roleIds: mapping.roleIds, created: false },
  });
  sendSuccess(res, 200, { mapping }, 'Group mapping updated');
}, MAPPING_ERROR_MAP);

/** DELETE /organization/:id/idp/group-mappings/:mappingId — remove a mapping.
 *  Roles already assigned from it fall away at each member's next sign-in. */
export const deleteOrgIdpGroupMapping = withController('Delete IdP group mapping', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const orgId = getParam(req.params, 'id')!;
  if (!(await requireOwnOrgSso(req, res, orgId))) return;

  const mappingId = getParam(req.params, 'mappingId')!;
  await idpGroupMappingService.delete(orgId, mappingId, mappingActor(req));
  audit(req, 'org.idp.mapping.delete', {
    targetType: 'idp-group-mapping',
    targetId: mappingId,
    affectedOrgId: orgId,
  });
  sendSuccess(res, 200, {}, 'Group mapping deleted');
}, MAPPING_ERROR_MAP);
