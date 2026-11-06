// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { BUILD_LADDER_CONCURRENCY_SUM, createConcurrencyGate, createLogger, envInt } from '@pipeline-builder/api-core';
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

const gate = createConcurrencyGate({
  limit: maxBuildsPerReplica,
  onQueued: (waiting, limit) => {
    incCounter('plugin_build_replica_queued_total', {});
    logger.info('Build queued: replica at capacity', { limit, waiting });
  },
  onOccupancy: (inFlight) => setGauge('plugin_build_replica_inflight', {}, inFlight),
});

/** Occupancy of this replica's build budget — for tests and the gauge. */
export function buildGateState(): { inFlight: number; waiting: number } {
  return gate.state();
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
  return gate.run(async () => {
    observe('plugin_build_replica_wait_seconds', { tier }, (Date.now() - queuedAt) / 1000);
    return fn();
  });
}
