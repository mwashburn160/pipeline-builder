// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

const { TtlCache } = await import('../src/services/ttl-cache.js');

describe('TtlCache', () => {
  it('expires entries after their TTL (default or per entry)', () => {
    const c = new TtlCache<string>(10, 1_000);
    c.set('a', 'A', undefined, 0);
    c.set('b', 'B', 5_000, 0);
    expect(c.get('a', 999)).toBe('A');
    expect(c.get('a', 1_000)).toBeUndefined();
    expect(c.get('b', 4_999)).toBe('B');
    expect(c.size).toBe(1);
  });

  it('evicts the least-recently-used entry at capacity (a read refreshes it)', () => {
    const c = new TtlCache<number>(2, 60_000);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1);
    c.set('c', 3);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    expect(c.get('c')).toBe(3);
  });

  it('deletes one key, a matching set, or everything', () => {
    const c = new TtlCache<number>(10, 60_000);
    for (const k of ['r1@x', 'r1@y', 'r2@x']) c.set(k, 1);
    expect(c.delete('r2@x')).toBe(true);
    expect(c.deleteWhere((k) => k.startsWith('r1@'))).toBe(2);
    c.set('z', 1);
    expect(c.clear()).toBe(1);
  });
});
