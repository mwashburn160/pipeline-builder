// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org routes whose CALLER is another service, not a person.
 *
 * Split from `controllers/organization.ts` because they answer to a different
 * authority: each is gated on a verified service principal (or a platform
 * admin), none is reachable by an ordinary member's token, and each returns one
 * narrow internal fact — a parent id, a batch of id→name pairs, the account's
 * pooled seat window, its purchased feature entitlements — never the full org
 * body. Keeping them together makes that boundary visible instead of
 * interleaved with the tenant-facing CRUD.
 */

import { createLogger, errorMessage, getParam, isServicePrincipal, isSystemAdmin, isValidFeatureFlag, sendError, sendSuccess, VALID_TIERS } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { canAdministerOrg, ensureAuthenticated, withController } from '../helpers/controller-helper.js';
import { pooledFeatureEntitlements, pooledSeatUsage } from '../helpers/seats.js';
import type { QuotaTier } from '../models/organization.js';
import { incCounter } from '../observability/metrics.js';
import { organizationService } from '../services/index.js';
import { ORG_SEAT_LIMIT_NOT_ROOT } from '../services/org-errors.js';

const logger = createLogger('organization-internal-controller');

/**
 * GET /organization/:id/parent — the org's direct parent id (org → team
 * hierarchy), or `null` for a root org. A least-privilege internal read for
 * peer services (compliance's scheduled scans run detached from any request/JWT
 * and need the parent to evaluate parent `propagateToChildren` rules); an
 * account/ancestor admin may also read their own. Mirrors the seat-usage gate:
 * service principal OR org-admin, never the broad `canAccessOrg`/full-org body.
 */
export const getOrganizationParent = withController('Get organization parent', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const id = getParam(req.params, 'id')!;
  if (!isServicePrincipal(req) && !(await canAdministerOrg(req, id))) {
    return sendError(res, 403, 'Forbidden: service or organization-admin only');
  }
  const org = await organizationService.getById(id);
  if (!org) return sendError(res, 404, 'Organization not found');
  sendSuccess(res, 200, { parentOrgId: org.parentOrgId ?? null });
});

/**
 * POST /organization/names — batch id→name resolver for internal callers.
 *
 * Body: `{ orgIds: string[] }` → `{ names: { [lowercasedOrgId]: name } }`.
 * SERVICE-PRINCIPAL ONLY (mirrors the `/parent` gate). This is an internal
 * enrichment path — the message service labels each conversation row with the
 * counterparty org's NAME instead of its raw id. It returns ONLY id→name, never
 * the full-org body / members / quotas, so it exposes nothing a peer service
 * couldn't already infer, and it is never reachable by an end-user token. Ids
 * are validated to 24-hex, de-duped, and capped so it can't become an unbounded
 * scan.
 */
export const getOrganizationNames = withController('Get organization names', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  // The service-principal gate is `requireServicePrincipal` on the route, so it
  // shows up in the route table; nothing is re-checked here.
  const raw = (req.body as { orgIds?: unknown })?.orgIds;
  if (!Array.isArray(raw)) {
    return sendError(res, 400, 'orgIds must be an array of organization ids');
  }
  const ids = [
    ...new Set(
      raw
        .filter((v): v is string => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v))
        .map((v) => v.toLowerCase()),
    ),
  ].slice(0, 200);
  const names = ids.length > 0 ? await organizationService.getNamesByIds(ids) : {};
  sendSuccess(res, 200, { names });
});

/**
 * PUT /organization/:id/seat-limit — internal: set the account seat limit.
 *
 * `seats` is platform-owned (not a quota-service type), so the billing service
 * syncs the effective seat entitlement (tier base + bundles) here. Gated to a
 * service principal or a sysadmin; NO step-up (service-to-service). `:id` must
 * be the account ROOT — a team id is refused with 409 (never redirected).
 */
export const updateOrganizationSeatLimit = withController('Update organization seat limit', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  if (!isServicePrincipal(req) && !isSystemAdmin(req)) {
    return sendError(res, 403, 'Forbidden: service or system-admin only');
  }

  const id = getParam(req.params, 'id')!;
  const body = (req.body ?? {}) as { seats?: unknown; features?: unknown; tier?: unknown };
  if (typeof body.seats !== 'number' || !Number.isInteger(body.seats) || body.seats < -1) {
    return sendError(res, 400, 'seats must be an integer >= -1');
  }
  // Optional account-level feature entitlements (purchased bundles).
  let features: string[] | undefined;
  if (body.features !== undefined) {
    if (!Array.isArray(body.features) || body.features.some((f) => typeof f !== 'string')) {
      return sendError(res, 400, 'features must be an array of strings');
    }
    // Whitelist against the canonical feature-flag registry: these entitlements
    // are persisted onto the root AND propagated to every descendant team, so an
    // unknown/junk flag would perpetually trip billing's entitlement-drift
    // reconciler and pollute `featureEntitlements`. Reject rather than silently
    // accept arbitrary strings (defense-in-depth against a bogus-flag injection).
    const unknown = (body.features as string[]).filter((f) => !isValidFeatureFlag(f));
    if (unknown.length > 0) {
      return sendError(res, 400, `features contains unknown feature flag(s): ${unknown.join(', ')}`);
    }
    features = body.features as string[];
  }
  // Optional account tier — billing pushes it so a plan DOWNGRADE invalidates
  // stale tokens (setSeatLimit sets only the tier label, no quota reseed).
  //
  // TRUST BOUNDARY: unlike the sysadmin `PATCH /tier` route, this path runs NO
  // over-cap / team-stranding guard (`checkTierOvercap`). Billing is the sole
  // caller and gates the downgrade via `checkEntitlementOvercap` BEFORE calling
  // this endpoint, so the guard lives caller-side by design. If another producer
  // ever writes here, add the structural guard.
  let tier: QuotaTier | undefined;
  if (body.tier !== undefined) {
    if (typeof body.tier !== 'string' || !VALID_TIERS.includes(body.tier as QuotaTier)) {
      return sendError(res, 400, `tier must be one of: ${VALID_TIERS.join(', ')}`);
    }
    tier = body.tier as QuotaTier;
  }

  const result = await organizationService.setSeatLimit(id, body.seats, features, tier);
  if (!result) return sendError(res, 404, 'Organization not found');

  // Defense-in-depth for the trust boundary above: billing is authoritative and
  // gates the downgrade caller-side, so we don't block — but a pushed cap BELOW
  // current pooled usage means a caller-side gate regressed and members are
  // stranded. Make it observable (metric + warn) instead of silent.
  if (typeof body.seats === 'number' && body.seats >= 0) {
    try {
      const { used } = await pooledSeatUsage(id);
      if (used > body.seats) {
        logger.warn('Seat-limit pushed below current pooled usage — members may be stranded', { orgId: id, seats: body.seats, used });
        incCounter('platform_seat_limit_below_usage_total');
      }
    } catch (err) {
      // Observability only — never fail the (already-committed) seat-limit write.
      logger.warn('Pooled-seat over-cap check failed', { orgId: id, err: errorMessage(err) });
    }
  }

  // Entitlement mutation on the account root (+ its descendants) — leave an audit
  // trail like every other admin org mutation (setTier, member ops, delete).
  audit(req, 'admin.org.seatLimit.update', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: result.rootOrgId,
    // Record the features added/removed DELTA (not just the resulting set) so a
    // DORA (advanced_reporting) access grant/revoke — or any bundle entitlement
    // change — is reconstructable from the audit trail alone.
    details: {
      seats: body.seats,
      ...(features ? { features } : {}),
      ...(result.featureDelta &&
      (result.featureDelta.added.length > 0 || result.featureDelta.removed.length > 0)
        ? { featuresAdded: result.featureDelta.added, featuresRemoved: result.featureDelta.removed }
        : {}),
      ...(tier ? { tier } : {}),
    },
  });
  logger.info('Seat limit synced', { orgId: id, rootOrgId: result.rootOrgId, seats: body.seats, features, tier, by: req.user!.sub });
  sendSuccess(res, 200, result, 'Seat limit updated');
}, {
  [ORG_SEAT_LIMIT_NOT_ROOT]: {
    status: 409,
    message: 'Seat limits and account entitlements are set on the account root, not a team',
  },
});

/**
 * GET /organization/:id/seat-usage — internal: current pooled seat usage + limit
 * for the account (root). Used by billing's over-cap gate before removing a seat
 * bundle. Service principal or sysadmin.
 */
export const getOrganizationSeatUsage = withController('Get organization seat usage', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const id = getParam(req.params, 'id')!;
  // Billing's over-cap gate calls this with a service token; an account admin
  // (or an ancestor-org admin) may also read their OWN pooled seat usage — it's
  // their own data. pooledSeatUsage resolves `id` to its root internally.
  if (!isServicePrincipal(req) && !(await canAdministerOrg(req, id))) {
    return sendError(res, 403, 'Forbidden: service or organization-admin only');
  }
  const usage = await pooledSeatUsage(id);
  sendSuccess(res, 200, usage);
});

/**
 * GET /organization/:id/feature-entitlements — internal: the account's (root)
 * purchased feature entitlements (`sso`, `audit_log`, …). Used by billing's
 * entitlement-drift reconciler to compare enforced vs. expected features — the
 * feature-dimension sibling of `seat-usage`. Same auth/tenancy as seat-usage:
 * a service principal (the reconciler) or an admin reading their OWN account.
 * `featureEntitlements` are feature FLAGS, not secrets — the same set already
 * rides along on this account's token issuance / user-profile reads.
 */
export const getOrganizationFeatureEntitlements = withController('Get organization feature entitlements', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const id = getParam(req.params, 'id')!;
  // Mirror the seat-usage gate exactly: billing calls with a service token; an
  // account (or ancestor-org) admin may also read their OWN entitlements.
  // pooledFeatureEntitlements resolves `id` to its root internally.
  if (!isServicePrincipal(req) && !(await canAdministerOrg(req, id))) {
    return sendError(res, 403, 'Forbidden: service or organization-admin only');
  }
  const featureEntitlements = await pooledFeatureEntitlements(id);
  sendSuccess(res, 200, { featureEntitlements });
});
