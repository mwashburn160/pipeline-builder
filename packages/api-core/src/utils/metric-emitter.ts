// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pluggable counter-emit shim.
 *
 * Background: several api-core primitives (quota client fail-open, future
 * security-event hooks) want to record Prometheus counters when something
 * notable happens. The actual `prom-client` Counter registration lives in
 * api-server, and api-core must not depend on api-server (api-core is
 * upstream — Express infrastructure imports it, not the other way around).
 *
 * This module is the seam. api-core code calls `emitCounter(name, labels)`;
 * by default it's a no-op (tests, CLIs, environments without Prometheus).
 * api-server's app-factory calls `setCounterEmitter(incCounter)` at startup
 * so production processes start incrementing the real counter on the
 * shared registry.
 *
 * Why a callback instead of an interface registered via DI? The call sites
 * (quota fail-open, etc.) sit in deep helpers that never touch the Express
 * context, so requiring a `metrics` parameter on every call would mean
 * threading it through dozens of unrelated functions. A process-singleton
 * callback is the simplest non-invasive option; the trade-off is one
 * shared global, which is acceptable for a sink that's strictly write-only.
 */

/** Callable signature mirroring api-server's `incCounter`. */
export type CounterEmitter = (name: string, labels?: Record<string, string>, value?: number) => void;

let emitter: CounterEmitter = () => {
  // Default no-op. api-server wires this to a real Prometheus counter at
  // startup; until then, calls from api-core helpers are silently dropped
  // (which is what we want in tests and CLIs that don't run a Prom server).
};

/**
 * Register the real counter implementation. Idempotent — the last call wins;
 * typically called once at service startup from api-server.
 */
export function setCounterEmitter(fn: CounterEmitter): void {
  emitter = fn;
}

/** Reset to the no-op emitter. For tests that want to clear any wiring. */
export function resetCounterEmitter(): void {
  emitter = () => undefined;
}

/**
 * Record a counter event. Safe to call from any api-core module — if no
 * emitter is wired, this is a no-op.
 */
export function emitCounter(name: string, labels: Record<string, string> = {}, value = 1): void {
  try {
    emitter(name, labels, value);
  } catch {
    // Never let metric emission break the calling path. A misbehaving
    // emitter shouldn't be able to take down quota checks (or anything else).
  }
}
