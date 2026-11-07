// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The capacity arithmetic, as scenarios — because every incident on this queue
 * came from a number nobody had multiplied out.
 *
 * Three constraints bind a build, and the LOWEST wins:
 *   1. the tier's worker concurrency x the replica count  (fleet capacity)
 *   2. the org's slot cap                                 (tenant fairness)
 *   3. the replica's build budget                         (one buildkitd sidecar)
 *
 * The figures everyone reasoned with were the single-tier case. "8 replicas x 4 =
 * 32" is only true when every job is on one tier (a catalogue load is all
 * system-org); a mixed fleet runs the SUM of the ladder per replica. And for a
 * single org uploading in bulk, neither of those is the binding number — its own
 * cap is.
 *
 * These are pinned so the conclusions cannot drift silently with a config edit.
 */

import { describe, it, expect } from '@jest/globals';
import { BUILD_TIER_CONCURRENCY, BUILD_TIER_LADDER, BUILD_LADDER_CONCURRENCY_SUM } from '@pipeline-builder/api-core';

/** The shipped per-org standard-class caps: max(class baseline 5, the tier row). */
const ORG_CAP_STANDARD: Record<string, number> = {
  developer: 5, pro: 5, team: 5, business: 5, enterprise: 8, unlimited: 8,
};
/** The system org uses its own figure (PLUGIN_SYSTEM_ORG_MAX_BUILDS). */
const SYSTEM_ORG_CAP = 12;

const running = (tier: string, replicas: number, cap: number) =>
  Math.min(replicas * BUILD_TIER_CONCURRENCY[tier as keyof typeof BUILD_TIER_CONCURRENCY], cap);

describe('one org uploading 100 plugins', () => {
  it.each([
    // tier,        replicas, expected concurrent, what binds
    ['developer', 4, 4, 'fleet'],
    ['developer', 8, 5, 'org cap'],
    ['enterprise', 4, 8, 'org cap'],
    ['enterprise', 16, 8, 'org cap'],
    ['business', 16, 5, 'org cap'],
  ])('%s at %i replicas runs %i at once (%s binds)', (tier, replicas, expected) => {
    expect(running(tier as string, replicas as number, ORG_CAP_STANDARD[tier as string]!)).toBe(expected);
  });

  it('is paced by the ORG CAP, so replicas past the knee buy nothing', () => {
    // 5 replicas and 16 give the same answer on every paid tier: the caps bind.
    // This is why the autoscaler asking for 300 replicas on a 600-job backlog was
    // pure cost — it cannot convert pods into throughput here.
    for (const tier of BUILD_TIER_LADDER.filter((t) => t !== 'unlimited')) {
      const cap = ORG_CAP_STANDARD[tier]!;
      expect(running(tier, 5, cap)).toBe(running(tier, 16, cap));
    }
  });

  it('gives the system org MORE headroom than any tenant tier, which is the point', () => {
    // A catalogue load is platform work: 12 against a tenant's 5-8, and its wait
    // never turns terminal. Both halves were needed — a cap of 3 plus a terminal
    // wait failed 80 of 119 plugins; no cap at all OOMKilled the registry.
    expect(SYSTEM_ORG_CAP).toBeGreaterThan(Math.max(...Object.values(ORG_CAP_STANDARD)));
  });
});

describe('100 plugins per tier, all six queues busy', () => {
  it('runs the SUM of the ladder per replica, not one tier row', () => {
    // The mixed-fleet ceiling. A replica starts one Worker per tier queue, so the
    // single-tier arithmetic understates it by ~3x.
    expect(BUILD_LADDER_CONCURRENCY_SUM).toBe(13);
    expect(BUILD_LADDER_CONCURRENCY_SUM).toBeGreaterThan(Math.max(...Object.values(BUILD_TIER_CONCURRENCY)));
  });

  it.each([[4, 52], [8, 104], [16, 208]])(
    '%i replicas offer %i worker slots fleet-wide',
    (replicas, slots) => {
      expect((replicas as number) * BUILD_LADDER_CONCURRENCY_SUM).toBe(slots);
    },
  );

  it('admits far fewer than it offers, which is where the waste was', () => {
    // One org per tier: 4 replicas offer 52 slots and admit 31; 16 offer 208 and
    // admit 40. The surplus slots spend their time DENYING work, which is what the
    // bounded autoscaling signal and the retry backoff exist to limit.
    const admitted = (replicas: number) => BUILD_TIER_LADDER
      .reduce((n, t) => n + running(t, replicas, t === 'unlimited' ? SYSTEM_ORG_CAP : ORG_CAP_STANDARD[t]!), 0);
    expect(admitted(4)).toBe(31);
    expect(admitted(16)).toBe(40);
    expect(16 * BUILD_LADDER_CONCURRENCY_SUM - admitted(16)).toBe(168);
  });
});

describe('a FIRST RUN: the setup catalogue load', () => {
  // Every build in a catalogue load belongs to the system org, so they all land
  // on ONE tier queue (`unlimited`, concurrency 1). That makes the install the
  // most single-tier workload the platform ever runs, and the case most easily
  // broken by reasoning about the ladder's sum.
  const CATALOGUE = 119;
  const SYS_CONC = BUILD_TIER_CONCURRENCY.unlimited;

  it('runs one catalogue build per replica, not the ladder sum', () => {
    // The arithmetic a scaling threshold has to respect: a replica absorbs ONE
    // job of this workload, not 13. Treating 13 as "jobs per replica" stopped
    // the fleet growing at 5 while the system org's cap of 12 had headroom —
    // 71 minutes instead of 45 for this catalogue.
    expect(SYS_CONC).toBe(1);
    expect(SYS_CONC).toBeLessThan(BUILD_LADDER_CONCURRENCY_SUM);
  });

  it('is bound by the FLEET, not the system org cap, at the shipped ceiling', () => {
    // 8 replicas x 1 = 8 concurrent, under a cap of 12. That ordering matters:
    // it means replicas convert directly into install speed here (unlike every
    // paid tier, where the cap binds first), so the replica ceiling is the knob
    // that decides how long a fresh install takes.
    const FLEET_CEILING = 8;
    expect(FLEET_CEILING * SYS_CONC).toBeLessThan(SYSTEM_ORG_CAP);
  });

  it('never fails a catalogue build for WAITING, however long the queue is', () => {
    // 119 builds at 8 concurrent is ~45 minutes, well past the 30-minute slot
    // budget. The system org is exempt from that deadline turning terminal —
    // without it, 80 of 119 plugins failed for being merely late.
    const drainMinutes = Math.ceil(CATALOGUE / (8 * SYS_CONC)) * 3;
    expect(drainMinutes).toBeGreaterThan(30);
  });

  it('would need 12 replicas to use the system org cap fully', () => {
    // The point of diminishing returns for an install, and the only tier that
    // can use more than 5: ceil(cap / concurrency).
    expect(Math.ceil(SYSTEM_ORG_CAP / SYS_CONC)).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Borrowing idle slots (PLUGIN_BUILD_BORROW_MAX)
// ---------------------------------------------------------------------------

/**
 * With borrowing, ONE tier's per-replica ceiling is its floor plus the whole
 * allowance — correct only while that tier is the only one over its floor,
 * which is the single-tier case below. For mixed load use {@link fleetCeiling}:
 * the allowance is a SHARED pool per replica, not one pool per tier.
 */
const runningWithBorrow = (tier: string, replicas: number, cap: number, borrow: number) => Math.min(
  replicas * (BUILD_TIER_CONCURRENCY[tier as keyof typeof BUILD_TIER_CONCURRENCY] + borrow),
  cap,
  replicas * BUILD_LADDER_CONCURRENCY_SUM,
);

/** Orgs of each tier uploading at once. */
type Demand = Partial<Record<string, number>>;

/**
 * Concurrent builds across the fleet for a mix of tiers, as the LOWEST of the
 * three bounds that actually apply:
 *
 *  1. per tier: its own ceiling x replicas, cut by the sum of its orgs' caps;
 *  2. the SHARED allowance: every active tier's floor, plus `borrow` ONCE per
 *     replica — not once per tier. `borrowedSlots()` in build-gate sums over
 *     every tier, so two busy tiers compete for the same pool;
 *  3. the replica budget, because all tier workers share one buildkitd sidecar.
 *
 * Bound 2 is the one a per-tier reading of borrowing gets wrong, and it is the
 * difference between 72 and 56 concurrent builds on a mixed pro+business fleet.
 */
function fleetCeiling(demand: Demand, replicas: number, borrow = 0): number {
  const tiers = Object.keys(demand).filter((t) => (demand[t] ?? 0) > 0);
  const floor = (t: string) => BUILD_TIER_CONCURRENCY[t as keyof typeof BUILD_TIER_CONCURRENCY];
  const perTier = tiers.reduce((n, t) => n + Math.min(
    ORG_CAP_STANDARD[t] * (demand[t] ?? 0),
    (floor(t) + borrow) * replicas,
  ), 0);
  const sharedPool = tiers.reduce((n, t) => n + floor(t) * replicas, 0) + borrow * replicas;
  return Math.min(perTier, sharedPool, replicas * BUILD_LADDER_CONCURRENCY_SUM);
}

describe('borrowing: 120 plugin configs on the unlimited tier', () => {
  it('changes NOTHING for a tenant org on a full eks fleet — its cap already binds', () => {
    // The answer that is easy to get wrong by assuming more capacity always
    // helps. `unlimited`'s org cap is 8, and 1 x 8 replicas is already 8, so the
    // ceiling borrowing lifts is not the one that binds.
    expect(running('unlimited', 8, ORG_CAP_STANDARD.unlimited)).toBe(8);
    expect(runningWithBorrow('unlimited', 8, ORG_CAP_STANDARD.unlimited, 2)).toBe(8);
  });

  it('is where the SYSTEM org differs: its cap is 12, so there is headroom', () => {
    // The catalogue load. 1 x 8 = 8 today, and the cap above it at 12 — which is
    // exactly the room borrowing converts into throughput.
    expect(running('unlimited', 8, SYSTEM_ORG_CAP)).toBe(8);
    expect(runningWithBorrow('unlimited', 8, SYSTEM_ORG_CAP, 2)).toBe(12);
  });

  it('pays off most on the small fleets, where replicas cap at 2', () => {
    // ec2 and minikube: maxReplicaCount 2. Borrowing triples it.
    expect(running('unlimited', 2, SYSTEM_ORG_CAP)).toBe(2);
    expect(runningWithBorrow('unlimited', 2, SYSTEM_ORG_CAP, 2)).toBe(6);
  });

  it('gives a FRESH install parallelism before KEDA has scaled out', () => {
    // minReplicaCount is 1, so the first stretch of a first-run catalogue load
    // runs ONE build with twelve slots idle on that replica.
    expect(running('unlimited', 1, SYSTEM_ORG_CAP)).toBe(1);
    expect(runningWithBorrow('unlimited', 1, SYSTEM_ORG_CAP, 11)).toBe(12);
  });

  it('never breaches the replica budget, whatever the allowance is set to', () => {
    // The bound that exists because all tier workers share one buildkitd
    // sidecar. An absurd allowance must still not put 40 builds on a replica.
    expect(runningWithBorrow('unlimited', 1, SYSTEM_ORG_CAP, 40)).toBeLessThanOrEqual(BUILD_LADDER_CONCURRENCY_SUM);
  });

  it('leaves the shipped default a no-op for every tier', () => {
    // borrow 0 must reproduce the pre-borrowing figure exactly, or this shipped
    // a behaviour change rather than an opt-in.
    for (const tier of BUILD_TIER_LADDER) {
      for (const replicas of [1, 2, 4, 8]) {
        const cap = ORG_CAP_STANDARD[tier];
        expect({ tier, replicas, n: runningWithBorrow(tier, replicas, cap, 0) })
          .toEqual({ tier, replicas, n: running(tier, replicas, cap) });
      }
    }
  });
});

describe('many orgs on ONE tier: 10 configs each from pro', () => {
  // pro's floor is 2 a replica and its org cap is 5, so which one binds depends
  // on how many orgs are uploading — and that decides whether borrowing helps.
  it.each([
    // orgs, eks(8) today, eks(8) at borrow 2, what binds today
    [1, 5, 5, 'org cap'],
    [3, 15, 15, 'org caps'],
    [4, 16, 20, 'tier ceiling'],
    [10, 16, 32, 'tier ceiling'],
  ])('%i pro org(s): %i today, %i with borrow 2 (%s)', (orgs, today, borrowed) => {
    expect(fleetCeiling({ pro: orgs }, 8)).toBe(today);
    expect(fleetCeiling({ pro: orgs }, 8, 2)).toBe(borrowed);
  });

  it('crosses over from org-capped to tier-capped at four orgs', () => {
    // Below the crossover, extra capacity cannot be used by anyone: every org
    // is already holding its five. This is why "add replicas" did not help.
    expect(fleetCeiling({ pro: 3 }, 8)).toBe(fleetCeiling({ pro: 3 }, 80));
    expect(fleetCeiling({ pro: 4 }, 8)).toBeLessThan(fleetCeiling({ pro: 4 }, 80));
  });

  it('is tier-bound on the small targets whatever the org count', () => {
    // ec2 and minikube cap at 2 replicas: 2 x 2 = 4, and borrowing doubles it.
    for (const orgs of [2, 5, 20]) {
      expect(fleetCeiling({ pro: orgs }, 2)).toBe(4);
      expect(fleetCeiling({ pro: orgs }, 2, 2)).toBe(8);
    }
  });
});

describe('mixed tiers: pro AND business uploading 8 configs each', () => {
  it('ADDS capacity rather than dividing it — separate queues, separate workers', () => {
    // The property per-tier partitioning buys: business brings its own 3 a
    // replica, so a pro burst and a business burst do not compete.
    const proAlone = fleetCeiling({ pro: 10 }, 8);
    const busAlone = fleetCeiling({ business: 10 }, 8);
    expect(fleetCeiling({ pro: 10, business: 10 }, 8)).toBe(proAlone + busAlone);
    expect(proAlone).toBe(16);
    expect(busAlone).toBe(24);
  });

  it('still leaves most of each replica idle at full saturation', () => {
    // 40 builds over 8 replicas is 5 of the 13 the ladder sums to, so eight
    // slots a replica sit unused even with two tiers saturated. That is the
    // waste `plugin_build_idle_floor_slots` publishes.
    const total = fleetCeiling({ pro: 10, business: 10 }, 8);
    expect(total).toBe(40);
    expect(total / 8).toBe(5);
    expect(BUILD_LADDER_CONCURRENCY_SUM - 5).toBe(8);
  });

  it('shares ONE borrow pool between the tiers, not one each', () => {
    // The misreading this pins. Per-tier borrow would give
    // (2+2)x8 + (3+2)x8 = 72; the shared pool gives 40 + 2x8 = 56.
    expect(fleetCeiling({ pro: 10, business: 10 }, 8, 2)).toBe(56);
    const perTierReading = runningWithBorrow('pro', 8, ORG_CAP_STANDARD.pro * 10, 2)
      + runningWithBorrow('business', 8, ORG_CAP_STANDARD.business * 10, 2);
    expect(perTierReading).toBe(72);
  });

  it('does nothing while both tiers are still org-capped', () => {
    // Three orgs each: 15 + 15, both under their tier ceilings, so there is no
    // unmet demand for the allowance to serve.
    expect(fleetCeiling({ pro: 3, business: 3 }, 8)).toBe(30);
    expect(fleetCeiling({ pro: 3, business: 3 }, 8, 2)).toBe(30);
  });

  it('never exceeds the replica budget, however many tiers are busy', () => {
    // All six tiers saturated with a large allowance: the sidecar bound holds.
    const all = { developer: 99, pro: 99, team: 99, business: 99, enterprise: 99, unlimited: 99 };
    expect(fleetCeiling(all, 8, 40)).toBe(8 * BUILD_LADDER_CONCURRENCY_SUM);
  });
});
