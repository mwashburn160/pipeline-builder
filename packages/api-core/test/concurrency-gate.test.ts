// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared FIFO concurrency bound.
 *
 * It exists because two services need the same bound for the same reason: a
 * resource they own, consumed by work whose producer count is set elsewhere. The
 * image registry signs images (each attest hands cosign a 7-17 MiB SBOM against
 * a 1 GiB container) and a plugin replica runs builds (its six per-tier workers
 * share ONE buildkitd sidecar). 32 concurrent signs OOMKilled the registry and
 * took every push with it, since `/token` is the registry login.
 *
 * What these pin is the pair of properties that make the bound safe — it never
 * admits more than the limit, and it never REFUSES — plus the hand-off subtlety
 * that a second implementation would get wrong silently.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';

import { createConcurrencyGate } from '../src/utils/concurrency-gate.js';

/** Limit of 2, so the queueing path is reached with three callers. */
let gate = createConcurrencyGate({ limit: () => 2 });
const withSigningSlot = <T>(_label: string, fn: () => Promise<T>): Promise<T> => gate.run(fn);
const signingGateState = () => gate.state();
const _resetSigningGate = () => { gate = createConcurrencyGate({ limit: () => 2 }); };

/** A task that resolves only when the test says so. */
function gated() {
  let release: () => void = () => undefined;
  const started = { value: false };
  const task = () => {
    started.value = true;
    return new Promise<string>((resolve) => { release = () => resolve('done'); });
  };
  return { task, started, release: () => release() };
}

beforeEach(() => { _resetSigningGate(); });

describe('withSigningSlot', () => {
  it('admits up to the limit and makes the rest WAIT, not fail', async () => {
    const a = gated(); const b = gated(); const c = gated();
    const pa = withSigningSlot('sign', a.task);
    const pb = withSigningSlot('sign', b.task);
    const pc = withSigningSlot('sign', c.task);
    await Promise.resolve();

    // Two in flight (the configured limit), the third queued and NOT rejected.
    expect(a.started.value).toBe(true);
    expect(b.started.value).toBe(true);
    expect(c.started.value).toBe(false);
    expect(signingGateState()).toEqual({ inFlight: 2, waiting: 1 });

    a.release();
    await pa;
    await Promise.resolve();
    expect(c.started.value).toBe(true);

    b.release(); c.release();
    await expect(pb).resolves.toBe('done');
    await expect(pc).resolves.toBe('done');
    expect(signingGateState()).toEqual({ inFlight: 0, waiting: 0 });
  });

  it('never exceeds the limit even when every caller arrives at once', async () => {
    let peak = 0;
    const release: Array<() => void> = [];
    const runs = Array.from({ length: 8 }, () => withSigningSlot('sign', () => {
      peak = Math.max(peak, signingGateState().inFlight);
      return new Promise<void>((resolve) => release.push(resolve));
    }));
    // Drain the queue a slot at a time; each release admits exactly one waiter.
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
      release.shift()?.();
      await Promise.resolve();
    }
    await Promise.all(runs);
    expect(peak).toBe(2);
    expect(signingGateState()).toEqual({ inFlight: 0, waiting: 0 });
  });

  it('releases the slot when the work THROWS', async () => {
    // A failed sign that kept its slot would wedge the gate shut and stall every
    // later build — the failure mode is silent and permanent, so it is pinned.
    await expect(withSigningSlot('sign', () => Promise.reject(new Error('cosign exit 1')))).rejects.toThrow('cosign exit 1');
    expect(signingGateState()).toEqual({ inFlight: 0, waiting: 0 });

    const ok = await withSigningSlot('sign', () => Promise.resolve('next'));
    expect(ok).toBe('next');
  });

  it('hands a freed slot to the next waiter without dipping below the ceiling', async () => {
    // `release()` passes the slot straight over rather than decrementing first:
    // a dip to limit-1 would let an extra caller in past the bound.
    const a = gated(); const b = gated(); const c = gated();
    const pa = withSigningSlot('sign', a.task);
    void withSigningSlot('sign', b.task);
    void withSigningSlot('sign', c.task);
    await Promise.resolve();

    a.release();
    await pa;
    expect(signingGateState().inFlight).toBe(2);
  });
});
