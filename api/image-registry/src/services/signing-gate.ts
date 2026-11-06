// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createConcurrencyGate, createLogger } from '@pipeline-builder/api-core';
import { incCounter, observe, setGauge } from '@pipeline-builder/api-server';
import { config } from '../config/index.js';

const logger = createLogger('signing-gate');

/**
 * A FIFO bound on how many signing operations run at once in this process.
 *
 * WHY THIS SERVICE DECIDES, AND NOT ITS CALLERS. Signing is memory-bound here:
 * each attest hands cosign a 7-17 MiB SBOM, and the fan-in is however many
 * builds the fleet happens to be running — 8 plugin replicas times their tier's
 * worker concurrency, a figure this service neither sets nor sees. When that
 * reached 32 the process peaked at 1019 MiB against its 1 GiB limit and was
 * OOMKilled; because `/token` (the registry login) is served by the SAME
 * process, every push died with it — 107 of 117 plugins on one install.
 * Throttling the producers fixes that run and nothing after it, so the capacity
 * bound belongs beside the memory it protects.
 *
 * WAITING, NOT REFUSING. Over the limit a caller QUEUES. Refusing would turn a
 * capacity limit into a build failure, which is the mistake the per-org slot cap
 * already made once — a 30-minute wait ending in terminal failure took out 80 of
 * 119 plugins. Waiting is cheap here precisely because the SBOM is streamed to
 * DISK before this gate is reached: a queued request holds a file handle and a
 * promise, not 17 MiB of heap. The caller's HTTP timeout, and
 * `PLUGIN_SIGNING_TIMEOUT_MS` once it starts, bound the wait; this gate
 * deliberately adds no deadline of its own.
 */
const gate = createConcurrencyGate({
  limit: () => config.pluginSigning.maxConcurrentSigns,
  onQueued: (waiting, limit) => {
    incCounter('registry_sign_queued_total', {});
    logger.info('Signing queued: at capacity', { limit, waiting });
  },
  onOccupancy: (inFlight) => setGauge('registry_sign_inflight', {}, inFlight),
});

/** Current occupancy — for the metrics above and for tests. */
export function signingGateState(): { inFlight: number; waiting: number } {
  return gate.state();
}

/** Test seam: drop a queue left behind by a failed assertion. */
export function _resetSigningGate(): void {
  gate.reset();
}

/** Run `fn` holding a signing slot. */
export async function withSigningSlot<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const queuedAt = Date.now();
  return gate.run(async () => {
    const startedAt = Date.now();
    observe('registry_sign_wait_seconds', { label }, (startedAt - queuedAt) / 1000);
    try {
      return await fn();
    } finally {
      // DURATION, not just the wait — because the gate's headroom is a RATE, and
      // without this nobody can compute it. Capacity is
      // `pods x REGISTRY_SIGN_MAX_CONCURRENT / duration`: at 2 pods, a limit of 4
      // and a 10s sign that is 48/min, and a build fleet of ~31 asks about
      // 10/min. The same arithmetic saturates at a 40s sign. The limit was
      // therefore picked against a number nobody had measured, and this is that
      // number; `registry_sign_wait_seconds` only says whether the gate BOUND,
      // never how close it was.
      observe('registry_sign_duration_seconds', { label }, (Date.now() - startedAt) / 1000);
    }
  });
}
