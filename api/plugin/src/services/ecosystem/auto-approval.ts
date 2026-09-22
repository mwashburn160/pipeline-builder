// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Automatic decisions: the system-org auto-approval rules and the bootstrap
 * exception, evaluated right after a request is submitted. A rule's rate caps
 * are re-counted under its advisory lock when it claims a request.
 */

import { createLogger, errorMessage, isOfficialAutoApprovalEnabled, isSystemOrgId, SYSTEM_ACTOR_ID } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { type EcosystemAutoApprovalRule, type PluginListing, type PluginPublishRequest, type Publisher } from '@pipeline-builder/pipeline-data';
import { sql } from 'drizzle-orm';

import { ecosystemAudit } from './audit.js';
import { bootstrapEligible, countBootstrapApproval } from './bootstrap.js';
import { type Caller } from './context.js';
import { execute } from './execute.js';
import { type RequestMetadata } from './metadata.js';
import {
  notifyDecision, titleOfRequest,
} from './notify.js';
import { contractDiff, evaluateAutoRule, specSnapshot, versionBump, vulnDelta, type AutoApprovalContext, type AutoRuleConditions } from './policy.js';
import { atomically, elevated, listings, plugins, previousVersion, requests, rules, type PluginRow } from './store.js';
import { isActiveListing } from './util.js';

const logger = createLogger('ecosystem-auto-approval');

type Req = PluginPublishRequest;
const payloadOf = (r: Req) => (r.payload ?? {}) as Record<string, unknown>;

// -----------------------------------------------------------------------------
// Auto-approval rules
// -----------------------------------------------------------------------------

/** Whether the rule's instance flag is on (a rule without one always is). */
export function ruleFlagOn(conditions: AutoRuleConditions): boolean {
  return conditions.instanceFlag === 'OFFICIAL_AUTO_APPROVAL_ENABLED' ? isOfficialAutoApprovalEnabled() : true;
}

/** Everything but the rate counters a rule decides on (shared with the review view). */
export async function autoApprovalFacts(r: Req, publisher: Publisher, listing: PluginListing | null, plugin: PluginRow | null): Promise<Omit<AutoApprovalContext, 'approvedToday' | 'approvedTodayForListing' | 'flagOn'>> {
  const submitter = payloadOf(r).submitter as { principalType?: string; name?: string } | undefined;
  const loader = submitter?.principalType === 'service_account' && r.submittedOrgId && isSystemOrgId(r.submittedOrgId) ? submitter.name ?? null : null;
  const base = {
    kind: r.kind,
    publisherTier: publisher.tier,
    submitterServiceAccount: loader,
    listingLive: !!listing && isActiveListing(listing),
    securityLane: r.lane === 'security',
  };
  if (r.kind === 'new_version' && plugin) {
    const prev = await previousVersion(listing?.id ?? null, r.version);
    const hasImage = plugin.imageDigest !== null;
    return {
      ...base,
      bump: versionBump(prev?.version ?? null, plugin.version),
      breaking: payloadOf(r).breaking === true || plugin.breaking === true,
      diff: contractDiff(prev?.specSnapshot ?? null, specSnapshot(plugin)),
      vuln: vulnDelta(prev ? { critical: prev.vulnCritical, high: prev.vulnHigh } : null, { critical: plugin.vulnCritical, high: plugin.vulnHigh }),
      signed: hasImage || plugin.buildType === 'metadata_only',
      scanned: !hasImage || plugin.scannedAt !== null,
    };
  }
  if (r.kind === 'listing_update') {
    return { ...base, changedFields: Object.keys(((payloadOf(r).metadata as RequestMetadata | undefined)?.values) ?? {}) };
  }
  return base;
}

/** Evaluate one rule for `r` (rate counters included). */
export async function evaluateRuleFor(rule: EcosystemAutoApprovalRule, r: Req, facts: Awaited<ReturnType<typeof autoApprovalFacts>>): Promise<{ eligible: boolean; reasons: string[] }> {
  const conditions = (rule.conditions ?? {}) as AutoRuleConditions;
  const since = new Date(Date.now() - 24 * 3_600_000);
  // The caps count approvals of the SAME kind ("1 auto-approved VERSION per
  // listing per day"): a text-only listing update never eats a version's slot.
  const today = (conditions.maxPerDay !== undefined || conditions.maxPerListingPerDay !== undefined)
    ? (await requests.autoApprovedSince(rule.id, since)).filter((t) => t.kind === r.kind) : [];
  return evaluateAutoRule(conditions, {
    ...facts,
    approvedToday: today.length,
    approvedTodayForListing: today.filter((t) => t.listingId !== null && t.listingId === r.listingId).length,
    flagOn: ruleFlagOn(conditions),
  });
}

/** The first ENABLED rule that approves `r`, and why each rule declined. */
export async function matchingRule(r: Req, publisher: Publisher, listing: PluginListing | null, plugin: PluginRow | null): Promise<{ rule: EcosystemAutoApprovalRule | null; reasons: string[] }> {
  if (r.kind !== 'new_version' && r.kind !== 'listing_update') return { rule: null, reasons: [`${r.kind} requests are never auto-approved`] };
  const facts = await autoApprovalFacts(r, publisher, listing, plugin);
  const reasons: string[] = [];
  for (const rule of (await rules.list()).filter((x) => x.enabled)) {
    const verdict = await evaluateRuleFor(rule, r, facts);
    if (verdict.eligible) return { rule, reasons: [] };
    reasons.push(...verdict.reasons.map((why) => `${rule.name}: ${why}`));
  }
  return { rule: null, reasons: reasons.length ? reasons : ['no auto-approval rule is enabled'] };
}

/**
 * Claim `r` for `rule` under the rule's advisory lock: the rate caps are
 * re-counted and the claim written in ONE transaction that concurrent
 * auto-decisions of the same rule serialize on, so two submissions can't both
 * read "0 of 1 today" and both be approved. Null when the cap filled meanwhile
 * (or the request was decided).
 */
async function claimForRule(r: Req, rule: EcosystemAutoApprovalRule, facts: Awaited<ReturnType<typeof autoApprovalFacts>>): Promise<Req | null> {
  return atomically(async () => {
    await elevated((tx) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ecosystem-auto-rule:${rule.id}`}))`));
    if (!(await evaluateRuleFor(rule, r, facts)).eligible) return null;
    return requests.transition(r.id, 'pending', {
      status: 'approved', decidedBy: SYSTEM_ACTOR_ID, decidedAt: new Date(), autoRuleId: rule.id, payload: payloadOf(r),
    });
  });
}

/**
 * Right after a request is submitted: approve it automatically when the
 * bootstrap exception or an auto-approval rule covers it. Returns the decided
 * request, or null when it waits for a person. Never throws for a refused
 * EXECUTION: the request then stays pending for a manager.
 */
export async function autoDecide(r: Req, publisher: Publisher, submitter: Caller): Promise<Req | null> {
  const bootstrap = await bootstrapEligible(r, publisher, submitter);
  let rule: EcosystemAutoApprovalRule | null = null;
  let claimed: Req | null;
  if (bootstrap) {
    claimed = await requests.transition(r.id, 'pending', {
      status: 'approved', decidedBy: SYSTEM_ACTOR_ID, decidedAt: new Date(), autoRuleId: null, payload: { ...payloadOf(r), bootstrap: true },
    });
  } else {
    const listing = r.listingId ? await listings.byId(r.listingId) : null;
    const plugin = r.pluginId ? await plugins.byId(r.pluginId) : null;
    rule = (await matchingRule(r, publisher, listing, plugin)).rule;
    if (!rule) return null;
    claimed = await claimForRule(r, rule, await autoApprovalFacts(r, publisher, listing, plugin));
  }
  if (!claimed) return null;
  try {
    await execute(claimed, publisher, SYSTEM_ACTOR_ID, { human: false });
  } catch (err) {
    await requests.transition(r.id, 'approved', { status: 'pending', decidedBy: null, decidedAt: null, autoRuleId: null, payload: payloadOf(r) });
    logger.warn('Automatic approval could not execute; left for a manager', { requestId: r.id, error: errorMessage(err) });
    incCounter('ecosystem_auto_approval_failed_total', { kind: r.kind });
    return null;
  }
  if (bootstrap) await countBootstrapApproval();
  incCounter('ecosystem_auto_approvals_total', { kind: r.kind, rule: bootstrap ? 'bootstrap' : rule!.name });
  ecosystemAudit({
    action: 'plugin.request.auto-approve',
    actor: SYSTEM_ACTOR_ID,
    affectedOrgId: publisher.ownerOrgId,
    targetType: 'plugin-publish-request',
    targetId: r.id,
    details: {
      kind: r.kind,
      ...(bootstrap ? { bootstrap: true } : { autoRuleId: rule!.id, rule: rule!.name }),
      ...(r.version ? { version: r.version } : {}),
      ...(r.digest ? { digest: r.digest } : {}),
    },
  });
  await notifyDecision({ kind: r.kind, title: await titleOfRequest(claimed, publisher), publisherOrgId: publisher.ownerOrgId, approved: true, auto: true });
  return claimed;
}
