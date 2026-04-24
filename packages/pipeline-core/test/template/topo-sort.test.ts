// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { topoSort } from '../../src/template/topo-sort';

describe('topoSort', () => {
  it('orders a simple chain', () => {
    const { ordered, cycles } = topoSort([
      { key: 'c', deps: ['b'] },
      { key: 'b', deps: ['a'] },
      { key: 'a', deps: [] },
    ]);
    expect(cycles).toEqual([]);
    expect(ordered).toEqual(['a', 'b', 'c']);
  });

  it('orders disjoint components', () => {
    const { ordered, cycles } = topoSort([
      { key: 'a', deps: [] },
      { key: 'b', deps: [] },
    ]);
    expect(cycles).toEqual([]);
    expect(ordered.sort()).toEqual(['a', 'b']);
  });

  it('detects a 2-node cycle', () => {
    const { cycles } = topoSort([
      { key: 'a', deps: ['b'] },
      { key: 'b', deps: ['a'] },
    ]);
    expect(cycles.length).toBeGreaterThan(0);
  });

  it('detects a self-loop', () => {
    const { cycles } = topoSort([{ key: 'a', deps: ['a'] }]);
    expect(cycles).toEqual([['a', 'a']]);
  });

  it('ignores deps that are not nodes (external dependencies)', () => {
    const { ordered, cycles } = topoSort([
      { key: 'a', deps: ['external1', 'external2'] },
    ]);
    expect(cycles).toEqual([]);
    expect(ordered).toEqual(['a']);
  });

  it('diamond dependency', () => {
    const { ordered, cycles } = topoSort([
      { key: 'd', deps: ['b', 'c'] },
      { key: 'b', deps: ['a'] },
      { key: 'c', deps: ['a'] },
      { key: 'a', deps: [] },
    ]);
    expect(cycles).toEqual([]);
    expect(ordered[0]).toBe('a');
    expect(ordered[3]).toBe('d');
  });
});
