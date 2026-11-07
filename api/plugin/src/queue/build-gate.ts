// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { BUILD_LADDER_CONCURRENCY_SUM, buildWorkerConcurrencyFor, createKeyedConcurrencyGate, createLogger, envInt, VALID_TIERS } from '@pipeline-builder/api-core';
import type { QuotaTier } from '@pipeline-builder/api-core';
import { incCounter, observe, setGauge } from '@pipeline-builder/api-server';

const logger = createLogger('build-gate');

/**
 * How many builds THIS replica runs at once, across every tier queue.
 *
 * WHY A SECOND BOUND. A replica starts one BullMQ Worker per tier, each with its
 * own concurrency, and all of them drive the SAME buildkitd sidecar — one
 * container with one memory limit (`BUILDKIT_MEMORY_LIMIT`). So the replica's
 * real ceiling is the SUM of the ladder, 13, which nothing declared: at that sum
 * the sidecar's 6144Mi is ~473 MiB per build, against a manifest comment warning
 * that too little memory OOM-kills gradle/npm/dotnet builds with
 * "buildkit-runc … container not running".
 *
 * The per-TIER concurrency is queue fairness, the per-ORG slot is tenant
 * fairness, and this is the resource bound. All three can bind; the lowest wins.
 *
 * Defaulted to the shipped ladder's sum, so it changes nothing today and starts
 * binding the moment a tier row is raised — which is exactly the edit that
 * silently quadrupled in-flight builds and OOMKilled the image registry.
 */
export function maxBuildsPerReplica(): number {
  return envInt('PLUGIN_MAX_BUILDS_PER_REPLICA', BUILD_LADDER_CONCURRENCY_SUM, { min: 1 });
}

/**
 * How many builds may run ABOVE their tier's floor at once on this replica.
 *
 * THE WASTE THIS RECOVERS. A replica runs one worker per tier, each capped at
 * its own row of the ladder, and a worker only polls its own queue. So a
 * single-tier backlog uses that tier's row and strands the rest: `unlimited` is
 * 1 of 13. That is not a corner case — `unlimited` means billing is not
 * configured, so on a local, minikube or fresh cluster EVERY org is that tier,
 * and it is the tier the sample catalogue loads under. A first-run install
 * therefore drains at 1 build per replica with 12 slots idle.
 *
 * DEFAULT 0, so this ships as an exact no-op: at zero the predicate below
 * reduces to "within your floor", which is what the worker concurrency already
 * enforces. An operator opts in, exactly as `PLUGIN_MAX_BUILDS_PER_REPLICA`
 * defaults to the ladder sum and only starts binding when someone raises a row.
 *
 * WHAT IT COSTS, because this is a real trade and not free capacity. Builds are
 * NOT preemptible — killing a buildkit build discards all of its work and
 * re-enters the retry/DLQ accounting — so a lent slot turns a tier's immediate
 * floor into "guaranteed once at most this many builds finish". Keep it small
 * on a multi-tenant cluster (2 bounds the wait at two builds); it can be most of
 * the ladder on a billing-disabled install, where there is no other tier to
 * protect. It can never exceed the replica budget, which still binds on top.
 */
export function buildBorrowMax(): number {
  return envInt('PLUGIN_BUILD_BORROW_MAX', 0, { min: 0 });
}

/** A tier's GUARANTEED floor on this replica — the ladder row, unchanged. */
function floorFor(tier: string): number {
  return buildWorkerConcurrencyFor(tier as QuotaTier);
}

/** Slots currently held ABOVE their tier's floor. */
function borrowedSlots(perKey: ReadonlyMap<string, number>): number {
  let borrowed = 0;
  for (const [tier, used] of perKey) borrowed += Math.max(0, used - floorFor(tier));
  return borrowed;
}

const gate = createKeyedConcurrencyGate<string>({
  limit: maxBuildsPerReplica,
  // ONE decision: the total ceiling is checked by the gate, and this adds the
  // per-tier policy. Within the floor a build always starts. Above it, it needs
  // the borrowing allowance — which is what keeps a burst from swallowing the
  // replica and starving a tier that is still inside its own floor.
  admits: (tier, { perKey }) => (perKey.get(tier) ?? 0) < floorFor(tier)
    || borrowedSlots(perKey) < buildBorrowMax(),
  onQueued: (tier, waiting, limit) => {
    incCounter('plugin_build_replica_queued_total', {});
    logger.info('Build queued: replica at capacity', { tier, limit, waiting });
  },
  onOccupancy: ({ total, perKey }) => {
    setGauge('plugin_build_replica_inflight', {}, total);
    const borrowed = borrowedSlots(perKey);
    setGauge('plugin_build_borrowed_inflight', {}, borrowed);
    // Floor capacity owed to tiers that are not using it: the waste this knob
    // exists to recover, published so it can be SEEN before anyone enables
    // borrowing — and so the effect is measurable afterwards.
    let idleReserved = 0;
    for (const tier of VALID_TIERS) idleReserved += Math.max(0, floorFor(tier) - (perKey.get(tier) ?? 0));
    setGauge('plugin_build_idle_floor_slots', {}, idleReserved);
  },
});

/** Occupancy of this replica's build budget — for tests and the gauge. */
export function buildGateState(): { inFlight: number; waiting: number } {
  // PROJECTED, not passed through: the keyed gate also carries per-tier counts,
  // and returning them here would widen a published shape that callers compare
  // exactly. Per-tier occupancy has its own accessor below.
  const { inFlight, waiting } = gate.state();
  return { inFlight, waiting };
}

/** Per-tier occupancy of the build budget — for the borrowing tests and gauges. */
export function buildGatePerTier(): ReadonlyMap<string, number> {
  return gate.state().perKey;
}

/** Test seam. */
export function _resetBuildGate(): void {
  gate.reset();
}

/**
 * Run `fn` holding one of this replica's build slots.
 *
 * Call this AFTER the org slot is held, never before: a job waiting here keeps
 * its org slot, which is harmless, whereas a job holding replica budget while
 * waiting for an org slot would spend the scarce resource on work that cannot
 * start. There is no cycle either way — a budget holder is building, not
 * queueing — so the ordering is about waste, not deadlock.
 */
export async function withReplicaBuildSlot<T>(tier: string, fn: () => Promise<T>): Promise<T> {
  const queuedAt = Date.now();
  return gate.run(tier, async () => {
    observe('plugin_build_replica_wait_seconds', { tier }, (Date.now() - queuedAt) / 1000);
    return fn();
  });
}
