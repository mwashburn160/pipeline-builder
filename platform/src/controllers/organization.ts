// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, getParam, isSystemAdmin, paginationMeta, sendError, sendSuccess, SYSTEM_ORG_ID, VALID_TIERS } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import {
  canAccessOrg,
  canManageOrgScope,
  ensureAuthenticated,
  requireSystemAdmin,
  withController,
} from '../helpers/controller-helper.js';
import { expandOrgScope } from '../helpers/org-hierarchy.js';
import { listPage } from '../helpers/pagination.js';
import type { QuotaTier } from '../models/organization.js';
import { organizationService, orgHierarchyService, changedAiProviderFields } from '../services/index.js';
import { exportOrg, softDeleteOrg } from '../services/org-cascade-service.js';
import {
  ORG_NOT_FOUND, SYSTEM_ORG_DELETE_FORBIDDEN, ORG_SLUG_TAKEN, ORG_AI_KEY_TOO_LONG, ORG_ALREADY_DELETED, ORG_SNAPSHOT_FAILED,
  ORG_TEAM_NOT_FOUND, ORG_SEAT_LIMIT, ORG_RESTORE_PARENT_GONE, ORG_RESTORE_PARENT_INELIGIBLE,
  ORG_MOVE_SYSTEM, ORG_MOVE_DELETED, ORG_MOVE_SELF, ORG_MOVE_CYCLE, ORG_MOVE_HAS_TEAMS, ORG_MOVE_TARGET_NOT_FOUND,
  ORG_MOVE_TARGET_NOT_ROOT, ORG_MOVE_TARGET_TIER, ORG_MOVE_NOOP, ORG_MOVE_BILLED, ORG_MOVE_BILLING_UNVERIFIED,
  ORG_MOVE_CONFLICT,
} from '../services/org-errors.js';
import { validateBody, createOrganizationSchema, updateOrganizationSchema, updateOrgIdentitySchema } from '../utils/validation.js';

const logger = createLogger('organization-controller');

// Organization CRUD (System Admin)

/** GET /organizations — every tenant. System-admin only, gated at the route. */
export const listAllOrganizations = withController('List organizations', async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search: undefined;
  // Tier facet — passed through verbatim; service coerces invalid values
  // to "no filter" via the QuotaTier union (Mongo just no-ops on unknown enums).
  const tierRaw = typeof req.query.tier === 'string' ? req.query.tier: undefined;
  const tier = tierRaw && VALID_TIERS.includes(tierRaw as QuotaTier)
    ? (tierRaw as QuotaTier)
    : undefined;
  const { offset, limit } = listPage(req.query);
  // `ids=a,b,c` — resolve exactly these orgs (names for the ids a page shows).
  // Malformed ids are dropped rather than failing the Mongo cast.
  const ids = typeof req.query.ids === 'string'
    ? req.query.ids.split(',').map((s) => s.trim()).filter((s) => /^[a-f0-9]{24}$/i.test(s)).slice(0, 100)
    : undefined;

  const { organizations, total } = await organizationService.list({ search, tier, ...(ids ? { ids } : {}), offset, limit });

  sendSuccess(res, 200, {
    organizations,
    pagination: paginationMeta({ total, offset, limit }),
  });
});

export const createOrganization = withController('Create organization', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const body = validateBody(createOrganizationSchema, req.body, res);
  if (!body) return;

  // Creating a team (nested org) requires the parent to be within the caller's
  // scope (their own org or a team under it; `org:settings` is the route's
  // capability gate), and the parent must itself be a root org (one nesting level).
  if (body.parentOrgId) {
    if (!(await canManageOrgScope(req, body.parentOrgId))) {
      return sendError(res, 403, 'You must be an admin of the parent organization to create a team under it');
    }
    const eligibility = await organizationService.checkParentEligible(body.parentOrgId);
    if (eligibility === 'not-found') return sendError(res, 404, 'Parent organization not found');
    if (eligibility === 'not-root') {
      return sendError(res, 400, 'Teams can only be nested one level deep (the parent must be a top-level organization)');
    }
    if (eligibility === 'tier-forbidden') {
      return sendError(res, 403, 'Teams require a Team or Enterprise plan — upgrade the organization to create teams');
    }
  }

  const result = await organizationService.create(req.user!.sub, body);

  audit(req, 'org.create', {
    targetType: 'organization',
    targetId: result.id,
    ...(body.parentOrgId && { details: { parentOrgId: body.parentOrgId } }),
  });
  logger.info(`Org created by ${req.user!.sub}`, { id: result.id, parentOrgId: body.parentOrgId });
  sendSuccess(res, 201, { organization: result }, 'Organization created successfully');
});

export const getOrganizationById = withController('Get organization', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;

  const id = getParam(req.params, 'id')!;
  // Own org (any member), a team you manage (parent-org admin), or sysadmin.
  if (!(await canAccessOrg(req, id))) {
    return sendError(res, 403, 'Forbidden');
  }

  // Bound the member roster this hot read returns — `memberCount` still reflects
  // the full org, so the UI can page via ?membersOffset/?membersLimit. The
  // service clamps these to a safe range; a missing value falls back to its cap.
  const membersLimit = parseInt(String(req.query.membersLimit), 10);
  const membersOffset = parseInt(String(req.query.membersOffset), 10);
  const org = await organizationService.getById(id, {
    membersLimit: Number.isNaN(membersLimit) ? undefined : membersLimit,
    membersOffset: Number.isNaN(membersOffset) ? undefined : membersOffset,
    // The sysadmin org-detail page shows where the org sits: parent name + live teams.
    includeHierarchy: isSystemAdmin(req),
  });
  if (!org) return sendError(res, 404, 'Organization not found');

  sendSuccess(res, 200, org);
});

/**
 * GET /organization/:id/descendants — the org → team subtree as a flat id list
 * (`[self, ...descendantOrgIds]`). Used by peer services (reporting rollup) and
 * the dashboard to aggregate a parent over its teams. Readable by anyone who
 * can access the org (own org, an ancestor admin, or sysadmin).
 */
export const getOrganizationDescendants = withController('Get org descendants', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;

  const id = getParam(req.params, 'id')!;
  if (!(await canAccessOrg(req, id))) {
    return sendError(res, 403, 'Forbidden');
  }

  const orgIds = await expandOrgScope(id);
  sendSuccess(res, 200, { orgIds });
});


/** Errors `organizationService.update` can raise, shared by both org-edit routes. */
const ORG_UPDATE_ERROR_MAP = {
  [ORG_SLUG_TAKEN]: { status: 409, message: 'That slug is already taken — choose another' },
};

/** PUT /organization/:id — sysadmin org edit (name/slug/description). */
export const updateOrganization = withController('Update organization', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  const body = validateBody(updateOrganizationSchema, req.body, res);
  if (!body) return;

  const id = getParam(req.params, 'id')!;
  const updated = await organizationService.update(id, body);
  if (!updated) return sendError(res, 404, 'Organization not found');

  audit(req, 'org.update', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: id,
    details: {
      fields: Object.keys(body),
      ...(body.name !== undefined ? { name: updated.name } : {}),
    },
  });
  logger.info(`Organization ${id} updated by system admin ${req.user!.sub}`);
  sendSuccess(res, 200, { organization: updated }, 'Organization updated successfully');
}, ORG_UPDATE_ERROR_MAP);

/**
 * PATCH /organization/:id/identity — self-serve org identity edit (name/slug).
 *
 * Unlike `PUT /organization/:id` (sysadmin-only), this is reachable by anyone
 * holding `org:settings` (the route's capability gate — an owner/admin, or a
 * custom Role delegating it) for their OWN org or a team under it, via
 * `canManageOrgScope` — the tenancy gate `exportOrganization` also uses. A
 * member without the permission is refused at the route. Reuses the shared
 * `organizationService.update` logic (name/slug), which enforces slug
 * uniqueness. Does NOT touch tier/quotas/description-via-sysadmin or DELETE.
 */
export const updateOrganizationIdentity = withController('Update organization identity', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;

  const id = getParam(req.params, 'id')!;
  // Tenancy: sysadmin, the caller's own org, or a team under it. Unrelated
  // orgs are refused.
  if (!(await canManageOrgScope(req, id))) {
    return sendError(res, 403, 'You can only edit an organization you administer');
  }

  const body = validateBody(updateOrgIdentitySchema, req.body, res);
  if (!body) return;

  const updated = await organizationService.update(id, body);
  if (!updated) return sendError(res, 404, 'Organization not found');

  audit(req, 'org.update', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: id,
    details: {
      ...(body.name !== undefined ? { name: updated.name } : {}),
      ...(body.slug !== undefined ? { slug: updated.slug } : {}),
    },
  });
  logger.info(`Organization ${id} identity updated by ${req.user!.sub}`, { fields: Object.keys(body) });
  sendSuccess(res, 200, { organization: updated }, 'Organization updated successfully');
}, ORG_UPDATE_ERROR_MAP);

/**
 * PATCH /organization/:id/tier — sysadmin tier change.
 *
 * Body: `{ tier: 'developer' | 'pro' | 'team' | 'enterprise' }`. Reseeds the
 * org's quota limits from the new tier's config. The audit event
 * carries the previous tier so the transition is reconstructable
 * even if the org doc has been rewritten since.
 */
export const updateOrganizationTier = withController('Update organization tier', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;

  const id = getParam(req.params, 'id')!;
  const tierRaw = (req.body as { tier?: unknown })?.tier;
  if (typeof tierRaw !== 'string' || !VALID_TIERS.includes(tierRaw as QuotaTier)) {
    return sendError(res, 400, `tier must be one of: ${VALID_TIERS.join(', ')}`);
  }
  const tier: QuotaTier = tierRaw as QuotaTier;

  // Over-cap gate: a downgrade must not strand
  // members/resources. Same protection as the billing plan-change path; a
  // sysadmin can deliberately override with `force: true`.
  const force = (req.body as { force?: unknown })?.force === true;
  if (!force) {
    const overages = await organizationService.checkTierOvercap(id, tier);
    if (overages.length > 0) {
      return sendError(res, 409, 'This tier change would put the account over its limit — remove members/resources first, or pass force=true', 'TIER_OVER_CAP', { overages });
    }
  }

  const result = await organizationService.setTier(id, tier);
  if (!result) return sendError(res, 404, 'Organization not found');

  audit(req, 'admin.org.tier.update', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: id,
    details: {
      previousTier: result.previousTier,
      tier: result.tier,
      // On a downgrade, record WHICH tier-included features were revoked
      // (`TIER_FEATURES[prev] \ TIER_FEATURES[next]`) so the audit trail mirrors
      // `setSeatLimit`'s `featureDelta` — an access reduction is reconstructable
      // from the event alone. Omitted on an upgrade/no-op (no features lost).
      ...(result.featuresRemoved && result.featuresRemoved.length > 0
        ? { featuresRemoved: result.featuresRemoved }
        : {}),
    },
  });
  logger.info('Organization tier updated', { id, tier, previousTier: result.previousTier, by: req.user!.sub });
  sendSuccess(res, 200, result, 'Tier updated successfully');
});

export const deleteOrganization = withController('Delete organization', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;

  const id = getParam(req.params, 'id')!;

  // A root org with live teams must not be deleted directly — it would orphan
  // the teams (dangling `parentOrgId`) and their pooled seats/usage. Require the
  // teams be removed first (DELETE /:id/teams/:teamId) or reparented
  // (POST /:teamId/move). `expandOrgScope` is the LIVE scope: `[self]` for a flat
  // org or a team, and soft-deleted teams don't block — they can only be
  // restored while their parent is live (see orgHierarchyService.prepareTeamRestore).
  const scope = await expandOrgScope(id);
  if (scope.length > 1) {
    return sendError(res, 400, 'This organization has teams — delete each team, or move it to another organization or out as a standalone organization, before deleting this one');
  }

  // SOFT-delete instead of the immediate destructive cascade: capture a durable
  // recovery snapshot, tombstone the org (`deletedAt`/`purgeAfter`) for the
  // configured retention window, and bump every active member's tokenVersion so
  // their sessions are cut immediately. The token chokepoint (`resolveMembership`)
  // then refuses to re-issue a token scoped to the soft-deleted org — access is
  // gone WITHOUT touching the destructive stores. The purge sweep (org-purge.ts)
  // runs the existing fail-closed cascade + hard delete once the window lapses.
  //
  // If the snapshot can't be produced/persisted, softDeleteOrg throws
  // ORG_SNAPSHOT_FAILED and the org is NOT tombstoned — we never lose an org
  // without a recovery snapshot.
  const actorOrgId = (req.user!.organizationId as string) ?? SYSTEM_ORG_ID;
  const result = await softDeleteOrg(id, actorOrgId, req.user!.sub);

  logger.info(`Organization ${id} soft-deleted by system admin ${req.user!.sub}`, {
    purgeAfter: result.purgeAfter, snapshotId: result.snapshotId, membersInvalidated: result.membersInvalidated,
  });
  // `affectedOrgId` is the org being soft-deleted (the action's target), not the
  // sysadmin's own org.
  audit(req, 'org.soft_delete', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: id,
    details: { purgeAfter: result.purgeAfter, snapshotId: result.snapshotId, membersInvalidated: result.membersInvalidated },
  });
  sendSuccess(
    res,
    202,
    { deletedAt: result.deletedAt, purgeAfter: result.purgeAfter, snapshotId: result.snapshotId },
    `Organization scheduled for deletion. It can be restored until ${result.purgeAfter.toISOString()}.`,
  );
}, {
  [ORG_NOT_FOUND]: { status: 404, message: 'Organization not found' },
  [ORG_ALREADY_DELETED]: { status: 409, message: 'Organization is already scheduled for deletion' },
  [ORG_SNAPSHOT_FAILED]: { status: 502, message: 'Could not capture the recovery snapshot — the organization was NOT deleted. Retry once the datastore recovers.' },
  [SYSTEM_ORG_DELETE_FORBIDDEN]: { status: 400, message: 'Cannot delete system organization' },
});

/**
 * POST /organization/:id/restore — restore a soft-deleted org within its
 * retention window. Reverses {@link deleteOrganization}: clears the tombstone
 * and bumps member tokenVersion so re-issued tokens see the org live again.
 *
 * Tenancy via `canManageOrgScope` (sysadmin, the caller's own org, or a team
 * under it) — the same gate `export` uses. `requirePermission('org:settings')` is the capability gate at the route.
 * Refused (404) if the org was already purged (gone — nothing to restore).
 */
export const restoreOrganization = withController('Restore organization', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;

  const id = getParam(req.params, 'id')!;
  if (!(await canManageOrgScope(req, id))) {
    return sendError(res, 403, 'You can only restore an organization you administer');
  }

  // Exclude the acting admin from the member token-invalidation so restoring an
  // org never logs out the person who did it (they'd otherwise 401 → login screen).
  const restored = await organizationService.restore(id, req.user!.sub);
  if (!restored) {
    return sendError(res, 404, 'No organization pending deletion with this id (already purged or never deleted)');
  }

  logger.info(`Organization ${id} restored by ${req.user!.sub}`, { membersInvalidated: restored.membersInvalidated });
  audit(req, 'org.restore', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: id,
    details: { membersInvalidated: restored.membersInvalidated },
  });
  sendSuccess(res, 200, { organization: restored }, 'Organization restored');
}, {
  [ORG_RESTORE_PARENT_GONE]: { status: 409, message: 'This team\'s parent organization is deleted — restore the parent first' },
  [ORG_RESTORE_PARENT_INELIGIBLE]: { status: 409, message: 'This team\'s parent organization can no longer hold teams (it is a team itself, or its plan no longer includes teams)' },
  [ORG_SEAT_LIMIT]: { status: 409, message: 'Restoring this team would put the account over its seat limit — free seats or add a seat pack first' },
});

/**
 * GDPR portability export. System admins can export any org;
 * org admins / owners can export their own org only. Returns a single
 * JSON blob with every Postgres + Mongo row for the target org. Read-only.
 */
export const exportOrganization = withController('Export organization', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;

  const id = getParam(req.params, 'id')!;
  const actorOrgId = (req.user!.organizationId as string) ?? SYSTEM_ORG_ID;
  // Tenancy: sysadmin, the caller's own org, or a team under it.
  if (!(await canManageOrgScope(req, id))) {
    return sendError(res, 403, 'Org admins can only export their own org or a team they manage');
  }

  const dump = await exportOrg(id, actorOrgId);

  audit(req, 'admin.org.export', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: id,
    details: {
      postgresTables: Object.keys(dump.postgres).length,
      // Row counts per Mongo collection — the artifact carries every
      // collection the teardown removes.
      mongo: Object.fromEntries(Object.entries(dump.mongo).map(([name, rows]) => [name, rows.length])),
      ...(dump.failed ? { failedStores: dump.failed } : {}),
    },
  });

  // Stream the dump as application/json; the file may be large for orgs with
  // long histories. Setting `Content-Disposition: attachment` makes browsers
  // save instead of render.
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="org-${id}-export.json"`);
  res.status(200).send(JSON.stringify(dump, null, 2));
});


// Team lifecycle (parent-admin self-serve) + reparenting (sysadmin)

/**
 * GET /organization/:id/teams/deleted — soft-deleted teams of `:id` still inside
 * their retention window (restorable via `POST /:teamId/restore`). Capability
 * `org:settings` at the route; tenancy `canManageOrgScope(:id)` here.
 */
export const listDeletedTeams = withController('List deleted teams', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const id = getParam(req.params, 'id')!;
  if (!(await canManageOrgScope(req, id))) {
    return sendError(res, 403, 'You can only view the teams of an organization you administer');
  }
  sendSuccess(res, 200, await orgHierarchyService.listDeletedTeams(id));
});

/**
 * DELETE /organization/:id/teams/:teamId — a parent admin soft-deletes one of
 * its own teams. The same soft-delete as the sysadmin `DELETE /:id` (recovery
 * snapshot, tombstone + `purgeAfter` retention window, every session scoped to
 * the team cut). The team leaves the LIVE scope at once, so its members stop
 * counting against the account's pooled seats and it drops out of team lists
 * and rollups; `POST /:teamId/restore` brings it back (re-checking seats).
 * 404 unless the team's DIRECT parent is `:id`.
 */
export const deleteTeam = withController('Delete team', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const id = getParam(req.params, 'id')!;
  const teamId = getParam(req.params, 'teamId')!;
  if (!(await canManageOrgScope(req, id))) {
    return sendError(res, 403, 'You can only delete a team of an organization you administer');
  }
  const team = await orgHierarchyService.getTeamParent(teamId);
  if (!team || team.parentOrgId !== id) throw new Error(ORG_TEAM_NOT_FOUND);

  const actorOrgId = (req.user!.organizationId as string) ?? SYSTEM_ORG_ID;
  const result = await softDeleteOrg(teamId, actorOrgId, req.user!.sub);

  logger.info(`Team ${teamId} of ${id} soft-deleted by ${req.user!.sub}`, {
    purgeAfter: result.purgeAfter, snapshotId: result.snapshotId, membersInvalidated: result.membersInvalidated,
  });
  audit(req, 'org.team.delete', {
    targetType: 'organization',
    targetId: teamId,
    affectedOrgId: teamId,
    details: {
      parentOrgId: id,
      purgeAfter: result.purgeAfter,
      snapshotId: result.snapshotId,
      membersInvalidated: result.membersInvalidated,
    },
  });
  sendSuccess(
    res,
    202,
    { deletedAt: result.deletedAt, purgeAfter: result.purgeAfter, snapshotId: result.snapshotId },
    `Team scheduled for deletion. It can be restored until ${result.purgeAfter.toISOString()}.`,
  );
}, {
  [ORG_TEAM_NOT_FOUND]: { status: 404, message: 'Team not found' },
  [ORG_NOT_FOUND]: { status: 404, message: 'Team not found' },
  [ORG_ALREADY_DELETED]: { status: 409, message: 'Team is already scheduled for deletion' },
  [ORG_SNAPSHOT_FAILED]: { status: 502, message: 'Could not capture the recovery snapshot — the team was NOT deleted. Retry once the datastore recovers.' },
});

/**
 * POST /organization/:id/move — sysadmin reparent. Body `{ parentOrgId: string | null }`:
 * a team to another root, a team out as a standalone root (`null`), or a root
 * with no teams in under a root. Tier, entitlements, quota seeding and seats are
 * re-synced for the new account (see orgHierarchyService.move). Returns the
 * updated org.
 */
export const moveOrganization = withController('Move organization', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  const id = getParam(req.params, 'id')!;
  const raw = (req.body as { parentOrgId?: unknown } | undefined)?.parentOrgId;
  if (raw !== null && (typeof raw !== 'string' || !/^[a-f0-9]{24}$/i.test(raw))) {
    return sendError(res, 400, 'parentOrgId must be an organization id, or null to make the organization standalone');
  }

  const moved = await orgHierarchyService.move(id, raw as string | null);
  audit(req, 'admin.org.move', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: id,
    details: {
      fromParentOrgId: moved.fromParentOrgId,
      toParentOrgId: moved.toParentOrgId,
      tier: moved.tier,
      membersInvalidated: moved.membersInvalidated,
    },
  });
  logger.info(`Organization ${id} moved by system admin ${req.user!.sub}`, moved);

  const organization = await organizationService.getById(id, { includeHierarchy: true });
  if (!organization) return sendError(res, 404, 'Organization not found');
  sendSuccess(
    res,
    200,
    { organization },
    moved.toParentOrgId ? 'Organization moved' : 'Organization is now a standalone organization',
  );
}, {
  [ORG_NOT_FOUND]: { status: 404, message: 'Organization not found' },
  [ORG_MOVE_TARGET_NOT_FOUND]: { status: 404, message: 'Destination organization not found' },
  [ORG_MOVE_SYSTEM]: { status: 400, message: 'The system organization cannot be moved or hold teams' },
  [ORG_MOVE_DELETED]: { status: 409, message: 'This organization is scheduled for deletion — restore it before moving it' },
  [ORG_MOVE_SELF]: { status: 400, message: 'An organization cannot be its own parent' },
  [ORG_MOVE_CYCLE]: { status: 400, message: 'The destination is inside this organization — that would create a cycle' },
  [ORG_MOVE_HAS_TEAMS]: { status: 400, message: 'This organization has teams (including any pending deletion) — an organization with teams cannot become a team. Move or delete its teams first' },
  [ORG_MOVE_TARGET_NOT_ROOT]: { status: 400, message: 'The destination is itself a team — teams can only be nested one level deep' },
  [ORG_MOVE_TARGET_TIER]: { status: 400, message: 'The destination\'s plan does not include teams — it must be on the Team or Enterprise plan' },
  [ORG_MOVE_NOOP]: { status: 400, message: 'The organization is already there' },
  [ORG_MOVE_BILLED]: { status: 409, message: 'This organization still has an active subscription — cancel it before making the organization a team (its plan would pool under the new parent)' },
  [ORG_MOVE_BILLING_UNVERIFIED]: { status: 503, message: 'Could not confirm with billing that this organization has no active subscription — try again shortly' },
  [ORG_SEAT_LIMIT]: { status: 409, message: 'This move would put the destination account over its seat limit' },
  [ORG_MOVE_CONFLICT]: { status: 409, message: 'This organization was moved by someone else while this request was running — reload and try again' },
});

// Current User's Organization

export const getMyOrganization = withController('Get my organization', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;

  const orgId = req.user!.organizationId;
  if (!orgId) return sendError(res, 404, 'No organization associated with this user');

  const org = await organizationService.getById(orgId as string);
  if (!org) return sendError(res, 404, 'Organization not found');

  sendSuccess(res, 200, { organization: org });
});

// AI Provider Configuration

export const getOrgAIConfig = withController('Get AI config', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;

  const orgId = req.user!.organizationId;
  if (!orgId) return sendError(res, 404, 'No organization associated with this user');

  const providers = await organizationService.getAIConfig(orgId as string);
  if (!providers) return sendError(res, 404, 'Organization not found');

  sendSuccess(res, 200, { providers });
});

export const updateOrgAIConfig = withController('Update AI config', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;

  const orgId = req.user!.organizationId;
  if (!orgId) return sendError(res, 404, 'No organization associated with this user');

  const providers = await organizationService.updateAIConfig(orgId as string, req.body);
  if (!providers) return sendError(res, 404, 'Organization not found');

  logger.info(`Organization ${orgId} AI config updated by ${req.user!.sub}`);
  // Audit AFTER the write succeeds. AI-provider keys are secrets, so `details`
  // records only WHICH provider slots changed (field names), never a key value.
  // `affectedOrgId` is the actor's own org (defaults there anyway) — passed
  // explicitly for parity with the other org-config audit sites.
  audit(req, 'admin.org.ai-config.update', {
    targetType: 'organization',
    targetId: orgId as string,
    affectedOrgId: orgId as string,
    details: { providers: changedAiProviderFields(req.body as Record<string, unknown>) },
  });
  sendSuccess(res, 200, { providers }, 'AI provider configuration updated');
}, {
  [ORG_AI_KEY_TOO_LONG]: { status: 400, message: 'AI provider key exceeds the maximum allowed length' },
});
