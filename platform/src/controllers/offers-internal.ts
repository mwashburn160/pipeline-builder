// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { PLATFORM_INTERNAL, createLogger, sendSuccess, getParam } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';
import { expandOrgScope } from '../helpers/org-hierarchy.js';
import { toOrgId } from '../helpers/org-id.js';
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
 * Counted per PERSON, not per membership row: seats are distinct people (the
 * rule `helpers/seats.ts` counts by), and someone in the root and a team holds
 * one seat. Each person is judged on their memberships across the subtree
 * TOGETHER — their latest `lastActiveAt` and their earliest `createdAt`.
 *
 * Three counts, so the caller can tell disengagement from onboarding:
 *   - `activeMembers` — a session inside the window (latest `lastActiveAt >= since`);
 *   - `newMembers` — JOINED the account inside the window (earliest
 *     `createdAt >= since`) and not active in it (no `lastActiveAt`, or one
 *     before the window). A member added yesterday who has not signed in yet is
 *     not a disengaging seat — but a veteran merely added to a new team is;
 *   - inactive = `seatsHeld − activeMembers − newMembers` — held since before
 *     the window and unused throughout it. The three are disjoint.
 */
export async function getOrgSeatActivity(req: Request, res: Response): Promise<void> {
  const orgId = getParam(req.params, 'orgId')!;
  // Never fails: an unreadable window falls back to the default, as it always has.
  const { windowDays } = SEAT_ACTIVITY.query!.parse(req.query ?? {});
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // An aggregation does not cast, so the scope ids are ObjectIds explicitly.
  const scope = (await expandOrgScope(orgId)).map(toOrgId);
  // `$gte` against a missing `lastActiveAt` ($max of nothing is null) is false:
  // null sorts below every date, so "never active" reads as not active.
  const active = { $gte: ['$lastActiveAt', since] };
  const [row] = await UserOrganization.aggregate<{ seatsHeld: number; activeMembers: number; newMembers: number }>([
    { $match: { organizationId: { $in: scope }, isActive: true } },
    { $group: { _id: '$userId', lastActiveAt: { $max: '$lastActiveAt' }, joinedAt: { $min: '$createdAt' } } },
    {
      $group: {
        _id: null,
        seatsHeld: { $sum: 1 },
        activeMembers: { $sum: { $cond: [active, 1, 0] } },
        newMembers: { $sum: { $cond: [{ $and: [{ $not: [active] }, { $gte: ['$joinedAt', since] }] }, 1, 0] } },
      },
    },
  ]);
  const { seatsHeld = 0, activeMembers = 0, newMembers = 0 } = row ?? {};

  logger.debug('Served seat-activity read', { orgId, seatsHeld, activeMembers, newMembers });
  sendSuccess(res, 200, {
    seatActivity: {
      orgId,
      windowDays,
      /** Distinct people with an active membership across the account subtree. */
      seatsHeld,
      /** Those with a session inside the window. */
      activeMembers,
      /** Joined inside the window and not active in it (see above). */
      newMembers,
    },
  });
}
