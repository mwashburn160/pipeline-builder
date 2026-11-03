// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Campaign rules applied at redemption: the window, the one-per-account rule and
 * the shared budget. See `models/campaign.ts` for why these live on the campaign
 * rather than on each code.
 *
 * Every refusal here is checked BEFORE the discount's own atomic reserve, for the
 * same reason the aggregate floor is: a refusal must not burn one of a limited
 * code's redemptions. The budget is the exception — it IS a reservation, so it is
 * claimed alongside the redemption and released on any later failure.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { Campaign } from '../models/campaign.js';
import type { CampaignDocument } from '../models/campaign.js';
import { aggregateLedgerSpend, type LedgerSpend } from './ledger-spend.js';
import { Discount } from '../models/discount.js';
import type { SubscriptionDocument } from '../models/subscription.js';

const logger = createLogger('campaign');

/**
 * The canonical form of a campaign name: trimmed and lower-cased.
 *
 * Case-folded deliberately. `alias` is upper-cased at mint for the same reason —
 * a redemption handle a human types must not depend on shift — and a campaign is
 * a GROUPING key, where `SUMMER26` and `summer26` being two campaigns is never
 * what anyone means. Applied at mint AND at lookup, so the two cannot disagree.
 */
export function normalizeCampaignId(raw: string): string {
  return raw.trim().toLowerCase();
}

/** A refusal: the status/error/code triple the redemption path returns. */
export interface CampaignRefusal {
  status: number;
  error: string;
  code: string;
}

/**
 * Why this campaign cannot be redeemed from right now — revoked, not yet open, or
 * closed — or `null` when it is open. Mirrors `Discount`'s own active/expiry
 * checks, one rung up: revoking the campaign stops every code in it at once.
 */
export function campaignWindowRefusal(campaign: CampaignDocument, now: Date = new Date()): CampaignRefusal | null {
  if (!campaign.isActive) {
    return { status: 409, error: 'This campaign is no longer running', code: 'CAMPAIGN_INACTIVE' };
  }
  if (campaign.startsAt && campaign.startsAt.getTime() > now.getTime()) {
    return { status: 409, error: 'This campaign has not started yet', code: 'CAMPAIGN_NOT_STARTED' };
  }
  if (campaign.endsAt && campaign.endsAt.getTime() < now.getTime()) {
    return { status: 409, error: 'This campaign has ended', code: 'CAMPAIGN_ENDED' };
  }
  return null;
}

/**
 * Has this account already redeemed ANY code in `campaignId`?
 *
 * Order-independent by construction: it asks the CAMPAIGN whether the account has
 * a sibling redemption, rather than asking each code whether it opted in. The
 * per-code flag this replaces could be set on some codes and not others, so
 * redeeming the unflagged one first let both through.
 *
 * Costs one query over the ids the account already holds — not a scan of the
 * campaign — because the ledger is the shorter list.
 */
export async function orgRedeemedCampaign(
  campaignId: string,
  subscription: Pick<SubscriptionDocument, 'creditLedger'>,
  excludeDiscountId?: string,
): Promise<boolean> {
  const redeemedIds = (subscription.creditLedger ?? [])
    .map((c) => c.discountId)
    .filter((id) => id !== excludeDiscountId);
  if (redeemedIds.length === 0) return false;
  const sibling = await Discount.exists({ _id: { $in: redeemedIds }, campaign: campaignId });
  return sibling !== null;
}

/**
 * Claim `cents` of the campaign's budget, atomically under the budget guard.
 *
 * `$expr` so the comparison reads the document's own fields: two concurrent
 * redemptions cannot both pass a read-then-write check, the same reason the
 * discount's `maxRedemptions` reserve is shaped this way. A campaign with no
 * `budgetCents` is unlimited — the counters still move, so spend stays reportable.
 *
 * @returns true when the budget was claimed; false when this redemption would
 *          overshoot it (the caller refuses) or the campaign vanished.
 */
export async function reserveCampaignBudget(campaignId: string, cents: number): Promise<boolean> {
  const claimed = await Campaign.findOneAndUpdate(
    {
      _id: campaignId,
      isActive: true,
      $or: [
        { budgetCents: { $exists: false } },
        { budgetCents: null },
        { $expr: { $lte: [{ $add: ['$spentCents', cents] }, '$budgetCents'] } },
      ],
    },
    { $inc: { spentCents: cents, grantsCount: 1 } },
  );
  if (!claimed) {
    incCounter('billing_campaign_budget_refused_total', {});
    logger.warn('Refused a redemption that would overshoot the campaign budget', { campaignId, cents });
  }
  return claimed !== null;
}

/**
 * Give budget back after a redemption failed downstream.
 *
 * Guarded on `spentCents >= cents` for the reason the redemption-count release is
 * guarded on `> 0`: `$inc` bypasses the schema's `min: 0`, and a negative
 * `spentCents` would make the budget guard permanently satisfiable — defeating
 * the budget rather than merely miscounting it.
 */
export async function releaseCampaignBudget(campaignId: string, cents: number): Promise<void> {
  await Campaign.findOneAndUpdate(
    { _id: campaignId, spentCents: { $gte: cents } },
    { $inc: { spentCents: -cents, grantsCount: -1 } },
  ).catch(() => undefined);
}

/**
 * Campaign spend AS THE LEDGER HAS IT — the authority, against which the
 * campaign's own `spentCents` / `grantsCount` are an advisory cache. Possible at
 * all only because the grant path stamps `campaign` onto each row: before that,
 * answering this meant joining ledger rows back through discount records.
 */
export async function aggregateCampaignLedgerSpend(campaignId: string): Promise<LedgerSpend> {
  return aggregateLedgerSpend({ 'creditLedger.campaign': campaignId });
}

/**
 * End a campaign and every code in it, in one call.
 *
 * Ending a campaign used to mean a `PUT` per code — the read side could filter by
 * campaign but the write side had no equivalent, so a fifty-code campaign was
 * fifty requests and any missed one stayed live. Flipping the campaign alone
 * already stops redemption (`campaignWindowRefusal`), but the codes are left
 * reading `isActive: true`, so this closes both rungs and the console shows the
 * truth.
 *
 * @returns how many discount records were deactivated.
 */
export async function endCampaign(campaignId: string): Promise<number> {
  await Campaign.updateOne({ _id: campaignId }, { $set: { isActive: false } });
  const result = await Discount.updateMany({ campaign: campaignId, isActive: true }, { $set: { isActive: false } });
  logger.info('Campaign ended with its codes', { campaignId, discountsDeactivated: result.modifiedCount });
  return result.modifiedCount;
}
