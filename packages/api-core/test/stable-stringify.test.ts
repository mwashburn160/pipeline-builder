// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import { stableStringify } from '../src/utils/object.js';

describe('stableStringify', () => {
  it('sorts keys recursively and is insertion-order independent', () => {
    expect(stableStringify({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' } }))
      .toBe('{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}');
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });
  it('maps null/undefined to null, drops undefined keys, serializes Dates as ISO', () => {
    expect(stableStringify(undefined)).toBe('null');
    expect(stableStringify({ a: undefined, b: null })).toBe('{"b":null}');
    expect(stableStringify(new Date('2026-01-02T03:04:05.000Z'))).toBe('"2026-01-02T03:04:05.000Z"');
    expect(stableStringify([undefined, 'x'])).toBe('[null,"x"]');
  });
});
