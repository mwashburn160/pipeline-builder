// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The seat-derived SIZE FLOOR on support.
 *
 * Support is priced per CONTACT, and that unit assumes contacts proxy for case
 * volume. At ten seats they do; at a hundred they do not — three named contacts
 * become an internal help desk FORWARDING tickets, so the per-contact price buys
 * the interface rather than the load. A 100-person org holding 3 contacts and 1
 * upgrade pays $159.96 a month and generates a 100-person org's case volume.
 *
 * Four of the tests below pin corrections to the FIRST DRAFT of this design,
 * each of which was a real defect caught in review rather than by a failing
 * test:
 *
 *  - a bare `max(contactsPrice, floor)` BILLS AN ORG THAT BOUGHT NO SUPPORT,
 *    because its contacts price is 0;
 *  - without carrying the volume percentage through, the ramp silently
 *    annihilates a discount the customer earned and can see on the invoice;
 *  - a hard threshold instead of a ramp is stepped over for free, because
 *    `seats` pools at the account ROOT;
 *  - an unlimited seat grant (`-1`) is an operator decision, not a measured
 *    size, so treating it as a number bills an unbounded floor.
 */

import { describe, it, expect } from '@jest/globals';
import { supportFloor, supportFloorConfig, supportFloorLine, type SupportFloorConfig, type SupportPosition } from '../src/helpers/support-floor.js';
import { priceBreakdown } from '../src/helpers/addon-catalog.js';
import { loadBillingConfig } from '../src/config/billing-config.js';

/** The shipped defaults, stated explicitly so a reprice has to come here. */
const CFG: SupportFloorConfig = {
  enabled: true,
  perSeatCents: 499,
  freeSeats: 15,
  weightPercent: { support_standard: 100, support_priority: 150, support_premium: 250 },
};

/** An account holding `contacts` standard contacts at list, monthly. */
const pos = (over: Partial<SupportPosition> = {}): SupportPosition => ({
  seats: 100,
  contacts: 3,
  premiumContacts: 0,
  level: 'support_standard',
  contactsPriceCents: 3 * 1999,
  volumePercent: 0,
  months: 1,
  ...over,
});

const floorOf = (over: Partial<SupportPosition> = {}, cfg = CFG) => supportFloor(pos(over), cfg);

describe('the ramp', () => {
  it('matches the published table', () => {
    // ceil((seats - 15) x $4.99) to the whole dollar, so the figure a customer
    // is quoted is one they can reproduce.
    const cases: [number, number][] = [
      [15, 0], [20, 2500], [25, 5000], [50, 17500],
      [100, 42500], [250, 117300], [500, 242100], [1000, 491600], [2500, 1240100],
    ];
    for (const [seats, expected] of cases) {
      expect(floorOf({ seats }).floorCents).toBe(expected);
    }
  });

  it('is CONTINUOUS at the free allowance, so no seat count makes the price jump', () => {
    // The cliff matters because `seats` pools at the account ROOT: a hard
    // threshold is avoided by splitting into a second account, which is
    // organisationally annoying and financially free. At exactly `freeSeats`
    // the floor is zero, and the seat after it is a dollar.
    expect(floorOf({ seats: 15 }).floorCents).toBe(0);
    expect(floorOf({ seats: 16 }).floorCents).toBe(500);
    expect(floorOf({ seats: 14 }).floorCents).toBe(0);
  });

  it('starts at the ENTERPRISE seat base, which is a purchase boundary', () => {
    // Seats beyond 15 can only exist if the account bought seat packs past the
    // top tier, so the floor only ever reaches orgs that already paid to grow.
    // Asserted against the config rather than the literal so a tier resize is a
    // single edit.
    expect(CFG.freeSeats).toBe(15);
    expect(supportFloorConfig().freeSeats).toBe(15);
  });

  it('rounds UP to the whole dollar', () => {
    // 85 x 499 = 42,415 cents -> $425.00, not $424.15.
    expect(floorOf({ seats: 100 }).floorCents).toBe(42500);
  });
});

describe('it never charges for support nobody bought', () => {
  it('is ZERO for an org with no contacts', () => {
    // THE correction. A bare max() bills a 100-seat org $425/mo for support it
    // never purchased; the floor is a minimum ON support, not a penalty for
    // declining it.
    const v = floorOf({ contacts: 0, contactsPriceCents: 0 });
    expect(v.floorCents).toBe(0);
    expect(v.chargeCents).toBe(0);
    expect(v.binds).toBe(false);
  });

  it('is ZERO when no baseline level is held', () => {
    expect(floorOf({ level: null, contactsPriceCents: 0 }).floorCents).toBe(0);
  });

  it('is ZERO for an UNLIMITED seat grant', () => {
    // `-1` is an operator decision, not a measured size. Treating it as a
    // number would bill an unbounded floor off a flag somebody set by hand.
    expect(floorOf({ seats: -1 }).floorCents).toBe(0);
  });

  it('is ZERO when the ramp is switched off, leaving the FIXED model', () => {
    const v = supportFloor(pos(), { ...CFG, enabled: false });
    expect(v.floorCents).toBe(0);
    expect(v.chargeCents).toBe(3 * 1999);
  });

  it('is ZERO at a per-seat rate of 0', () => {
    expect(supportFloor(pos(), { ...CFG, perSeatCents: 0 }).floorCents).toBe(0);
  });
});

describe('the volume discount carries through', () => {
  it('does not let the ramp annihilate a credit the customer earned', () => {
    // 20 standard contacts earn -30%: 20 x $19.99 x 0.7 = $279.86. Against a
    // raw $425 floor the invoice would show a volume credit netting to exactly
    // nothing — and volume breaks reward scale while the floor TARGETS scale,
    // so they collide precisely where both apply.
    const v = floorOf({ contacts: 20, contactsPriceCents: 27986, volumePercent: 30 });
    expect(v.floorCents).toBe(Math.round(42500 * 0.7)); // $297.50
    expect(v.binds).toBe(true);
    expect(v.chargeCents).toBe(29750);
    // Still binds, so the floor does its job — but the discount is honoured.
    expect(v.chargeCents).toBeGreaterThan(27986);
  });

  it('is unchanged at 0%', () => {
    expect(floorOf({ volumePercent: 0 }).floorCents).toBe(42500);
  });

  it('cannot be discounted below zero', () => {
    expect(floorOf({ volumePercent: 100 }).floorCents).toBe(0);
  });
});

describe('the level weight', () => {
  it('scales with the level held', () => {
    // $425.00 / $637.00 / $1,061.00 at 100 seats. Not exactly 1.5x and 2.5x of
    // the standard figure, because the round-up-to-dollar happens AFTER the
    // weight — which is the right order: the number a customer is quoted is the
    // one they can reproduce, and quoting a weighted-then-unrounded figure
    // would put cents back on an invoice line stated in dollars.
    expect(floorOf({ seats: 100, level: 'support_standard' }).floorCents).toBe(42500);
    expect(floorOf({ seats: 100, level: 'support_priority' }).floorCents).toBe(63700);
    expect(floorOf({ seats: 100, premiumContacts: 1 }).floorCents).toBe(106100);
  });

  it('treats ANY upgrade as a premium account', () => {
    // One upgrade is enough: the weight pays for the out-of-hours rota the
    // account can call on, and that rota exists whether one person or ten may
    // reach it.
    expect(floorOf({ premiumContacts: 1 }).weightPercent).toBe(250);
    expect(floorOf({ premiumContacts: 9 }).weightPercent).toBe(250);
    expect(floorOf({ premiumContacts: 0 }).weightPercent).toBe(100);
  });

  it('closes most of the cheap-24x7 gap', () => {
    // The cheapest route to 24x7 is one baseline contact plus one upgrade —
    // $119.98 at ANY size. Unweighted, a 25-seat org would pay that; weighted,
    // the floor overtakes it.
    const cheap = { contacts: 1, premiumContacts: 1, contactsPriceCents: 1999 + 9999 };
    const at25 = floorOf({ ...cheap, seats: 25 });
    expect(at25.binds).toBe(true);
    expect(at25.chargeCents).toBe(12500);
    // And a genuinely small org is still left alone.
    expect(floorOf({ ...cheap, seats: 20 }).binds).toBe(false);
  });

  it('falls back to 100% for an unrecognised level rather than skipping the floor', () => {
    const v = supportFloor(pos({ level: 'support_bespoke' }), CFG);
    expect(v.weightPercent).toBe(100);
    expect(v.floorCents).toBe(42500);
  });
});

describe('it binds only when it exceeds what was bought', () => {
  it('does not bind for an org buying plenty of contacts', () => {
    // 30 priority contacts at list is $1,499.70 against a $638 weighted floor.
    const v = floorOf({ contacts: 30, level: 'support_priority', contactsPriceCents: 30 * 4999 });
    expect(v.binds).toBe(false);
    expect(v.chargeCents).toBe(30 * 4999);
  });

  it('binds from 27 seats for a three-contact account', () => {
    // The algebra `(seats - 15) x 4.99 > 3 x 19.99` solves to `seats > 27`, but
    // the ROUNDING moves it one seat earlier: at 27 seats the raw floor is
    // $59.88, which rounds up to $60.00 and so just clears the $59.97 of
    // contacts. Worth pinning precisely, because it is the answer to "who does
    // this actually reach" — mid-size customers, not only the 100+ ones — and
    // because an off-by-one here is invisible except on somebody's invoice.
    expect(floorOf({ seats: 26 }).binds).toBe(false);
    expect(floorOf({ seats: 27 }).binds).toBe(true);
  });

  it('reports the billable seats so a preview can explain the number', () => {
    expect(floorOf({ seats: 100 }).billableSeats).toBe(85);
  });
});

describe('the annual interval', () => {
  it('gets the same two-months-free treatment as every other line', () => {
    // `months` is 10 for annual, not 12. At 12 the annual customer would lose
    // its discount on the floor portion alone, which is the sort of asymmetry
    // nobody can explain on a renewal call.
    const monthly = floorOf({ seats: 100, months: 1 }).floorCents;
    const annual = floorOf({ seats: 100, months: 10, contactsPriceCents: 3 * 19990 }).floorCents;
    expect(annual).toBe(monthly * 10);
  });

  it('still compares against the annual contacts price', () => {
    // 20 annual standard contacts at -30%: the floor must be compared like for
    // like, not against a monthly figure.
    const v = floorOf({ seats: 100, months: 10, contacts: 20, contactsPriceCents: 279860, volumePercent: 30 });
    expect(v.floorCents).toBe(Math.round(42500 * 10 * 0.7));
    expect(v.binds).toBe(true);
  });
});

describe('the floor as an invoice LINE', () => {
  // WHY A LINE AND NOT A SILENT MINIMUM. Applying `max(contacts, floor)` to the
  // support subtotal is less code and worse in the way that matters: it produces
  // an invoice whose arithmetic does not add up — a subtotal larger than the sum
  // of its own contact lines, with nothing explaining the difference. The floor
  // already surprises people (it binds from 27 seats), and the one thing that
  // makes a surprise charge defensible is that the invoice explains it.
  const { bundles, plans } = loadBillingConfig();
  const plan = (t: string) => {
    const p = plans.find((x) => x.tier === t);
    if (!p) throw new Error(`no plan for ${t}`);
    return p;
  };
  const line = (
    tier: 'team' | 'enterprise',
    addons: { bundleId: string; quantity: number }[],
    interval: 'monthly' | 'annual' = 'monthly',
  ) => supportFloorLine(tier, addons, bundles, interval, CFG);

  it('is the TOP-UP, not the whole floor', () => {
    // The contact lines are already on the invoice at their own amounts, so
    // charging the whole floor would double-bill the part they cover — and the
    // arithmetic on the page would stop adding up, which is the entire reason
    // this is a line.
    //
    // A `seat` pack grants ONE seat, so enterprise's base 15 plus 20 packs is
    // 35 seats: a $100 floor against $59.97 of contacts. 10 packs would be 25
    // seats and a $50 floor, which correctly does NOT bind — the bite point is
    // 27 seats for a three-contact account, and that is worth knowing when
    // reading these fixtures.
    const l = line('enterprise', [
      { bundleId: 'seat', quantity: 20 },
      { bundleId: 'support_standard', quantity: 3 },
    ]);
    expect(l).not.toBeNull();
    expect(l!.billableSeats).toBe(20);
    // Both sides carry the -10% volume break that 3 contacts earns, which is
    // gap 2's fix working end to end: contacts 3 x $19.99 x 0.9 = $53.97, floor
    // $100.00 x 0.9 = $90.00, so the top-up is $36.03. Without the discount
    // carried through to the FLOOR the customer would see a credit on the
    // contact lines that the floor silently cancelled.
    expect(l!.cents).toBe(9000 - 5397);
  });

  it('does NOT bind just below the bite point, which is 27 seats', () => {
    // 25 seats -> a $50 floor against $59.97 of contacts. Pinned because the
    // fixture above reads as though more seats were needed arbitrarily.
    expect(line('enterprise', [
      { bundleId: 'seat', quantity: 10 },
      { bundleId: 'support_standard', quantity: 3 },
    ])).toBeNull();
  });

  it('is ABSENT when the floor does not bind', () => {
    // A small account must see no line at all, not a zero one: a £0.00 row for
    // a mechanism nobody has heard of is its own support ticket.
    expect(line('team', [{ bundleId: 'support_standard', quantity: 3 }])).toBeNull();
  });

  it('is ABSENT for an org holding no support', () => {
    // The correction that mattered most: a bare max() bills an org that bought
    // nothing.
    expect(line('enterprise', [{ bundleId: 'seat', quantity: 20 }])).toBeNull();
  });

  it('reads the EFFECTIVE seat limit, so a seat pack moves it on the same call', () => {
    // The property that makes the preview able to say "this pack raises your
    // support floor" before the customer confirms. A stored snapshot would go
    // stale exactly when a pack is added — the case the floor exists to catch.
    const support = { bundleId: 'support_standard', quantity: 3 };
    const small = line('enterprise', [support]);
    const grown = line('enterprise', [support, { bundleId: 'seat', quantity: 20 }]);
    expect(small).toBeNull();
    expect(grown).not.toBeNull();
    expect(grown!.billableSeats).toBeGreaterThan(0);
  });

  it('names the seats it billed, so the charge is reconcilable', () => {
    const l = line('enterprise', [
      { bundleId: 'support_standard', quantity: 3 },
      { bundleId: 'seat', quantity: 20 },
    ]);
    expect(l!.label).toMatch(/Support size floor/);
    expect(l!.label).toMatch(new RegExp(`${l!.billableSeats} seats`));
    expect(l!.label).toMatch(/included 15/);
  });

  it('appears in priceBreakdown ONLY when a tier is supplied', () => {
    // `tier` is optional so existing callers keep working, and a caller with no
    // account context correctly gets no floor rather than a guessed one.
    const addons = [
      { bundleId: 'support_standard', quantity: 3 },
      { bundleId: 'seat', quantity: 20 },
    ] as never;
    const without = priceBreakdown(plan('enterprise'), addons, bundles, 'monthly');
    const withTier = priceBreakdown(plan('enterprise'), addons, bundles, 'monthly', 'enterprise');
    expect(without.items.some((i) => /size floor/.test(i.label))).toBe(false);
    expect(withTier.items.some((i) => /size floor/.test(i.label))).toBe(true);
    // And it is POSITIVE — the mirror image of the discount lines above it.
    const floorItem = withTier.items.find((i) => /size floor/.test(i.label))!;
    expect(floorItem.cents).toBeGreaterThan(0);
    expect(withTier.totalCents).toBeGreaterThan(without.totalCents);
  });

  it('keeps the breakdown ADDING UP', () => {
    // The property the silent-minimum alternative would have broken.
    const b = priceBreakdown(
      plan('enterprise'),
      [{ bundleId: 'support_standard', quantity: 3 }, { bundleId: 'seat', quantity: 20 }] as never,
      bundles,
      'monthly',
      'enterprise',
    );
    expect(b.totalCents).toBe(b.items.reduce((s, i) => s + i.cents, 0));
  });
});

describe('a NEGOTIATED floor replaces the ramp', () => {
  // Above a few hundred seats every deal is negotiated, and a formula insisting
  // on $12,225 when sales agreed $8,000 is worse than no formula. So the list
  // holds and the discount becomes something a person signed for.
  const agreed = (seats: number, floorCents: number) => ({ seats, floorCents });

  it('uses the agreed price instead of the computed ramp', async () => {
    const v = supportFloor(pos({ seats: 2500, override: agreed(2500, 800000) }), CFG);
    expect(v.negotiated).toBe(true);
    expect(v.floorCents).toBe(800000);
    // The ramp would have been $12,225.50 -> $12,226 at 2500 seats.
    expect(v.floorCents).toBeLessThan(1222600);
  });

  it('still carries the volume discount through', async () => {
    // Same reason as the ramp: a credit the customer earned and can see on the
    // invoice must not be silently cancelled by the floor.
    const v = supportFloor(pos({ seats: 2500, volumePercent: 30, override: agreed(2500, 800000) }), CFG);
    expect(v.floorCents).toBe(Math.round(800000 * 0.7));
  });

  it('still respects the ANNUAL interval', async () => {
    const v = supportFloor(pos({ seats: 2500, months: 10, contactsPriceCents: 0, contacts: 3, override: agreed(2500, 800000) }), CFG);
    expect(v.floorCents).toBe(800000 * 10);
  });

  it('does NOT resurrect a floor for an org holding no support', async () => {
    // An agreement is a replacement for the computed number, never a reason to
    // bill an account that bought nothing.
    const v = supportFloor(pos({ seats: 2500, contacts: 0, level: null, contactsPriceCents: 0, override: agreed(2500, 800000) }), CFG);
    expect(v.floorCents).toBe(0);
    expect(v.negotiated).toBe(false);
  });

  it('does not bind when the contacts already cost more', async () => {
    const v = supportFloor(pos({ seats: 2500, contactsPriceCents: 900000, override: agreed(2500, 800000) }), CFG);
    expect(v.binds).toBe(false);
    expect(v.chargeCents).toBe(900000);
  });

  it('FLAGS a grown account as stale, while still honouring the deal', async () => {
    // THE point of storing the agreed seat count. A "2,500 at $8k" agreement
    // that keeps applying at 10,000 reintroduces the under-billing the floor
    // exists to prevent, through its own exception. Honoured but reported:
    // unilaterally re-pricing a signed deal because a customer hired people is
    // not something to do silently either.
    const grown = supportFloor(pos({ seats: 10000, override: agreed(2500, 800000) }), CFG);
    expect(grown.overrideStale).toBe(true);
    expect(grown.floorCents).toBe(800000);

    const same = supportFloor(pos({ seats: 2500, override: agreed(2500, 800000) }), CFG);
    expect(same.overrideStale).toBe(false);
    // Shrinking is not stale either — they are paying for more than they have.
    const shrunk = supportFloor(pos({ seats: 500, override: agreed(2500, 800000) }), CFG);
    expect(shrunk.overrideStale).toBe(false);
  });

  it('gets its OWN invoice label, because the ramp wording would be a lie', async () => {
    // "85 seats over the included 15" is simply untrue of an agreed price, and a
    // line that explains itself with the wrong reason is worse than one that
    // just names the charge.
    const { bundles } = loadBillingConfig();
    const line = supportFloorLine(
      'enterprise',
      [{ bundleId: 'support_standard', quantity: 3 }, { bundleId: 'seat', quantity: 20 }],
      bundles,
      'monthly',
      CFG,
      agreed(35, 50000),
    );
    expect(line).not.toBeNull();
    expect(line!.negotiated).toBe(true);
    expect(line!.label).toBe('Support size floor (agreed)');
    expect(line!.label).not.toMatch(/seats over/);
  });
});
