// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { TokenCache } from '../../src/template/cache';

describe('TokenCache', () => {
  it('parses and caches', () => {
    const c = new TokenCache(5);
    const first = c.parse('k', 'hello {{ a }}');
    const second = c.parse('k', 'hello {{ a }}');
    expect(second).toBe(first); // same reference (cache hit)
  });

  it('invalidates', () => {
    const c = new TokenCache(5);
    c.parse('k', '{{ a }}');
    c.invalidate('k');
    expect(c.size).toBe(0);
  });

  it('evicts oldest past capacity', () => {
    const c = new TokenCache(2);
    c.parse('a', 'a');
    c.parse('b', 'b');
    c.parse('c', 'c');
    expect(c.size).toBe(2);
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBeDefined();
    expect(c.get('c')).toBeDefined();
  });

  it('invalidatePrefix removes matching keys', () => {
    const c = new TokenCache(10);
    c.parse('plugin:foo:a', 'a');
    c.parse('plugin:foo:b', 'b');
    c.parse('plugin:bar:c', 'c');
    c.invalidatePrefix('plugin:foo:');
    expect(c.size).toBe(1);
  });
});
