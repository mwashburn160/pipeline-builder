// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, afterEach } from '@jest/globals';

import { emitCounter, resetCounterEmitter, setCounterEmitter } from '../src/utils/metric-emitter.js';

describe('metric-emitter', () => {
  afterEach(() => {
    resetCounterEmitter();
  });

  it('is a no-op until an emitter is registered', () => {
    // Should not throw / log anything observable. We can't assert "nothing
    // happened" directly, but we can assert no exception escapes the call.
    expect(() => emitCounter('test_metric', { foo: 'bar' })).not.toThrow();
  });

  it('forwards name / labels / value to the registered emitter', () => {
    const emitter = jest.fn();
    setCounterEmitter(emitter);
    emitCounter('quota_fail_open_total', { operation: 'check', reason: 'unreachable' }, 2);
    expect(emitter).toHaveBeenCalledWith(
      'quota_fail_open_total',
      { operation: 'check', reason: 'unreachable' },
      2,
    );
  });

  it('defaults value to 1 when not specified', () => {
    const emitter = jest.fn();
    setCounterEmitter(emitter);
    emitCounter('cnt', { k: 'v' });
    expect(emitter).toHaveBeenCalledWith('cnt', { k: 'v' }, 1);
  });

  it('defaults labels to an empty object when not specified', () => {
    const emitter = jest.fn();
    setCounterEmitter(emitter);
    emitCounter('cnt');
    expect(emitter).toHaveBeenCalledWith('cnt', {}, 1);
  });

  it('swallows emitter errors so they cannot break callers', () => {
    setCounterEmitter(() => {
      throw new Error('prom registry exploded');
    });
    expect(() => emitCounter('cnt', { k: 'v' })).not.toThrow();
  });

  it('resetCounterEmitter restores no-op behavior', () => {
    const emitter = jest.fn();
    setCounterEmitter(emitter);
    emitCounter('cnt');
    expect(emitter).toHaveBeenCalledTimes(1);

    resetCounterEmitter();
    emitCounter('cnt');
    // No further calls — emitter pointer was swapped back to no-op.
    expect(emitter).toHaveBeenCalledTimes(1);
  });

  it('last-call-wins when setCounterEmitter is called repeatedly', () => {
    const a = jest.fn();
    const b = jest.fn();
    setCounterEmitter(a);
    setCounterEmitter(b);
    emitCounter('cnt');
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});
