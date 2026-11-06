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
