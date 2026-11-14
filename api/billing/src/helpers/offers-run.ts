// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The offer cycle — the thing that actually runs (docs/plans/sales-agent.md,
 * Phases 2 and 3 joined up).
 *
 * `offers-cycle.ts` decides and `offers-notify.ts` delivers; both are pure or
 * nearly so, deliberately. This is the impure seam: it reads, decides, records
 * and only then delivers.
 *
 * **Record before deliver, never the reverse.** The row is the idempotency key
 * (D15) and the thing Phase 6 counts. Delivering first and then failing to write
 * would offer the same account again next cycle, and two grants for one slot is
 * money. Writing first and failing to deliver costs one silent offer and shows
 * up as `billing_offer_emails_total{outcome="failed"}` — much the cheaper of the
 * two failures.
 *
 * **Consent is read LIVE, never from the profile row.** A profile is a snapshot
 * of a window that has closed — up to a month old for `cpuCredits` — so an
 * account that switched offers off yesterday must not be mailed from it. Both
 * switches ride the quota profile read billing already makes, so the fresh read
 * costs one request and no new route, and there is still exactly one place
 * either switch is evaluated.
 *
 * **Every considered account produces a row, including every refusal.** A cycle
 * that suppressed everything is indistinguishable from one that worked unless
 * each reason is counted separately — and "suppresses almost everything" is the
 * realistic failure mode of a feature built this cautiously.
 */

import {
  createLogger,
  createScheduler,
  emitCounter,
  quotaPackUnit,
  DEFAULT_LEADER_LOCK_TTL_MS,
  errorMessage,
  getServiceAuthHeader,
  isValidTier,
  leaderLockKey,
  OFFERS_AGENT_ACTOR_ID,
  recordAudit,
  type QuotaTier,
  type Scheduler,
  type BillingInterval,
} from '@pipeline-builder/api-core';
import { runWithTenantContext } from '@pipeline-builder/pipeline-data';
import { getBillingConfig } from '../config/billing-config.js';
import { config } from '../config.js';
import type { Addon } from './addon-catalog.js';
import { getBundleCatalog } from './billing-helpers.js';
import { evaluateCrossover } from './crossover.js';
import { fetchFrustrationSignal, fetchUsageProfile } from './downstream-client.js';
import {
  annualPackValue,
  candidatesFor,
  decideForAccount,
  packForDimension,
  recordDecision,
  type CycleDecision,
  type PackLike,
} from './offers-cycle.js';
import { deliverOffer, offerEmailText, type OfferEmailFacts, type PressurePoint } from './offers-notify.js';
import { sweepExpiredOffers } from './offers-outcome.js';
import { PRESSURE_RATIO, type ProfileLike } from './offers-rules.js';
import { MANAGEABLE_SUBSCRIPTION_STATUSES } from './subscription-status.js';
import { OfferExclusion } from '../models/offer-exclusion.js';
import { Offer } from '../models/offer.js';
import { Subscription } from '../models/subscription.js';
import { UsageProfile } from '../models/usage-profile.js';

const logger = createLogger('offers-run');

/**
 * How many periods of history the rules may look back over.
 *
 * Four, because the longest sustained-pressure rule asks for three consecutive
 * periods: a reader that loads exactly as many periods as the rule needs cannot
 * tell "three in a row" from "the only three there are".
 */
export const PROFILE_HISTORY_PERIODS = 4;

/**
 * A loaded profile. Wider than `ProfileLike` by the two figures the COPY needs:
 * the rules only compare ratios, but a mail that cannot say "9 of 10 pipelines"
 * is the vague advert Phase 3 refuses to send.
 */
export interface RunProfile extends ProfileLike {
  dimensions: Record<string, { ratio: number | null; crossed: number | null; used: number; limit: number }>;
}

export interface OfferCycleResult {
  /** Accounts the cycle evaluated. */
  considered: number;
  /** Decisions that came out as an offer and were recorded. */
  sent: number;
  /** Suppressions recorded, keyed by reason — the per-reason count D6 asks for. */
  suppressed: Record<string, number>;
  /** Slots a concurrent cycle had already written. */
  duplicate: number;
  /** Offers recorded but delivered on NEITHER surface. */
  undelivered: number;
}

/**
 * Run one cycle over every manageable subscription.
 *
 * Walks a cursor rather than loading accounts into memory, as the profile cycle
 * and `batchEvaluatePromotion` do. One account's failure is logged and skipped:
 * the next account's decision is independent, and a cycle that aborted on the
 * first bad read would deny every later account its turn while looking like a
 * cycle that simply found nothing.
 */
export async function runOfferCycle(now: Date = new Date()): Promise<OfferCycleResult> {
  const result: OfferCycleResult = { considered: 0, sent: 0, suppressed: {}, duplicate: 0, undelivered: 0 };

  // BEFORE deciding, not after. An offer past its clock still counts as `sent`
  // until it is swept, which would make the frequency gate treat a lapsed offer
  // as a live one and hold the account's slot for no reason.
  await sweepExpiredOffers(now);

  const cursor = Subscription.find({ status: { $in: [...MANAGEABLE_SUBSCRIPTION_STATUSES] } }).cursor();

  for await (const sub of cursor) {
    const orgId = sub.orgId;
    try {
      const outcome = await runForAccount({
        orgId,
        planId: sub.planId,
        interval: sub.interval,
        addons: (sub.addons ?? []).map((a) => ({ bundleId: a.bundleId, quantity: a.quantity })),
      }, now);
      if (!outcome) continue;
      result.considered += 1;
      if (!outcome.recorded) {
        result.duplicate += 1;
        continue;
      }
      if (outcome.decision.status === 'sent') {
        result.sent += 1;
        emitCounter('billing_offers_total', {
          outcome: 'sent',
          type: outcome.decision.chosen?.offerType ?? 'unknown',
        });
        if (outcome.delivered === false) result.undelivered += 1;
      } else if (outcome.decision.reason) {
        const reason = outcome.decision.reason;
        result.suppressed[reason] = (result.suppressed[reason] ?? 0) + 1;
        // PER REASON, which is the point (D6): a feature suppressing almost
        // everything looks identical to one working carefully unless each
        // reason is counted on its own.
        emitCounter('billing_offers_total', { outcome: 'suppressed', reason });
      }
    } catch (err) {
      // COUNTED, not only logged. Everything else about this cycle is counted —
      // sent, and suppressed per reason — so a cycle that throws on every
      // account emitted NOTHING and was indistinguishable from a cycle with no
      // eligible accounts. That is also why no alert could be written for it:
      // "the counter is flat" is the normal state of a small install, whereas
      // "accounts are erroring" never is.
      emitCounter('billing_offers_total', { outcome: 'error' });
      logger.warn('Offer cycle skipped an account', { orgId, error: errorMessage(err) });
    }
  }

  logger.info('Offer cycle complete', {
    considered: result.considered,
    sent: result.sent,
    duplicate: result.duplicate,
    undelivered: result.undelivered,
    suppressed: JSON.stringify(result.suppressed),
  });
  return result;
}

export interface AccountOutcome {
  decision: CycleDecision;
  /** False when a concurrent cycle had already written this slot. */
  recorded: boolean;
  /** Only meaningful for a sent decision. */
  delivered?: boolean;
}

export interface AccountInput {
  orgId: string;
  planId?: string;
  interval: BillingInterval;
  addons: Array<{ bundleId: string; quantity: number }>;
}

/**
 * One account's turn: read, decide, record, deliver.
 *
 * Returns null when there was nothing to decide at all — no plan, no tier, no
 * profile. Deliberately NOT a suppression row: a suppression means "we
 * considered this account and said no", and inventing one for an account the
 * cycle could not evaluate would inflate the very metric that tells an operator
 * the rules are too tight.
 */
export async function runForAccount(
  sub: AccountInput,
  now: Date = new Date(),
  /**
   * Who asked. `manual` for the operator trigger, and it is RECORDED rather than
   * only logged: "mixing them silently corrupts the only measurement that
   * matters", so a hand-triggered offer must never be counted as the agent's in
   * the outcome log or in the lift comparison.
   */
  source: 'agent' | 'manual' = 'agent',
  /**
   * WHO decided (D14). The cycle leaves this alone and the agent's own actor id
   * is used; the operator trigger passes the person who asked.
   */
  decidedBy: string = OFFERS_AGENT_ACTOR_ID,
): Promise<AccountOutcome | null> {
  const plan = getBillingConfig().plans.find((p) => p.id === sub.planId);
  const tier = plan?.tier;
  if (!tier || !isValidTier(tier)) return null;

  const profiles = await loadProfiles(sub.orgId);
  if (profiles.length === 0) return null;

  // The slot: one decision per account per profile PERIOD. A later period is a
  // later offer, which D15 requires to stay possible; the same period twice is
  // the duplicate the unique index refuses.
  const cycleKey = `period:${profiles[0]!.period}`;

  // Live, for consent. A failed read is not read as consent: the switches below
  // default to FALSE on a null, which fails closed exactly as D8 asks the whole
  // path to — unlike the customer-facing quota path, which fails open.
  const live = await fetchUsageProfile(
    sub.orgId,
    getServiceAuthHeader({ serviceName: 'billing', orgId: sub.orgId, role: 'member' }),
  ).catch(() => null);
  const rootOrgId = live?.rootOrgId ?? sub.orgId;
  const consent = {
    accountOptIn: live?.offersEnabled ?? false,
    noticesEnabled: live?.noticesEnabled ?? false,
  };

  const bundles = getBundleCatalog();
  const crossover = evaluateCrossover({
    tier,
    interval: sub.interval,
    addons: sub.addons as Addon[],
    plans: getBillingConfig().plans,
    bundles,
  });

  const candidates = candidatesFor({
    profiles,
    // A crossover whose saving depends on the account DROPPING add-ons is not
    // offered. The mail would promise a lower bill and the checkout would
    // present a higher one — the exact mismatch F1 exists to prevent.
    crossover: crossover.savingRequiresDrops ? null : crossover,
    annualValueForDimension: (dimension) => annualPackValue(dimension, bundles, tier),
    // The SAME resolver the value came from, so the basket the account is shown
    // is built from the pack the EV was computed on rather than a second guess.
    packIdForDimension: (dimension) => packForDimension(dimension, bundles, tier, sub.interval)?.id ?? null,
  });

  const [excluded, lastSent, frustration] = await Promise.all([
    OfferExclusion.exists({ orgId: rootOrgId }),
    Offer.findOne({ orgId: rootOrgId, sentAt: { $exists: true, $ne: null } }).sort({ sentAt: -1 }).lean(),
    // The Phase 4 signal. Read for every account the cycle reaches rather than
    // only for the ones a rule matched — it is a SUPPRESSION, so skipping it for
    // the accounts that are about to be offered to is skipping it exactly where
    // it matters. Null (unreachable) is no signal, never contentment.
    fetchFrustrationSignal(
      rootOrgId,
      getServiceAuthHeader({ serviceName: 'billing', orgId: rootOrgId, role: 'member' }),
    ).catch(() => null),
  ]);

  const decision = decideForAccount({
    orgId: rootOrgId,
    profiles,
    accountOptIn: consent.accountOptIn,
    doNotOffer: excluded !== null,
    lastSentAt: lastSent?.sentAt ?? null,
    lastWasDeclined: lastSent?.status === 'declined',
    candidates,
    frustration,
  }, { now });

  const facts = decision.status === 'sent'
    ? emailFactsFor({ decision, profiles, crossover, bundles, tier, interval: sub.interval })
    : null;
  // Rendered BEFORE the row is written, so the row stores what was actually
  // said. A null means the offer cannot be stated with both a limit and a price,
  // which `deliverOffer` turns into a `no_copy` outcome rather than a vague send.
  const copy = facts ? offerEmailText(facts) : null;

  const recorded = await recordDecision(
    decision,
    cycleKey,
    source,
    decidedBy,
    copy ? { subject: copy.subject, body: copy.text } : undefined,
  );
  if (!recorded) return { decision, recorded: false };
  if (decision.status !== 'sent' || !facts) return { decision, recorded: true };

  // The central trail, under the DECIDING actor (D14). The `Offer` row is the
  // detailed record; this is what makes the agent's work visible beside every
  // other audited billing action, and queryable by the actor that did it rather
  // than lost among system work.
  recordAudit({
    action: 'billing.offer.sent',
    actorId: decidedBy,
    orgId: rootOrgId,
    targetType: 'offer',
    targetId: cycleKey,
    details: {
      offerType: decision.chosen?.offerType ?? 'unknown',
      source,
      holdout: decision.holdout,
      // The signals, verbatim — the answer to "why did this account get this?"
      rationale: decision.chosen?.rationale ?? [],
    },
  });

  const delivery = await deliverOffer({ rootOrgId, consent, facts });
  return { decision, recorded: true, delivered: delivery.inApp || delivery.email === 'sent' };
}

/** This account's profile history, NEWEST FIRST — the order the rules assume. */
export async function loadProfiles(orgId: string): Promise<RunProfile[]> {
  const rows = await UsageProfile.find({ orgId })
    .sort({ period: -1 })
    .limit(PROFILE_HISTORY_PERIODS)
    .lean();
  return rows.map((r) => ({
    period: r.period,
    // Normalised rather than assumed: a `Map`-typed path can come back as a Map
    // even under `.lean()`, and a Map reaching the rules as `dimensions` makes
    // every `Object.entries` empty — silently suppressing every account as
    // `no_rule_matched`, which looks exactly like a cautious feature working.
    dimensions: asDimensions(r.dimensions),
    addonsHeld: r.addonsHeld ?? [],
    subscriptionAgeDays: r.subscriptionAgeDays ?? 0,
    complete: r.complete === true,
  }));
}

type LoadedDimension = { ratio: number | null; crossed: number | null; used: number; limit: number };

function asDimensions(value: unknown): Record<string, LoadedDimension> {
  const raw = value instanceof Map
    ? (Object.fromEntries(value) as Record<string, Partial<LoadedDimension>>)
    : ((value ?? {}) as Record<string, Partial<LoadedDimension>>);
  const out: Record<string, LoadedDimension> = {};
  for (const [k, d] of Object.entries(raw)) {
    out[k] = {
      ratio: d.ratio ?? null,
      crossed: d.crossed ?? null,
      used: d.used ?? 0,
      limit: d.limit ?? 0,
    };
  }
  return out;
}

/**
 * Turn a decision into the facts the copy needs — the limit and the price.
 *
 * The pressure comes from the SAME profile the decision was argued from rather
 * than from a fresh usage read, so the mail cannot name a figure the rule never
 * saw. Returns null when there is no priceable pack, which ends as a `no_copy`
 * outcome rather than an offer with nothing in it.
 */
export function emailFactsFor(input: {
  decision: CycleDecision;
  profiles: readonly RunProfile[];
  crossover: { candidateTier: string | null; savingCents: number };
  bundles: readonly PackLike[];
  tier: QuotaTier;
  interval: BillingInterval;
}): OfferEmailFacts | null {
  const chosen = input.decision.chosen;
  const latest = input.profiles[0];
  if (!chosen || !latest) return null;

  // Strongest first, so a single-dimension mail names the loudest one and a
  // basket mail lists them in the order the account would recognise.
  const pressure: PressurePoint[] = Object.entries(latest.dimensions)
    .filter(([, d]) => d.ratio !== null && d.ratio >= PRESSURE_RATIO && d.limit > 0)
    .sort((a, b) => (b[1].ratio ?? 0) - (a[1].ratio ?? 0))
    .map(([dimension, d]) => ({ dimension, used: d.used, limit: d.limit }));

  const base = {
    offerType: chosen.offerType,
    interval: input.interval,
    expiresAt: input.decision.expiresAt ?? null,
  };

  if (chosen.offerType === 'upgrade') {
    // The crossover mail carries no pack: its argument is the bill, and the
    // pressure line is context rather than the point (it may be empty).
    return {
      ...base,
      pressure,
      candidateTier: input.crossover.candidateTier,
      savingCents: input.crossover.savingCents,
    };
  }

  const first = pressure[0];
  if (!first) return null;
  const pack = packForDimension(first.dimension, input.bundles, input.tier, input.interval);
  if (!pack) return null;
  const grant = pack.grants?.[first.dimension] ?? 0;
  return {
    ...base,
    pressure,
    pack: {
      name: pack.name,
      priceCents: input.interval === 'annual' ? pack.prices.annual : pack.prices.monthly,
      grantDisplay: formatGrant(first.dimension, grant),
    },
  };
}

/** The grant in the unit a person reads — GB rather than bytes, as the card shows it. */
function formatGrant(dimension: string, grant: number): string {
  const unit = quotaPackUnit(dimension);
  if (!unit) return String(grant);
  const shown = grant / unit.per;
  return `${Number.isInteger(shown) ? shown : shown.toFixed(1)} ${unit.name}`;
}

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

/**
 * Built on FIRST START, not at module load.
 *
 * `offers.ts` imports `runForAccount` from this module to serve the operator
 * trigger, so a module-load-time `config.offers.cycleIntervalMs` made importing
 * one pure-ish function require the whole billing config to be assembled — which
 * is a coupling a route should not carry, and which broke the moment anything
 * imported the router with a partial config.
 */
let scheduler: Scheduler | null = null;

function offersScheduler(): Scheduler {
  scheduler ??= createScheduler({
    name: 'offers-cycle',
    intervalMs: config.offers.cycleIntervalMs,
    run: async () => {
      // Re-read BOTH switches every tick rather than capturing them at boot
      // (D6). A knob that only takes effect on redeploy is not a kill switch,
      // and this is the process that spends money.
      if (!config.enabled || !config.offersEnabled) {
        logger.debug('Offers disabled — skipping cycle');
        return;
      }
      await runWithTenantContext({ isSuperAdmin: true }, () => runOfferCycle());
    },
    // Leader-locked. Every replica runs the scheduler and only one may decide:
    // two replicas on the same slot both lose on the unique index, which is
    // correct but burns a profile read per account to discover it.
    lock: { key: leaderLockKey('billing', 'offers-cycle'), ttlMs: DEFAULT_LEADER_LOCK_TTL_MS },
  });
  return scheduler;
}

/** Start the decision cycle. Gated on BOTH switches; safe to call twice. */
export function startOffersCycle(): void {
  if (!config.enabled || !config.offersEnabled) {
    logger.info('Offers disabled — decision cycle not started', {
      billingEnabled: config.enabled, offersEnabled: config.offersEnabled,
    });
    return;
  }
  logger.info('Starting offers decision cycle', { intervalMs: config.offers.cycleIntervalMs });
  offersScheduler().start();
}

/** Stop it. A no-op when it was never started — the disabled deployment's case. */
export function stopOffersCycle(): void { scheduler?.stop(); }
