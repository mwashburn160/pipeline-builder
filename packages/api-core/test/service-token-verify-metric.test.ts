// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `service_token_verify_total` must carry the SAME label keys on every emission.
 *
 * The Prometheus counter behind `emitCounter` is registered lazily with the
 * label keys of its FIRST emission, and an increment with a different key set
 * throws — which `emitCounter` swallows so a metrics fault can never break auth.
 * The failure paths used to emit `{ result }` while success emitted
 * `{ result, service }`, so when the first token a pod verified happened to be
 * bad, every later `ok` and `subject_mismatch` was silently dropped for the life
 * of the process. The one metric that says service-to-service auth is healthy
 * went quiet exactly when something had already gone wrong.
 *
 * The recording emitter below is as strict as the real counter: it fixes the
 * key set on first use and rejects any other.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { verifyServiceJwt } from '../src/services/service-keys.js';
import { installTestServiceKeys, type TestServiceKeysHandle } from '../src/testing/service-tokens.js';
import { resetCounterEmitter, setCounterEmitter } from '../src/utils/metric-emitter.js';

const METRIC = 'service_token_verify_total';

let keys: TestServiceKeysHandle;
let firstKeySet: string | undefined;
let rejected: Array<Record<string, string>>;
let accepted: Array<Record<string, string>>;

beforeAll(() => { keys = installTestServiceKeys(['billing', 'quota']); });
afterAll(() => { keys.uninstall(); resetCounterEmitter(); });

beforeEach(() => {
  firstKeySet = undefined;
  rejected = [];
  accepted = [];
  setCounterEmitter((name, labels = {}) => {
    if (name !== METRIC) return;
    const keySet = Object.keys(labels).sort().join(',');
    firstKeySet ??= keySet;
    // prom-client's behaviour: a different label set than the first throws.
    if (keySet !== firstKeySet) { rejected.push(labels); throw new Error(`label set ${keySet} != ${firstKeySet}`); }
    accepted.push(labels);
  });
});

const kidOf = (token: string): string => (jwt.decode(token, { complete: true })?.header.kid as string);

function verify(token: string, kid = kidOf(token)): void {
  try { verifyServiceJwt(token, { kid }); } catch { /* the outcome is irrelevant here; the metric is */ }
}

describe(METRIC, () => {
  it('still records successes after the FIRST verification a pod saw was a failure', () => {
    verify('not-a-jwt', 'kid-that-does-not-exist'); // unknown_kid — first emission
    verify(keys.sign('billing'));                     // ok

    expect(rejected).toEqual([]);
    expect(accepted.map((l) => l.result)).toEqual(['unknown_kid', 'ok']);
  });

  it('keeps every outcome on one label set', () => {
    const good = keys.sign('billing');
    verify(`${good.slice(0, -4)}AAAA`);             // invalid signature
    verify(keys.signAs('billing', 'quota'));        // subject_mismatch
    verify(good);                                   // ok

    expect(rejected).toEqual([]);
    expect(new Set(accepted.map((l) => Object.keys(l).sort().join(','))).size).toBe(1);
  });
});
