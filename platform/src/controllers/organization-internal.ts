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

import { createLogger, errorMessage, getParam, isServicePrincipal, isServicePrincipalNamed, isValidFeatureFlag, sendError, sendSuccess, userHasPermission, VALID_TIERS } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { canAdministerOrg, ensureAuthenticated, forbid, withController } from '../helpers/controller-helper.js';
import { pooledFeatureEntitlements, pooledSeatUsage } from '../helpers/seats.js';
import type { PlanTier } from '../models/organization.js';
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
    return forbid(req, res, 'internal-service or org-admin', 'Forbidden: service or organization-admin only');
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

/** The one service that may read or write an account's seat / entitlement window. */
const ENTITLEMENT_SERVICE = 'billing';

/**
 * A service token from anyone but billing is refused. The ROUTE enforces this
 * (`requireInternalService({ callers: ['billing'] })` via `serviceOrUserGates`);
 * re-checked here so the controller is never the weaker of the two.
 */
function isEntitlementService(req: Parameters<typeof isServicePrincipal>[0]): boolean {
  return isServicePrincipal(req) && isServicePrincipalNamed(req, ENTITLEMENT_SERVICE);
}

/**
 * Defense-in-depth for the seat-limit trust boundary: the caller is
 * authoritative, so a cap BELOW current pooled usage is not blocked — but it
 * means members are stranded (or a caller-side gate regressed), so make it
 * observable (metric + warn). Never throws: the write is already committed.
 */
async function warnIfBelowUsage(orgId: string, seats: number): Promise<void> {
  if (seats < 0) return;
  try {
    const { used } = await pooledSeatUsage(orgId);
    if (used > seats) {
      logger.warn('Seat-limit set below current pooled usage — members may be stranded', { orgId, seats, used });
      incCounter('platform_seat_limit_below_usage_total');
    }
  } catch (err) {
    logger.warn('Pooled-seat over-cap check failed', { orgId, err: errorMessage(err) });
  }
}

/**
 * PUT /organization/:id/seat-limit — internal: set the account seat limit.
 *
 * `seats` is platform-owned (not a quota-service type), so the billing service
 * syncs the effective seat entitlement (tier base + bundles) here. Two callers:
 * the BILLING service (no step-up — service-to-service), pushing the full
 * limits payload, or a platform operator holding `orgs:manage` (route: system
 * org + aal2 + step-up, like `PATCH /:id/tier`), overriding `seats` alone. Any
 * other service is refused. `:id` must be the account
 * ROOT — a team id is refused with 409 (never redirected).
 */
export const updateOrganizationSeatLimit = withController('Update organization seat limit', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const allowed = isServicePrincipal(req) ? isEntitlementService(req) : userHasPermission(req, 'orgs:manage');
  if (!allowed) {
    return forbid(req, res, 'internal-service (billing) or orgs:manage', 'Forbidden: billing service or orgs:manage only');
  }

  const id = getParam(req.params, 'id')!;
  const body = (req.body ?? {}) as {
    seats?: unknown; supportContacts?: unknown; supportPremiumContacts?: unknown; features?: unknown; tier?: unknown;
  };
  if (typeof body.seats !== 'number' || !Number.isInteger(body.seats) || body.seats < -1) {
    return sendError(res, 400, 'seats must be an integer >= -1');
  }
  const seats = body.seats;

  // A platform operator overrides the SEAT CAP only (the admin Seats card sends
  // `{ seats }`). Features, tier and the support caps are billing's: a tier
  // pushed here would skip the over-cap / team-stranding guard that billing (and
  // `PATCH /:id/tier`) run, so an operator body carrying any of them is refused.
  if (!isServicePrincipal(req)) {
    const billingOwned = (['features', 'tier', 'supportContacts', 'supportPremiumContacts'] as const)
      .filter((f) => body[f] !== undefined);
    if (billingOwned.length > 0) {
      return sendError(res, 400, `An operator override sets seats only; ${billingOwned.join(', ')} are synced by billing`);
    }
    const override = await organizationService.setAccountSeats(id, seats);
    if (!override) return sendError(res, 404, 'Organization not found');
    await warnIfBelowUsage(id, seats);
    audit(req, 'admin.org.seatLimit.update', {
      targetType: 'organization',
      targetId: id,
      affectedOrgId: override.rootOrgId,
      details: { seats, previous: override.previous, override: true },
    });
    logger.info('Seat limit overridden', { orgId: id, rootOrgId: override.rootOrgId, seats, by: req.user!.sub });
    return sendSuccess(res, 200, override, 'Seat limit updated');
  }

  // Billing pushes the FULL limits payload every time (seats, both support caps,
  // features, tier): each field is required, so a partial push is refused.
  // Account-level feature entitlements (purchased bundles).
  if (!Array.isArray(body.features) || body.features.some((f) => typeof f !== 'string')) {
    return sendError(res, 400, 'features must be an array of strings');
  }
  const features = body.features as string[];
  // Whitelist against the canonical feature-flag registry: these entitlements
  // are persisted onto the root AND propagated to every descendant team, so an
  // unknown/junk flag would perpetually trip billing's entitlement-drift
  // reconciler and pollute `featureEntitlements`. Reject rather than silently
  // accept arbitrary strings (defense-in-depth against a bogus-flag injection).
  const unknownFlags = features.filter((f) => !isValidFeatureFlag(f));
  if (unknownFlags.length > 0) {
    return sendError(res, 400, `features contains unknown feature flag(s): ${unknownFlags.join(', ')}`);
  }
  // The account tier — billing pushes it so a plan DOWNGRADE invalidates
  // stale tokens (setSeatLimit sets only the tier label, no quota reseed).
  //
  // TRUST BOUNDARY: unlike the sysadmin `PATCH /organization/:id/tier` route, this path runs NO
  // over-cap / team-stranding guard (`checkTierOvercap`). Billing is the sole
  // caller and gates the downgrade via `checkEntitlementOvercap` BEFORE calling
  // this endpoint, so the guard lives caller-side by design (operators cannot
  // push a tier here — see the override branch above).
  if (typeof body.tier !== 'string' || !VALID_TIERS.includes(body.tier as PlanTier)) {
    return sendError(res, 400, `tier must be one of: ${VALID_TIERS.join(', ')}`);
  }
  const tier = body.tier as PlanTier;

  // Support contacts and the premium UPGRADE cap: the other platform-owned tier
  // limits, synced on the same leg and validated like `seats` (-1 = unlimited).
  if (typeof body.supportContacts !== 'number' || !Number.isInteger(body.supportContacts) || body.supportContacts < -1) {
    return sendError(res, 400, 'supportContacts must be an integer >= -1');
  }
  const supportContacts = body.supportContacts;
  if (typeof body.supportPremiumContacts !== 'number'
    || !Number.isInteger(body.supportPremiumContacts)
    || body.supportPremiumContacts < -1) {
    return sendError(res, 400, 'supportPremiumContacts must be an integer >= -1');
  }
  const supportPremiumContacts = body.supportPremiumContacts;

  const result = await organizationService.setSeatLimit(
    id, seats, features, tier, supportContacts, supportPremiumContacts,
  );
  if (!result) return sendError(res, 404, 'Organization not found');
  await warnIfBelowUsage(id, seats);

  // Entitlement mutation on the account root (+ its descendants) — leave an audit
  // trail like every other admin org mutation (setTier, member ops, delete).
  audit(req, 'admin.org.seatLimit.update', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: result.rootOrgId,
    // Record the features added/removed DELTA (not just the resulting set) so a
    // DORA (advanced_reporting) access grant/revoke — or any bundle entitlement
    // change — is reconstructable from the audit trail alone.
    // `previous` is the root's limits before this write, so a downgrade or a
    // support-contact change reads as a before/after rather than a bare value.
    details: {
      seats,
      supportContacts,
      supportPremiumContacts,
      previous: result.previous,
      features,
      ...(result.featureDelta &&
      (result.featureDelta.added.length > 0 || result.featureDelta.removed.length > 0)
        ? { featuresAdded: result.featureDelta.added, featuresRemoved: result.featureDelta.removed }
        : {}),
      tier,
    },
  });
  logger.info('Seat limit synced', { orgId: id, rootOrgId: result.rootOrgId, seats, features, tier, by: req.user!.sub });
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
  if (isServicePrincipal(req) ? !isEntitlementService(req) : !(await canAdministerOrg(req, id))) {
    return forbid(req, res, 'internal-service (billing) or org-admin', 'Forbidden: billing service or organization-admin only');
  }
  const usage = await pooledSeatUsage(id);
  sendSuccess(res, 200, usage);
});

/**
 * GET /organization/:id/support-usage — internal: the account's (root)
 * support-contact caps and pooled ACTIVE designations, as
 * `{ supportContacts: { limit, used }, supportPremiumContacts: { limit, used } }`
 * (`-1` limit = unlimited). Billing's support over-cap gate reads `used`, its
 * entitlement-drift reconciler `limit`. Same gate as seat-usage: a service
 * principal, or an admin reading their OWN account.
 */
export const getOrganizationSupportUsage = withController('Get organization support usage', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const id = getParam(req.params, 'id')!;
  if (isServicePrincipal(req) ? !isEntitlementService(req) : !(await canAdministerOrg(req, id))) {
    return forbid(req, res, 'internal-service (billing) or org-admin', 'Forbidden: billing service or organization-admin only');
  }
  const { pooledSupportUsage } = await import('../helpers/support-entitlement.js');
  sendSuccess(res, 200, await pooledSupportUsage(id));
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
  if (isServicePrincipal(req) ? !isEntitlementService(req) : !(await canAdministerOrg(req, id))) {
    return forbid(req, res, 'internal-service (billing) or org-admin', 'Forbidden: billing service or organization-admin only');
  }
  const featureEntitlements = await pooledFeatureEntitlements(id);
  sendSuccess(res, 200, { featureEntitlements });
});
