// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SCIM Groups: one `IdpGroupMapping` row per group — the same rows the SSO
 * group → Role editor writes. SCIM owns a group's NAME and MEMBERS and never its
 * `roleIds`; see `scim-users.ts` for the model as a whole.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { Types } from 'mongoose';
import { MAX_MAPPINGS_PER_ORG } from './idp-mapping-errors.js';
import { scimInvalidSyntax, scimInvalidValue, scimNotFound, scimUniqueness } from './scim-errors.js';
import { assertIntentAllowed, normalizePatchOps, parseScimFilter, parseScimPagination, patchPairs, type ScimContext, type ScimGroupResource, type ScimListQuery, type ScimListResponse, type ScimWriteOutcome } from './scim-filter.js';
import { groupResource, scimBaseUrl } from './scim-render.js';
import { resyncMemberRoles } from './scim-users.js';
import { SCIM_LIST_SCHEMA, SCIM_MAX_MEMBERS_PER_REQUEST } from '../constants/scim.js';
import { groupKey } from '../helpers/idp-claims.js';
import { toOrgId } from '../helpers/org-id.js';
import IdpGroupMapping, { type IdpGroupMappingDocument } from '../models/idp-group-mapping.js';
import UserOrganization from '../models/user-organization.js';
import User from '../models/user.js';

const logger = createLogger('scim-service');

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

const GROUP_FILTER_ATTRS = ['displayName', 'externalId'] as const;

/** Members of the given group keys, as `{ groupKey → [{value, display}] }`. */
async function membersOf(orgId: string, keys: readonly string[]): Promise<Map<string, Array<{ value: string; display: string }>>> {
  const out = new Map<string, Array<{ value: string; display: string }>>(keys.map((k) => [k, []]));
  if (keys.length === 0) return out;
  const memberships = await UserOrganization.find({ 'organizationId': toOrgId(orgId), 'scim.groups': { $in: keys } })
    .select('userId scim.groups').lean();
  if (memberships.length === 0) return out;
  const users = await User.find({ _id: { $in: memberships.map((m) => m.userId) } }).select('email').lean();
  const emailById = new Map(users.map((u) => [String(u._id), u.email]));
  for (const m of memberships) {
    const entry = { value: String(m.userId), display: emailById.get(String(m.userId)) ?? String(m.userId) };
    for (const key of ((m as { scim?: { groups?: string[] } }).scim?.groups ?? [])) {
      out.get(key)?.push(entry);
    }
  }
  return out;
}

export async function listGroups(ctx: ScimContext, query: ScimListQuery): Promise<ScimListResponse<ScimGroupResource>> {
  const parsed = parseScimFilter(query.filter, GROUP_FILTER_ATTRS);
  const { skip, limit, startIndex } = parseScimPagination(query);

  const where: Record<string, unknown> = { organizationId: ctx.orgId };
  if (parsed?.attribute === 'externalid') where.scimExternalId = parsed.value;
  else if (parsed) where.groupKey = groupKey(parsed.value);

  const totalResults = await IdpGroupMapping.countDocuments(where);
  const docs = limit === 0 ? [] : await IdpGroupMapping.find(where).sort({ groupKey: 1 }).skip(skip).limit(limit).lean();
  const [members, baseUrl] = await Promise.all([membersOf(ctx.orgId, docs.map((d) => d.groupKey)), scimBaseUrl()]);

  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults,
    startIndex,
    itemsPerPage: docs.length,
    Resources: docs.map((d) => groupResource(d, members.get(d.groupKey) ?? [], baseUrl)),
  };
}

async function requireGroup(orgId: string, id: string): Promise<IdpGroupMappingDocument> {
  if (!Types.ObjectId.isValid(id)) throw scimNotFound('Group');
  const doc = await IdpGroupMapping.findOne({ _id: new Types.ObjectId(id), organizationId: orgId });
  if (!doc) throw scimNotFound('Group');
  return doc;
}

export async function getGroup(ctx: ScimContext, id: string): Promise<ScimGroupResource> {
  const doc = await requireGroup(ctx.orgId, id);
  const [members, baseUrl] = await Promise.all([membersOf(ctx.orgId, [doc.groupKey]), scimBaseUrl()]);
  return groupResource(doc, members.get(doc.groupKey) ?? [], baseUrl);
}

/**
 * Validate a `members` array and resolve it to memberships of THIS org.
 *
 * `verify: false` skips the "must already be provisioned here" check, used for
 * REMOVALS: a directory that removes someone from a group after an admin already
 * removed their membership must still succeed — the removal is a no-op, and
 * failing it would stall the whole sync on an outcome that is already true.
 */
async function resolveMembers(orgId: string, raw: unknown, opts: { verify?: boolean } = {}): Promise<Types.ObjectId[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw scimInvalidSyntax('`members` must be an array.');
  if (raw.length > SCIM_MAX_MEMBERS_PER_REQUEST) {
    throw scimInvalidValue(`At most ${SCIM_MAX_MEMBERS_PER_REQUEST} members may be sent in one request — page the change.`);
  }
  const ids = raw.map((m) => {
    const value = typeof m === 'string' ? m : (m as Record<string, unknown>)?.value;
    if (typeof value !== 'string' || !Types.ObjectId.isValid(value)) {
      throw scimInvalidValue('Each member must carry a `value` naming a user provisioned in this organization.');
    }
    return new Types.ObjectId(value);
  });
  if (ids.length === 0) return [];
  if (opts.verify === false) return [...new Map(ids.map((id) => [String(id), id])).values()];

  // Every member must already be a membership of this org: a group is a set of
  // people the directory has provisioned here, not a way to reach into another
  // tenant's roster.
  const found = await UserOrganization.find({ organizationId: toOrgId(orgId), userId: { $in: ids } }).select('userId').lean();
  const known = new Set(found.map((m) => String(m.userId)));
  const missing = ids.map(String).filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw scimInvalidValue(`Not provisioned in this organization: ${missing.slice(0, 5).join(', ')}. Create the user before adding them to a group.`);
  }
  return [...new Map(ids.map((id) => [String(id), id])).values()];
}

/** Add/remove one group key across a set of memberships, then reconcile each
 *  member's Roles. Returns the ids actually touched. */
async function applyGroupMembership(
  orgId: string,
  key: string,
  add: readonly Types.ObjectId[],
  remove: readonly Types.ObjectId[],
): Promise<string[]> {
  const oid = toOrgId(orgId);
  if (add.length > 0) {
    await UserOrganization.updateMany(
      { organizationId: oid, userId: { $in: add } },
      { $addToSet: { 'scim.groups': key }, $set: { 'scim.managed': true, 'scim.lastSyncedAt': new Date() } },
    );
  }
  if (remove.length > 0) {
    await UserOrganization.updateMany(
      { organizationId: oid, userId: { $in: remove } },
      { $pull: { 'scim.groups': key }, $set: { 'scim.lastSyncedAt': new Date() } },
    );
  }

  const touched = [...new Set([...add, ...remove].map(String))];
  // Reconcile sequentially: each is its own transaction, and a group push is a
  // background sync — bounded work matters more than latency here.
  for (const userId of touched) {
    const membership = await UserOrganization.findOne({ organizationId: oid, userId: new Types.ObjectId(userId) })
      .select('scim.groups').lean();
    await resyncMemberRoles(orgId, userId, (membership as { scim?: { groups?: string[] } } | null)?.scim?.groups ?? []);
  }
  return touched;
}

/**
 * POST /Groups — push a directory group.
 *
 * The row this creates grants NOTHING until someone holding `roles:manage` maps
 * it to Roles in the SSO settings editor: SCIM owns the group's name and its
 * members, never its `roleIds`. That is what keeps a stolen SCIM key from being
 * a privilege-escalation primitive.
 */
export async function createGroup(ctx: ScimContext, body: Record<string, unknown>): Promise<ScimWriteOutcome<ScimGroupResource>> {
  assertIntentAllowed(ctx, 'create');
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
  if (!displayName) throw scimInvalidValue('`displayName` is required.');

  const key = groupKey(displayName);
  if (await IdpGroupMapping.exists({ organizationId: ctx.orgId, groupKey: key })) {
    throw scimUniqueness(`A group named '${displayName}' already exists in this organization.`);
  }
  if (await IdpGroupMapping.countDocuments({ organizationId: ctx.orgId }) >= MAX_MAPPINGS_PER_ORG) {
    throw scimInvalidValue(`An organization can hold at most ${MAX_MAPPINGS_PER_ORG} directory groups.`);
  }
  const members = await resolveMembers(ctx.orgId, body.members);

  const doc = await IdpGroupMapping.create({
    organizationId: toOrgId(ctx.orgId),
    group: displayName,
    groupKey: key,
    // Never set by SCIM — see the function docs.
    roleIds: [],
    scimExternalId: typeof body.externalId === 'string' ? body.externalId.slice(0, 256) : null,
    scimManaged: true,
    createdBy: 'scim',
    updatedBy: 'scim',
  });
  const affectedUserIds = await applyGroupMembership(ctx.orgId, key, members, []);

  logger.info('[SCIM] created directory group', { orgId: ctx.orgId, group: key, members: members.length });
  return { resource: await getGroup(ctx, String(doc._id)), action: 'create', changed: ['displayName', 'members'], affectedUserIds };
}

/**
 * PUT /Groups/:id — replace the group's name and its member set.
 *
 * `members` ABSENT from the body leaves the membership untouched; an explicit
 * array (empty included) replaces it. A strict reading of PUT would clear an
 * absent multi-valued attribute, but a client that renames a group with a
 * name-only PUT would then silently empty it — and with it every Role the group
 * mapped to. Clearing has to be asked for.
 */
export async function replaceGroup(ctx: ScimContext, id: string, body: Record<string, unknown>): Promise<ScimWriteOutcome<ScimGroupResource>> {
  const doc = await requireGroup(ctx.orgId, id);
  const replacesMembers = body.members !== undefined;
  const members = await resolveMembers(ctx.orgId, body.members);
  const current = await membersOf(ctx.orgId, [doc.groupKey]);
  const currentIds = new Set((current.get(doc.groupKey) ?? []).map((m) => m.value));
  const nextIds = new Set(members.map(String));
  const removing = replacesMembers ? [...currentIds].filter((mid) => !nextIds.has(mid)) : [];
  const adding = replacesMembers ? members.filter((mid) => !currentIds.has(String(mid))) : [];

  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : doc.group;
  const renaming = displayName !== doc.group;
  // Removal-only after a downgrade: dropping members still works, adding or
  // renaming does not.
  if (renaming || adding.length > 0) assertIntentAllowed(ctx, 'update');

  const changed: string[] = [];
  if (renaming) {
    const key = groupKey(displayName);
    if (key !== doc.groupKey && await IdpGroupMapping.exists({ organizationId: ctx.orgId, groupKey: key, _id: { $ne: doc._id } })) {
      throw scimUniqueness(`A group named '${displayName}' already exists in this organization.`);
    }
    await renameGroupKey(ctx.orgId, doc, displayName, key);
    changed.push('displayName');
  }
  if (typeof body.externalId === 'string' && body.externalId !== doc.scimExternalId) {
    doc.scimExternalId = body.externalId.slice(0, 256);
    await doc.save();
    changed.push('externalId');
  }

  const affectedUserIds = await applyGroupMembership(
    ctx.orgId,
    doc.groupKey,
    adding,
    removing.map((mid) => new Types.ObjectId(mid)),
  );
  if (affectedUserIds.length > 0) changed.push('members');

  return { resource: await getGroup(ctx, id), action: renaming || adding.length > 0 ? 'update' : 'members', changed, affectedUserIds };
}

/** Rename a group, carrying every member's stored key across with it. */
async function renameGroupKey(orgId: string, doc: IdpGroupMappingDocument, displayName: string, key: string): Promise<void> {
  const previous = doc.groupKey;
  doc.group = displayName;
  doc.groupKey = key;
  doc.updatedBy = 'scim';
  await doc.save();
  if (previous !== key) {
    // Members carry the KEY, so a rename must move them or everyone silently
    // drops out of the group (and loses the Roles it maps to).
    await UserOrganization.updateMany(
      { 'organizationId': toOrgId(orgId), 'scim.groups': previous },
      { $set: { 'scim.groups.$': key } },
    );
  }
}

/**
 * PATCH /Groups/:id — the member add/remove an IdP actually sends.
 *
 * Supported: `members` add / remove / replace (with `path: members[value eq "…"]`
 * for a single removal, which Okta emits), and a `displayName` replace.
 */
export async function patchGroup(ctx: ScimContext, id: string, ops: unknown): Promise<ScimWriteOutcome<ScimGroupResource>> {
  const operations = normalizePatchOps(ops);
  const doc = await requireGroup(ctx.orgId, id);
  const current = await membersOf(ctx.orgId, [doc.groupKey]);
  const currentIds = new Set((current.get(doc.groupKey) ?? []).map((m) => m.value));

  const add = new Set<string>();
  const remove = new Set<string>();
  let displayName: string | undefined;
  let externalId: string | undefined;
  let replacedMembers = false;

  for (const { op, raw } of operations) {
    const path = typeof raw.path === 'string' ? raw.path.trim() : '';
    // `members[value eq "<id>"]` — a targeted removal with no body.
    const filtered = /^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i.exec(path);
    if (filtered) {
      if (op !== 'remove') throw scimInvalidSyntax('A filtered `members[...]` path is only supported with op "remove".');
      remove.add(filtered[1]);
      continue;
    }
    if (path.toLowerCase() === 'members' || (path === '' && (raw.value as Record<string, unknown>)?.members !== undefined)) {
      const value = path === '' ? (raw.value as Record<string, unknown>).members : raw.value;
      const ids = (await resolveMembers(ctx.orgId, value ?? [], { verify: op !== 'remove' })).map(String);
      if (op === 'remove') {
        // A bare `remove` on `members` with no value clears the group.
        (value === undefined || (Array.isArray(value) && value.length === 0) ? [...currentIds] : ids).forEach((v) => remove.add(v));
      } else if (op === 'replace') {
        replacedMembers = true;
        ids.forEach((v) => add.add(v));
        [...currentIds].filter((v) => !ids.includes(v)).forEach((v) => remove.add(v));
      } else {
        ids.forEach((v) => add.add(v));
      }
      // A PATH-LESS op may carry other attributes alongside `members`, so it
      // still falls through to the attribute loop (which skips `members`); a
      // `path: members` op carries nothing else and is done.
      if (path !== '') continue;
    }
    for (const [attr, value] of patchPairs(raw)) {
      switch (attr.toLowerCase()) {
        case 'displayname': displayName = String(value ?? '').trim(); break;
        case 'externalid': externalId = String(value ?? '').slice(0, 256); break;
        case 'members': break; // handled above
        default: break; // unmodelled attribute — ignored, as on Users
      }
    }
  }

  // Never re-add someone who is already in the group, and never remove someone
  // an operation in the same request added.
  for (const id2 of add) remove.delete(id2);
  const adding = [...add].filter((v) => !currentIds.has(v)).map((v) => new Types.ObjectId(v));
  const removing = [...remove].filter((v) => currentIds.has(v)).map((v) => new Types.ObjectId(v));

  const renaming = displayName !== undefined && displayName !== '' && displayName !== doc.group;
  if (renaming || adding.length > 0 || externalId !== undefined) assertIntentAllowed(ctx, 'update');
  else if (removing.length > 0) assertIntentAllowed(ctx, 'delete');

  const changed: string[] = [];
  if (renaming) {
    const key = groupKey(displayName!);
    if (key !== doc.groupKey && await IdpGroupMapping.exists({ organizationId: ctx.orgId, groupKey: key, _id: { $ne: doc._id } })) {
      throw scimUniqueness(`A group named '${displayName}' already exists in this organization.`);
    }
    await renameGroupKey(ctx.orgId, doc, displayName!, key);
    changed.push('displayName');
  }
  if (externalId !== undefined && externalId !== doc.scimExternalId) {
    doc.scimExternalId = externalId;
    await doc.save();
    changed.push('externalId');
  }

  const affectedUserIds = await applyGroupMembership(ctx.orgId, doc.groupKey, adding, removing);
  if (affectedUserIds.length > 0) changed.push('members');

  return {
    resource: await getGroup(ctx, id),
    action: renaming || externalId !== undefined || replacedMembers ? 'update' : 'members',
    changed,
    affectedUserIds,
  };
}

/**
 * DELETE /Groups/:id — the directory removed the group.
 *
 * Every member drops out of it and their mapped Roles fall away with it (manual
 * Roles stay). The mapping row goes too, so an admin sees the group disappear
 * from the editor rather than a rule that can never match again. Accepted after a
 * downgrade: it only ever removes access.
 */
export async function deleteGroup(ctx: ScimContext, id: string): Promise<ScimWriteOutcome<{ id: string }>> {
  assertIntentAllowed(ctx, 'delete');
  const doc = await requireGroup(ctx.orgId, id);
  const members = (await membersOf(ctx.orgId, [doc.groupKey])).get(doc.groupKey) ?? [];

  await IdpGroupMapping.deleteOne({ _id: doc._id });
  const affectedUserIds = await applyGroupMembership(
    ctx.orgId,
    doc.groupKey,
    [],
    members.map((m) => new Types.ObjectId(m.value)),
  );

  logger.info('[SCIM] deleted directory group', { orgId: ctx.orgId, group: doc.groupKey, members: members.length });
  return { resource: { id }, action: 'delete', changed: ['members'], affectedUserIds };
}
