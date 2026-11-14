// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The account's OPTIONAL AI controls, applied to every `aiCalls` RESERVATION
 * before the counter moves. Both default OFF (no settings row, or `null`):
 *
 *  - PER-MEMBER SHARE (`aiCallsPerMemberPct`): one person may spend at most
 *    `pct %` of the account's `aiCalls` limit per period, so a single heavy user
 *    can't drain the pool for the team. Read from the usage ledger (the
 *    member's counted − refunded units this period, across the account), and
 *    applied to USER principals only — a service account is automation, not a
 *    member. A scheduled report summary is attributed to its owner, so it draws
 *    on the owner's share.
 *  - TOKEN BUDGET (`aiTokenBudget`): total platform-key tokens (in + out) the
 *    account may spend per period — a dollar-shaped ceiling beside the call
 *    count. Read from the bucket token sums the after-the-call usage reports
 *    write. Reports land AFTER a call, so the budget is checked against what was
 *    spent BEFORE this reservation: a call in flight can carry the total past
 *    it once; the next reservation is refused.
 *
 * Both are SOFT pre-checks (a read, then the atomic counter reservation), so two
 * concurrent calls from one member at the edge of the share can both pass —
 * the account's own cap stays exact because the counter reservation is atomic.
 * A failed read FAILS OPEN (logged, `quota_ai_controls_fail_open_total`): the
 * controls are a tenant-chosen refinement under a cap that is still enforced.
 */

import { createLogger, emitCounter, ErrorCode, errorMessage, type QuotaUsageAttribution } from '@pipeline-builder/api-core';
import type { QuotaService } from './quota-service.js';
import { aiCallsByPrincipalSince, aiTokensSince } from './usage-ledger.js';
import { resolveRootOrgId } from '../helpers/org-hierarchy.js';
import { periodDaysFor } from '../helpers/quota-helpers.js';
import { QuotaNoticeSettings } from '../models/quota-notice.js';

const logger = createLogger('ai-controls');

const DAY_MS = 86_400_000;

/** How long one account's controls are reused before re-reading (a settings save invalidates at once on this pod). */
const CONTROLS_CACHE_TTL_MS = 30_000;

export interface AiControls {
  aiCallsPerMemberPct: number | null;
  aiTokenBudget: number | null;
}

const cache = new Map<string, { at: number; controls: AiControls }>();

/** The account's AI controls (cached briefly; a missing row = both off). */
export async function aiControlsFor(rootOrgId: string): Promise<AiControls> {
  const hit = cache.get(rootOrgId);
  if (hit && Date.now() - hit.at < CONTROLS_CACHE_TTL_MS) return hit.controls;
  const row = await QuotaNoticeSettings.findOne({ orgId: rootOrgId }, { aiCallsPerMemberPct: 1, aiTokenBudget: 1 }).lean();
  const controls: AiControls = {
    aiCallsPerMemberPct: row?.aiCallsPerMemberPct ?? null,
    aiTokenBudget: row?.aiTokenBudget ?? null,
  };
  cache.set(rootOrgId, { at: Date.now(), controls });
  return controls;
}

/** Drop a cached entry (after a settings save) — other pods converge within the TTL. */
export function invalidateAiControls(rootOrgId: string): void {
  cache.delete(rootOrgId);
}

/** Test seam: forget every cached entry. */
export function clearAiControlsCache(): void {
  cache.clear();
}

/** A reservation refused by an AI control: the 429 the increment route answers. */
export interface AiControlDenial {
  code: ErrorCode.AI_MEMBER_SHARE_EXCEEDED | ErrorCode.AI_TOKEN_BUDGET_EXCEEDED;
  message: string;
  quota: { type: 'aiCalls'; limit: number; used: number; remaining: number; resetAt: string };
}

/**
 * Apply the account's AI controls to one `aiCalls` reservation of `amount`
 * units. `null` = allowed (or no control set, or a read failed).
 */
export async function checkAiControls(
  svc: Pick<QuotaService, 'getQuotaStatus'>,
  orgId: string,
  amount: number,
  attribution: QuotaUsageAttribution | undefined,
): Promise<AiControlDenial | null> {
  try {
    const rootOrgId = await resolveRootOrgId(orgId);
    const controls = await aiControlsFor(rootOrgId);
    const shareApplies = controls.aiCallsPerMemberPct !== null
      && attribution?.principalType === 'user'
      && typeof attribution.principalId === 'string';
    if (controls.aiTokenBudget === null && !shareApplies) return null;

    // The period the account's counter is in: [resetAt − period length, resetAt).
    const status = await svc.getQuotaStatus(orgId, 'aiCalls');
    const resetAt = new Date(status.resetAt);
    const periodStart = new Date(resetAt.getTime() - periodDaysFor('aiCalls') * DAY_MS);

    if (controls.aiTokenBudget !== null) {
      const spent = await aiTokensSince(rootOrgId, periodStart);
      if (spent >= controls.aiTokenBudget) {
        return {
          code: ErrorCode.AI_TOKEN_BUDGET_EXCEEDED,
          message: `Your organization's AI token budget for this period is spent (${spent.toLocaleString('en-US')} of ${controls.aiTokenBudget.toLocaleString('en-US')} tokens). It resets ${resetAt.toISOString()}; a billing contact can raise it in Quota settings.`,
          quota: { type: 'aiCalls', limit: controls.aiTokenBudget, used: spent, remaining: 0, resetAt: resetAt.toISOString() },
        };
      }
    }

    if (shareApplies && status.limit !== -1) {
      const share = Math.max(1, Math.floor((status.limit * controls.aiCallsPerMemberPct!) / 100));
      const used = await aiCallsByPrincipalSince(rootOrgId, attribution!.principalId!, periodStart);
      if (used + amount > share) {
        return {
          code: ErrorCode.AI_MEMBER_SHARE_EXCEEDED,
          message: `You've used your share of the organization's AI calls for this period (${used} of ${share} — ${controls.aiCallsPerMemberPct}% of the organization's ${status.limit}). It resets ${resetAt.toISOString()}; a billing contact can change the per-member share in Quota settings.`,
          quota: { type: 'aiCalls', limit: share, used, remaining: Math.max(0, share - used), resetAt: resetAt.toISOString() },
        };
      }
    }
    return null;
  } catch (err) {
    logger.warn('AI controls could not be checked; allowing the reservation', { orgId, error: errorMessage(err) });
    emitCounter('quota_ai_controls_fail_open_total', {});
    return null;
  }
}
