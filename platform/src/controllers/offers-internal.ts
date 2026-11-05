// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, sendSuccess, getParam, parseQueryString } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';
import UserOrganization from '../models/user-organization.js';
import { expandOrgScope } from '../helpers/org-hierarchy.js';

const logger = createLogger('offers-internal');

/** Default activity window, in days — a billing period is the unit that matters. */
const DEFAULT_WINDOW_DAYS = 30;
/** Bounded so a caller cannot ask for an unbounded scan of history. */
const MAX_WINDOW_DAYS = 365;

/**
 * GET /internal/offers/seat-activity/:orgId — seats held against members who
 * actually used them.
 *
 * The VALUE signal (docs/plans/sales-agent.md D4 Class 3), and the reason it
 * exists is that it DISQUALIFIES: "an account at 95% of a cap that is quietly
 * disengaging is a churn save, not an expansion, and offering it an upgrade is
 * the worst available outcome." A pressure-only profile cannot tell that account
 * from one that has genuinely outgrown its tier.
 *
 * Counted across the ACCOUNT SUBTREE, because seats pool at the root: counting
 * only the root's own memberships would report a parent org with all its people
 * in teams as having nobody active.
 *
 * `unknownActivity` is reported SEPARATELY from inactive, and the distinction is
 * load-bearing: `lastActiveAt` is absent for every membership that predates the
 * field, and treating absent as inactive would make every established account
 * look dormant — which argues against exactly the offers it should receive.
 * A caller that cannot tell the two apart should skip the signal, not use it.
 */
export async function getOrgSeatActivity(req: Request, res: Response): Promise<void> {
  const orgId = getParam(req.params, 'orgId')!;
  const requested = Number(parseQueryString(req.query.windowDays) ?? DEFAULT_WINDOW_DAYS);
  const windowDays = Number.isFinite(requested)
    ? Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.trunc(requested)))
    : DEFAULT_WINDOW_DAYS;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const scope = await expandOrgScope(orgId);
  const match = { organizationId: { $in: scope }, isActive: true };

  const [seatsHeld, activeMembers, unknownActivity] = await Promise.all([
    UserOrganization.countDocuments(match),
    UserOrganization.countDocuments({ ...match, lastActiveAt: { $gte: since } }),
    UserOrganization.countDocuments({ ...match, lastActiveAt: { $exists: false } }),
  ]);

  logger.debug('Served seat-activity read', { orgId, seatsHeld, activeMembers, unknownActivity });
  sendSuccess(res, 200, {
    seatActivity: {
      orgId,
      windowDays,
      /** Active memberships across the account subtree. */
      seatsHeld,
      /** Those with a session inside the window. */
      activeMembers,
      /** Those with NO stamp at all — unknown, not inactive. */
      unknownActivity,
    },
  });
}
