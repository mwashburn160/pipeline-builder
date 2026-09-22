// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-org IdP group → Role mapping.
 *
 * CRUD for the rules an org's admins author, plus the RESOLVER the sign-in path
 * uses to turn the groups on a validated id_token into a Role set. SCIM
 * shares both halves: its Groups endpoint edits the same rows, and its user sync
 * resolves through {@link resolveMappedRoles} — which is why the resolver takes
 * plain group strings and knows nothing about OIDC.
 *
 * Authority model (the guardrails from the plan, one place each):
 *   - WHO may edit — `roles:manage` at the route, own-org/managed-team scope in
 *     the controller, and the org's `sso` entitlement alongside it.
 *   - WHAT may be granted — {@link assertMappableRoleSet} in the roles service:
 *     the Roles must belong to this org, must not confer platform-admin (and
 *     cannot confer org ownership, which is not a Role), and must be within the
 *     editing actor's own permission ceiling.
 *   - WHERE it applies — every query is filtered by `organizationId`, so a mapping only
 *     ever touches the SSO org's membership.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { IGM_GROUP_TAKEN, IGM_LIMIT, IGM_NOT_CONFIGURED, IGM_NOT_FOUND, IGM_PROVIDER_UNSUPPORTED, MAX_MAPPINGS_PER_ORG } from './idp-mapping-errors.js';
import { assertMappableRoleSet, type MappableRole } from './mapped-roles.js';
import type { RoleAssignmentActor } from './role-authority.js';
import { groupKey, providerSupportsGroups } from '../helpers/idp-claims.js';
import { toOrgId } from '../helpers/org-id.js';
import IdpGroupMapping, { type IdpGroupMappingDocument } from '../models/idp-group-mapping.js';
import { OrgIdpConfig, Role, type RoleGrant } from '../models/index.js';

const logger = createLogger('idp-group-mapping-service');


/** One mapping as the API returns it. Role names are resolved for the editor so
 *  it can show WHICH Roles a group grants without a second round-trip. */
export interface IdpGroupMappingDto {
  id: string;
  group: string;
  roleIds: string[];
  roles: MappableRole[];
  updatedAt: string;
}

function toDto(doc: IdpGroupMappingDocument, byRoleId: Map<string, MappableRole>): IdpGroupMappingDto {
  const roleIds = (doc.roleIds ?? []).map(String);
  return {
    id: String(doc._id),
    group: doc.group,
    roleIds,
    // A Role deleted after the mapping was written simply drops out of the
    // display — the resolver ignores it too, so the two agree.
    roles: roleIds.map((id) => byRoleId.get(id)).filter((r): r is MappableRole => !!r),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/**
 * Confirm the org has an IdP config whose provider can carry groups at all.
 * Google is refused here with its own code so the UI can explain WHY rather than
 * showing a generic validation error (Google's OIDC tokens have no group claim).
 *
 * A SAML config has no named provider and carries groups in a mapped
 * ASSERTION ATTRIBUTE, so the Google carve-out doesn't apply to it — the same
 * mapping rules then govern both protocols, which is the point of feeding both
 * into one resolver.
 */
async function assertGroupsSupported(orgId: string): Promise<void> {
  const cfg = await OrgIdpConfig.findOne({ organizationId: orgId }).select('provider protocol').lean();
  if (!cfg) throw new Error(IGM_NOT_CONFIGURED);
  if (cfg.protocol === 'saml') return;
  if (!cfg.provider || !providerSupportsGroups(cfg.provider)) throw new Error(IGM_PROVIDER_UNSUPPORTED);
}

/** Load the org's Roles named by `roleIds`, keyed by id (for DTO hydration). */
async function rolesById(orgId: string, roleIds: readonly string[]): Promise<Map<string, MappableRole>> {
  const ids = [...new Set(roleIds)];
  if (ids.length === 0) return new Map();
  const roles = await Role.find({ _id: { $in: ids }, organizationId: toOrgId(orgId) })
    .select('name grantsRole').lean();
  return new Map(roles.map((r) => [String(r._id), {
    id: String(r._id),
    name: r.name,
    grantsRole: r.grantsRole as RoleGrant,
  }]));
}

export class IdpGroupMappingService {
  /** Every mapping for an org, oldest group first (stable editor ordering). */
  async list(orgId: string): Promise<IdpGroupMappingDto[]> {
    const docs = await IdpGroupMapping.find({ organizationId: orgId }).sort({ groupKey: 1 });
    const byRoleId = await rolesById(orgId, docs.flatMap((d) => (d.roleIds ?? []).map(String)));
    return docs.map((d) => toDto(d, byRoleId));
  }

  /**
   * Create a mapping. Throws `IGM_NOT_CONFIGURED` / `IGM_PROVIDER_UNSUPPORTED` /
   * `IGM_GROUP_TAKEN` / `IGM_LIMIT`, plus the Role-set errors from
   * {@link assertMappableRoleSet}.
   */
  async create(
    orgId: string,
    actorId: string,
    input: { group: string; roleIds: string[] },
    actor: RoleAssignmentActor,
  ): Promise<IdpGroupMappingDto> {
    await assertGroupsSupported(orgId);
    const roles = await assertMappableRoleSet(orgId, input.roleIds, actor);

    const group = input.group.trim();
    const key = groupKey(group);
    if (await IdpGroupMapping.exists({ organizationId: orgId, groupKey: key })) throw new Error(IGM_GROUP_TAKEN);
    if (await IdpGroupMapping.countDocuments({ organizationId: orgId }) >= MAX_MAPPINGS_PER_ORG) throw new Error(IGM_LIMIT);

    const doc = await IdpGroupMapping.create({
      organizationId: orgId,
      group,
      groupKey: key,
      roleIds: [...new Set(input.roleIds)],
      createdBy: actorId,
      updatedBy: actorId,
    });
    logger.info('IdP group mapping created', { orgId, group: key, roles: roles.length });
    return toDto(doc, new Map(roles.map((r) => [r.id, r])));
  }

  /**
   * Update a mapping's group and/or Role set. The Role ceiling is applied to the
   * INCOMING set and to the set being REMOVED — symmetry with the direct
   * assignment path, so a delegate can't strip a capability they don't hold from
   * everyone the group covers by editing the rule instead of the Role.
   */
  async update(
    orgId: string,
    mappingId: string,
    actorId: string,
    input: { group?: string; roleIds?: string[] },
    actor: RoleAssignmentActor,
  ): Promise<IdpGroupMappingDto> {
    await assertGroupsSupported(orgId);

    const doc = await IdpGroupMapping.findOne({ _id: mappingId, organizationId: orgId });
    if (!doc) throw new Error(IGM_NOT_FOUND);

    if (input.roleIds !== undefined) {
      // What it grants today — checked before any mutation, so a refused edit
      // leaves the rule untouched.
      await assertMappableRoleSet(orgId, (doc.roleIds ?? []).map(String), actor);
      await assertMappableRoleSet(orgId, input.roleIds, actor);
    }

    if (input.group !== undefined) {
      const group = input.group.trim();
      const key = groupKey(group);
      if (key !== doc.groupKey && await IdpGroupMapping.exists({ organizationId: orgId, groupKey: key, _id: { $ne: doc._id } })) {
        throw new Error(IGM_GROUP_TAKEN);
      }
      doc.group = group;
      doc.groupKey = key;
    }
    if (input.roleIds !== undefined) doc.roleIds = [...new Set(input.roleIds)] as never;
    doc.updatedBy = actorId;
    await doc.save();

    logger.info('IdP group mapping updated', { orgId, mappingId, group: doc.groupKey });
    const byRoleId = await rolesById(orgId, (doc.roleIds ?? []).map(String));
    return toDto(doc, byRoleId);
  }

  /**
   * Delete a mapping. The actor must be allowed to grant what it granted (same
   * ceiling as an update) — otherwise a `roles:manage` delegate could revoke a
   * capability they don't hold from every member of the group by deleting the
   * rule. Existing assignments are NOT swept here: they fall away on each
   * member's next sign-in, which is when the rule set is evaluated.
   */
  async delete(orgId: string, mappingId: string, actor: RoleAssignmentActor): Promise<void> {
    const doc = await IdpGroupMapping.findOne({ _id: mappingId, organizationId: orgId }).select('roleIds');
    if (!doc) throw new Error(IGM_NOT_FOUND);
    await assertMappableRoleSet(orgId, (doc.roleIds ?? []).map(String), actor);
    await IdpGroupMapping.deleteOne({ _id: doc._id });
    logger.info('IdP group mapping deleted', { orgId, mappingId });
  }

  /**
   * THE RESOLVER (shared with SCIM): the Role ids an org's mappings grant to a
   * principal carrying `groups`, plus which groups actually matched.
   *
   * Matching is case-insensitive ({@link groupKey}). Roles that no longer exist,
   * that have moved out of the org, or that confer `superadmin` are dropped —
   * the same fail-closed reading the editor enforces at write time, re-applied
   * here because a Role can change after a rule was authored. No groups, or no
   * matching rule, means an EMPTY set: JIT then grants the plain-member floor
   * and nothing else. It never falls back to a default Role.
   */
  async resolveMappedRoles(orgId: string, groups: readonly string[]): Promise<{
    roleIds: string[];
    matchedGroups: string[];
  }> {
    const keys = [...new Set(groups.map(groupKey).filter((k) => k.length > 0))];
    if (keys.length === 0) return { roleIds: [], matchedGroups: [] };

    const docs = await IdpGroupMapping.find({ organizationId: orgId, groupKey: { $in: keys } })
      .select('group groupKey roleIds').lean();
    if (docs.length === 0) return { roleIds: [], matchedGroups: [] };

    const candidateIds = [...new Set(docs.flatMap((d) => (d.roleIds ?? []).map(String)))];
    const roles = await Role.find({ _id: { $in: candidateIds }, organizationId: toOrgId(orgId) })
      .select('_id grantsRole').lean();
    const grantable = new Set(
      roles.filter((r) => r.grantsRole !== 'superadmin').map((r) => String(r._id)),
    );

    const roleIds = candidateIds.filter((id) => grantable.has(id));
    return { roleIds, matchedGroups: docs.map((d) => d.group) };
  }
}

export const idpGroupMappingService = new IdpGroupMappingService();
