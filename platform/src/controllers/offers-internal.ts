// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { PLATFORM_INTERNAL, createLogger, sendSuccess, getParam } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';
import { expandOrgScope } from '../helpers/org-hierarchy.js';
import UserOrganization from '../models/user-organization.js';

const logger = createLogger('offers-internal');

/** The window (default 30 days, clamped to 1..365) is parsed by the endpoint's contract. */
const { offerSeatActivity: SEAT_ACTIVITY } = PLATFORM_INTERNAL;

/**
 * GET /internal/offers/seat-activity/:orgId — seats held against members who
 * actually used them.
 *
 * The VALUE signal, and the reason it
 * exists is that it DISQUALIFIES: "an account at 95% of a cap that is quietly
 * disengaging is a churn save, not an expansion, and offering it an upgrade is
 * the worst available outcome." A pressure-only profile cannot tell that account
 * from one that has genuinely outgrown its tier.
 *
 * Counted across the ACCOUNT SUBTREE, because seats pool at the root: counting
 * only the root's own memberships would report a parent org with all its people
 * in teams as having nobody active.
 *
 * A membership whose seat has not been used in the window — including one never
 * used since joining, which carries no `lastActiveAt` stamp — is inactive.
 */
export async function getOrgSeatActivity(req: Request, res: Response): Promise<void> {
  const orgId = getParam(req.params, 'orgId')!;
  // Never fails: an unreadable window falls back to the default, as it always has.
  const { windowDays } = SEAT_ACTIVITY.query!.parse(req.query ?? {});
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const scope = await expandOrgScope(orgId);
  const match = { organizationId: { $in: scope }, isActive: true };

  const [seatsHeld, activeMembers] = await Promise.all([
    UserOrganization.countDocuments(match),
    UserOrganization.countDocuments({ ...match, lastActiveAt: { $gte: since } }),
  ]);

  logger.debug('Served seat-activity read', { orgId, seatsHeld, activeMembers });
  sendSuccess(res, 200, {
    seatActivity: {
      orgId,
      windowDays,
      /** Active memberships across the account subtree. */
      seatsHeld,
      /** Those with a session inside the window. */
      activeMembers,
    },
  });
}
