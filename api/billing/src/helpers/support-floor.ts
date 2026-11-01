// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The SIZE FLOOR on support — a minimum monthly charge derived from seat count.
 *
 * WHY IT EXISTS. Support is priced per CONTACT, and that unit assumes contacts
 * proxy for case volume. At ten seats they do; at a hundred they do not — three
 * named contacts become an internal help desk FORWARDING tickets, so the
 * per-contact price buys the interface rather than the load. A 100-person
 * organisation holding 3 contacts and 1 premium upgrade pays $159.96 a month and
 * generates a 100-person organisation's case volume.
 *
 * WHY A RAMP AND NOT A BAND. `max(0, seats - freeSeats) x perSeat`, so at
 * exactly `freeSeats` the floor is zero and there is no seat count at which the
 * price jumps. A hard threshold would be stepped over for free: `seats` pools at
 * the account ROOT, so a cliff is avoided by splitting into a second account,
 * which is organisationally annoying and financially free.
 *
 * WHY THE FREE ALLOWANCE IS THE ENTERPRISE SEAT BASE. Seats beyond it can only
 * exist if the account bought seat packs past the top tier, which is a far
 * better size signal than an arbitrary number — the floor only ever reaches
 * organisations that have already paid to grow.
 *
 * THE TWO QUALIFICATIONS ON THE FORMULA ARE NOT DECORATION. Each was a real
 * defect in the first draft of this design:
 *
 *  - Gated on holding support AT ALL. A bare `max(contactsPrice, floor)` bills
 *    an org with no support contacts — `contactsPrice` is 0 — a floor for
 *    support it never purchased. The floor is a minimum ON support, never a
 *    penalty for declining it.
 *  - The volume discount carries through to the floor. Otherwise the ramp
 *    silently annihilates it: 20 standard contacts earn -30%
 *    (`20 x $19.99 x 0.7 = $279.86`), the $425 floor binds, and the invoice
 *    shows a volume credit that nets to exactly nothing. Volume breaks reward
 *    scale and the floor TARGETS scale, so they collide precisely where both
 *    apply — and a credit shown but not realised is a billing dispute.
 *
 * WHY IT IS COMPUTED HERE AND NOT STORED. It must read the EFFECTIVE seat limit
 * (tier base + seat packs) at pricing time. A stored snapshot goes stale exactly
 * when a seat pack is added, which is the case the floor exists to catch;
 * reading `effectiveEntitlements(...).seats` means buying a pack moves the floor
 * on the same recalculation, in both directions, with no separate trigger.
 */

import { envBool, envInt, type QuotaTier } from '@pipeline-builder/api-core';
import { effectiveEntitlements } from '../config/entitlements.js';
import { priceForInterval, volumeDiscountPct } from './combo-pricing.js';
import type { BundleConfig } from '../config/billing-types.js';

/** The two BASELINE levels, best first — the floor's weight follows the one held. */
const BASELINE_LEVELS: readonly string[] = ['support_priority', 'support_standard'];
/** The upgrade, named once. */
const PREMIUM_LEVEL = 'support_premium';
/**
 * Months an annual interval is priced at — TEN, not twelve.
 *
 * The floor gets the same two-months-free treatment as every other line. At
 * twelve an annual customer would lose its discount on the floor portion alone,
 * which is the sort of asymmetry nobody can explain on a renewal call.
 */
const ANNUAL_MONTHS = 10;

/** A level's multiplier on the floor, keyed by its bundle id. */
export type FloorWeights = Readonly<Record<string, number>>;

/** Resolved floor configuration. */
export interface SupportFloorConfig {
  /** False leaves support priced purely per contact (the "fixed" model). */
  enabled: boolean;
  /** Cents per billable seat per month. */
  perSeatCents: number;
  /** Seats excluded before the ramp starts. */
  freeSeats: number;
  /**
   * Per-level multiplier, in PERCENT, so the knob stays an integer.
   *
   * The floor otherwise ignores which level is held: a 100-seat standard
   * customer and a 100-seat premium customer face the same number despite very
   * different cost to serve — and it BINDS for both, since 3 contacts plus an
   * upgrade is only $159.96, so premium could be held at 100 seats for the
   * standard floor. Weighting also closes most of the small-org gap: the
   * cheapest route to 24x7 is one baseline contact plus one upgrade ($119.98 at
   * any size), and at 25 seats the premium-weighted floor overtakes it.
   */
  weightPercent: FloorWeights;
}

/** The levels, with the weight each applies to the floor. */
const DEFAULT_WEIGHT_PERCENT: FloorWeights = {
  support_standard: 100,
  support_priority: 150,
  support_premium: 250,
};

/** Read the floor configuration from the environment. */
export function supportFloorConfig(): SupportFloorConfig {
  return {
    enabled: envBool('BILLING_SUPPORT_FLOOR_ENABLED', true),
    perSeatCents: envInt('BILLING_SUPPORT_FLOOR_PER_SEAT_CENTS', 499, { min: 0 }),
    // Defaults to enterprise's own seat base — see the module comment.
    freeSeats: envInt('BILLING_SUPPORT_FLOOR_FREE_SEATS', 15, { min: 0 }),
    weightPercent: {
      support_standard: envInt('BILLING_SUPPORT_FLOOR_WEIGHT_STANDARD', DEFAULT_WEIGHT_PERCENT.support_standard!, { min: 0 }),
      support_priority: envInt('BILLING_SUPPORT_FLOOR_WEIGHT_PRIORITY', DEFAULT_WEIGHT_PERCENT.support_priority!, { min: 0 }),
      support_premium: envInt('BILLING_SUPPORT_FLOOR_WEIGHT_PREMIUM', DEFAULT_WEIGHT_PERCENT.support_premium!, { min: 0 }),
    },
  };
}

/**
 * A negotiated floor that replaces the computed ramp.
 *
 * `seats` is the count it was agreed AT. Comparing it against the account's
 * CURRENT seats is what makes a grown account's stale agreement visible instead
 * of silently under-billing — the exact failure the floor exists to prevent,
 * reintroduced through its own exception.
 */
export interface SupportFloorOverride {
  seats: number;
  floorCents: number;
}

/** What the floor needs to know about an account's support position. */
export interface SupportPosition {
  /** EFFECTIVE seat limit (tier base + packs). `-1` = unlimited. */
  seats: number;
  /** Baseline contacts held. Zero means no support, and no floor. */
  contacts: number;
  /** Contacts upgraded to premium. */
  premiumContacts: number;
  /** The baseline level held, or null. */
  level: string | null;
  /** What the per-contact lines come to for the interval, AFTER volume credits. */
  contactsPriceCents: number;
  /** The volume discount already applied to `contactsPriceCents`, in percent. */
  volumePercent: number;
  /** Months the interval covers — 1 monthly, 10 annual (two months free). */
  months: number;
  /** A sysadmin-agreed floor replacing the ramp, when one is on file. */
  override?: SupportFloorOverride | undefined;
}

/** The floor verdict, with the parts shown so a preview can explain it. */
export interface SupportFloorVerdict {
  /** The floor for the interval, after weighting and volume. 0 = none. */
  floorCents: number;
  /** True when the floor exceeds what the contacts came to. */
  binds: boolean;
  /** What is actually charged for support this interval. */
  chargeCents: number;
  /** Seats the ramp billed (post free allowance), for the explanation. */
  billableSeats: number;
  /** The weight applied, in percent. 0 when a negotiated floor replaced it. */
  weightPercent: number;
  /** True when a negotiated floor was used instead of the computed ramp. */
  negotiated: boolean;
  /**
   * True when a negotiated floor is on file but the account has OUTGROWN the
   * seat count it was agreed at.
   *
   * The agreement is still honoured — unilaterally re-pricing a signed deal
   * because a customer hired people is not something to do silently either —
   * but it is reported so somebody renegotiates rather than discovering it at
   * renewal.
   */
  overrideStale: boolean;
}

/** Round a cent amount UP to a whole dollar. */
const ceilDollars = (cents: number): number => Math.ceil(cents / 100) * 100;

/**
 * The support charge for an interval: per-contact price, or the size floor,
 * whichever is greater.
 *
 * Returns no floor at all when support is not held, when the ramp is disabled,
 * or when seats are within the free allowance — the three cases where a floor
 * would be a charge for nothing.
 *
 * `seats: -1` (unlimited) yields no floor: an unlimited seat grant is an
 * operator decision rather than a measured size, so there is no number to ramp
 * from. Treating it as infinite would bill an unbounded floor.
 */
export function supportFloor(
  pos: SupportPosition,
  cfg: SupportFloorConfig = supportFloorConfig(),
): SupportFloorVerdict {
  const none = (): SupportFloorVerdict => ({
    floorCents: 0,
    binds: false,
    chargeCents: pos.contactsPriceCents,
    billableSeats: 0,
    weightPercent: 0,
    negotiated: false,
    overrideStale: false,
  });

  // No support held -> no floor. THE correction: a bare max() would bill an org
  // that bought nothing.
  if (pos.contacts <= 0 || pos.level === null) return none();
  if (!cfg.enabled || cfg.perSeatCents <= 0) return none();
  if (pos.seats < 0) return none();

  /*
   * A NEGOTIATED floor short-circuits the ramp entirely.
   *
   * Checked after the "holds support at all" gates above and before the ramp,
   * because an agreement is a replacement for the computed number rather than a
   * cap on it — and because an override must not resurrect a floor for an
   * account that bought no support.
   *
   * The volume percent still carries through, for the same reason it does on the
   * ramp: a credit the customer earned and can see on the invoice must not be
   * silently cancelled by the floor.
   */
  if (pos.override) {
    const interval = pos.override.floorCents * pos.months;
    const floorCents = Math.round(interval * (100 - pos.volumePercent) / 100);
    const binds = floorCents > pos.contactsPriceCents;
    return {
      floorCents,
      binds,
      chargeCents: binds ? floorCents : pos.contactsPriceCents,
      billableSeats: Math.max(0, pos.seats - cfg.freeSeats),
      weightPercent: 0,
      negotiated: true,
      // Honoured but flagged: the account has outgrown what was signed for.
      overrideStale: pos.seats > pos.override.seats,
    };
  }

  const billableSeats = Math.max(0, pos.seats - cfg.freeSeats);
  if (billableSeats === 0) return none();

  // The level that sets the weight is the HIGHEST held: an account with any
  // premium upgrade is a premium account for floor purposes, because the
  // out-of-hours rota it can call on is what the weight is paying for.
  const level = pos.premiumContacts > 0 ? 'support_premium' : pos.level;
  const weightPercent = cfg.weightPercent[level] ?? 100;

  // Monthly, rounded UP to a whole dollar before the interval multiplier, so the
  // published monthly figure is the one a customer can reproduce.
  const monthly = ceilDollars(billableSeats * cfg.perSeatCents * weightPercent / 100);
  // `months` is 10 for annual, not 12 -- the floor gets the same two-months-free
  // treatment as every other line, so annual never costs more per month on the
  // floor than monthly does.
  const interval = monthly * pos.months;
  // The volume discount carries through, or the ramp would quietly cancel a
  // credit the customer earned and can see on the invoice.
  const floorCents = Math.round(interval * (100 - pos.volumePercent) / 100);

  const binds = floorCents > pos.contactsPriceCents;
  return {
    floorCents,
    binds,
    chargeCents: binds ? floorCents : pos.contactsPriceCents,
    billableSeats,
    weightPercent,
    negotiated: false,
    overrideStale: false,
  };
}

/**
 * The support floor as an INVOICE LINE, or null when none applies.
 *
 * WHY A LINE AND NOT A SILENT MINIMUM. The alternative was applying
 * `max(contacts, floor)` to the support subtotal, which is less code and worse
 * in the one way that matters: it produces an invoice whose arithmetic does not
 * add up — a support subtotal larger than the sum of its own contact lines, with
 * nothing on the page explaining the difference. The floor is already going to
 * surprise people (it binds from 27 seats), and the single thing that makes a
 * surprise charge defensible is that the invoice explains it. A visible
 * adjustment line is auditable, reconcilable against the seat count, and
 * answers the support ticket before it is filed.
 *
 * It is the mirror image of the volume and combo lines, which are NEGATIVE
 * adjustments assembled the same way in `priceBreakdown`, so it needs no second
 * mechanism to carry it.
 *
 * READS THE EFFECTIVE SEAT LIMIT, never a stored one. `effectiveEntitlements`
 * recomputes tier base + seat packs, so buying a pack moves the floor on the
 * same recalculation — in both directions — with no separate trigger. A stored
 * snapshot would go stale exactly when a pack is added, which is the case the
 * floor exists to catch.
 */
export function supportFloorLine(
  tier: QuotaTier,
  addons: ReadonlyArray<{ bundleId: string; quantity: number }>,
  bundles: readonly BundleConfig[],
  interval: 'monthly' | 'annual',
  cfg: SupportFloorConfig = supportFloorConfig(),
  override?: SupportFloorOverride | undefined,
): { label: string; cents: number; billableSeats: number; negotiated: boolean; stale: boolean } | null {
  const { limits, features } = effectiveEntitlements(tier, addons, bundles);
  const contacts = limits.supportContacts ?? 0;
  // An unlimited CONTACT grant is an operator decision, like unlimited seats,
  // and there is no quantity to price a floor against.
  if (contacts <= 0) return null;

  const level = BASELINE_LEVELS.find((f) => features.includes(f)) ?? null;
  if (level === null) return null;

  const baseline = bundles.find((b) => b.id === level);
  const held = addons.find((a) => a.bundleId === level)?.quantity ?? 0;
  const premiumHeld = addons.find((a) => a.bundleId === PREMIUM_LEVEL && a.quantity > 0)?.quantity ?? 0;

  // What the support LINES come to, after their volume discount — the figure the
  // floor has to beat. Derived from the same inputs `priceBreakdown` uses rather
  // than passed in, so the two cannot disagree about what support costs.
  const volumePercent = baseline ? volumeDiscountPct(baseline, held) : 0;
  const unit = baseline ? priceForInterval(baseline.prices, interval) : 0;
  const premiumBundle = bundles.find((b) => b.id === PREMIUM_LEVEL);
  const premiumUnit = premiumBundle ? priceForInterval(premiumBundle.prices, interval) : 0;
  const premiumPercent = premiumBundle ? volumeDiscountPct(premiumBundle, premiumHeld) : 0;
  const contactsPriceCents = Math.round(unit * held * (100 - volumePercent) / 100)
    + Math.round(premiumUnit * premiumHeld * (100 - premiumPercent) / 100);

  const verdict = supportFloor({
    seats: limits.seats ?? 0,
    contacts,
    premiumContacts: premiumHeld,
    level,
    contactsPriceCents,
    // The BASELINE's percent: the floor's own weighting already accounts for a
    // premium account, and applying premium's shallower curve to a figure driven
    // by the baseline count would understate the discount the customer earned.
    volumePercent,
    months: interval === 'annual' ? ANNUAL_MONTHS : 1,
    override,
  }, cfg);

  if (!verdict.binds) return null;
  // The TOP-UP, not the floor itself: the contact lines are already on the
  // invoice at their own amounts, so charging the whole floor would double-bill
  // the part they cover. `binds` guarantees this is positive.
  //
  // A negotiated floor gets its OWN label. "85 seats over the included 15" is
  // simply untrue of an agreed price, and an invoice line that explains itself
  // with the wrong reason is worse than one that just names the charge.
  return {
    label: verdict.negotiated
      ? 'Support size floor (agreed)'
      : `Support size floor (${verdict.billableSeats} seats over the included ${cfg.freeSeats})`,
    cents: verdict.floorCents - contactsPriceCents,
    billableSeats: verdict.billableSeats,
    negotiated: verdict.negotiated,
    stale: verdict.overrideStale,
  };
}
