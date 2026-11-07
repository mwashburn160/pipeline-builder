// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The keyed gate's two jobs: never exceed the total ceiling, and never let
 * borrowing cost a key its guaranteed floor.
 *
 * These are asserted rather than reasoned about because the failure modes are
 * silent. A gate that admits one caller too many does not throw — it hands an
 * extra concurrent build to a buildkitd sidecar sized for the ceiling, and the
 * symptom arrives later as an OOMKill. A gate that loses a waiter does not
 * throw either; the work just never runs.
 */

import { describe, it, expect } from '@jest/globals';
import { createKeyedConcurrencyGate } from '../src/utils/concurrency-gate.js';

/** A floor of 1 for every key, so "over the floor" means "more than one". */
const FLOOR = 1;

function borrowingGate(limit: number, borrowMax: number) {
  const borrowed = (perKey: ReadonlyMap<string, number>) => {
    let n = 0;
    for (const [, used] of perKey) n += Math.max(0, used - FLOOR);
    return n;
  };
  return createKeyedConcurrencyGate<string>({
    limit: () => limit,
    admits: (key, { perKey }) => (perKey.get(key) ?? 0) < FLOOR || borrowed(perKey) < borrowMax,
  });
}

/** A deferred task: start it, observe whether it ran, then let it finish. */
function task() {
  let release!: () => void;
  const done = new Promise<void>((r) => { release = r; });
  let started = false;
  return { started: () => started, release, run: async () => { started = true; await done; } };
}

const settle = () => new Promise((r) => setImmediate(r));

describe('the total ceiling is absolute', () => {
  it('never runs more than the limit, whatever the predicate says', async () => {
    // A predicate that always admits must still not breach the ceiling.
    const gate = createKeyedConcurrencyGate<string>({ limit: () => 2, admits: () => true });
    const ts = [task(), task(), task(), task()];
    ts.forEach((t) => { void gate.run('a', t.run); });
    await settle();
    expect(ts.filter((t) => t.started())).toHaveLength(2);
    expect(gate.state().inFlight).toBe(2);
  });
});

describe('borrowing is bounded', () => {
  it('with borrowMax 0, a key cannot exceed its floor even on an idle gate', async () => {
    // The shipped default. 12 free slots and the key still gets one, because
    // the other slots are owed to tiers that are not asking for them.
    const gate = borrowingGate(13, 0);
    const a1 = task(); const a2 = task();
    void gate.run('a', a1.run);
    void gate.run('a', a2.run);
    await settle();
    expect(a1.started()).toBe(true);
    expect(a2.started()).toBe(false);
    expect(gate.state().inFlight).toBe(1);
  });

  it('lets one key take its floor plus the whole allowance', async () => {
    const gate = borrowingGate(13, 2);
    const ts = [task(), task(), task(), task()];
    ts.forEach((t) => { void gate.run('a', t.run); });
    await settle();
    // floor 1 + borrow 2 = 3; the fourth waits.
    expect(ts.filter((t) => t.started())).toHaveLength(3);
  });

  it('still admits a key that is within its floor while another is borrowing', async () => {
    // The property borrowing must not break: `b` has never run, so its floor is
    // owed and must be honoured immediately, even though `a` is over its own.
    const gate = borrowingGate(13, 2);
    const a = [task(), task(), task()];
    a.forEach((t) => { void gate.run('a', t.run); });
    await settle();
    expect(a.filter((t) => t.started())).toHaveLength(3);

    const b = task();
    void gate.run('b', b.run);
    await settle();
    expect(b.started()).toBe(true);
  });

  it('skips a blocked borrower rather than stalling the queue behind it', () => expect((async () => {
    // Ceiling 3, allowance 1. `a` takes its floor AND the only borrow, so the
    // allowance is spent; `b` takes its floor, filling the ceiling.
    const gate = borrowingGate(3, 1);
    const a1 = task(); const a2 = task(); const b1 = task();
    void gate.run('a', a1.run);
    void gate.run('a', a2.run); // borrows the one allowance
    void gate.run('b', b1.run); // within b's floor
    await settle();
    expect([a1, a2, b1].filter((t) => t.started())).toHaveLength(3);

    const a3 = task(); const c1 = task();
    void gate.run('a', a3.run); // queued FIRST; would need a 2nd borrow
    void gate.run('c', c1.run); // queued SECOND; within c's untouched floor
    await settle();
    expect(a3.started()).toBe(false);
    expect(c1.started()).toBe(false);

    // Releasing `b` frees a slot while `a` still holds the allowance, so the
    // head of the queue is genuinely inadmissible. The slot must go to `c`,
    // which arrived later — a blocked borrower must not stall a caller that is
    // inside its own floor.
    b1.release();
    await settle();
    expect(c1.started()).toBe(true);
    expect(a3.started()).toBe(false);
    return 'ok';
  })()).resolves.toBe('ok'));

  it('runs the skipped borrower once the allowance frees up', async () => {
    // Skipping must not be dropping: the borrower is still in the queue.
    const gate = borrowingGate(2, 1);
    const a1 = task(); const a2 = task();
    void gate.run('a', a1.run);
    void gate.run('a', a2.run);
    await settle();
    const a3 = task();
    void gate.run('a', a3.run);
    await settle();
    expect(a3.started()).toBe(false);

    a2.release(); // drops a's borrowed slot back to 0
    await settle();
    expect(a3.started()).toBe(true);
  });
});

describe('the allowance is ONE pool, not one per key', () => {
  it('denies a second key its own borrow once the pool is spent', () => expect((async () => {
    // The misreading that matters for mixed load: with the allowance at 1, the
    // FLEET gets one build above a floor — not one per tier. `a` spends it, so
    // `b` gets its floor and nothing more, even though the ceiling has room.
    const gate = borrowingGate(10, 1);
    const a1 = task(); const a2 = task(); const b1 = task(); const b2 = task();
    void gate.run('a', a1.run);
    void gate.run('a', a2.run); // takes the single allowance
    void gate.run('b', b1.run); // within b's floor
    void gate.run('b', b2.run); // would need a second borrow
    await settle();
    expect(a1.started()).toBe(true);
    expect(a2.started()).toBe(true);
    expect(b1.started()).toBe(true);
    expect(b2.started()).toBe(false);
    // Three of ten slots used, and the fourth caller still waits — the bound is
    // the allowance, not the ceiling.
    expect(gate.state().inFlight).toBe(3);
    return 'ok';
  })()).resolves.toBe('ok'));

  it('hands the freed allowance to whichever key is waiting', () => expect((async () => {
    const gate = borrowingGate(10, 1);
    const a1 = task(); const a2 = task(); const b1 = task(); const b2 = task();
    void gate.run('a', a1.run);
    void gate.run('a', a2.run);
    void gate.run('b', b1.run);
    void gate.run('b', b2.run);
    await settle();
    expect(b2.started()).toBe(false);

    a2.release(); // returns the borrowed slot to the pool
    await settle();
    expect(b2.started()).toBe(true);
    return 'ok';
  })()).resolves.toBe('ok'));
});

describe('every waiter eventually runs', () => {
  it('drains a mixed backlog without losing a caller', async () => {
    // The silent failure this guards: a waiter skipped by the scan and never
    // revisited would simply never run, with no error anywhere.
    const gate = borrowingGate(3, 2);
    const keys = ['a', 'a', 'a', 'b', 'b', 'c'];
    const ran: string[] = [];
    const all = keys.map((k) => gate.run(k, async () => { ran.push(k); }));
    await Promise.all(all);
    expect(ran.sort()).toEqual([...keys].sort());
    expect(gate.state()).toEqual({ inFlight: 0, waiting: 0, perKey: new Map() });
  });
});
