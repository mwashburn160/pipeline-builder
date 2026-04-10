// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { pickDefined } from '../src/utils/object';

describe('pickDefined', () => {
  it('should remove undefined values', () => {
    const result = pickDefined({ a: 1, b: undefined, c: 'hello' });
    expect(result).toEqual({ a: 1, c: 'hello' });
  });

  it('should keep null values', () => {
    const result = pickDefined({ a: null, b: undefined });
    expect(result).toEqual({ a: null });
  });

  it('should keep false', () => {
    const result = pickDefined({ active: false, removed: undefined });
    expect(result).toEqual({ active: false });
  });

  it('should keep zero', () => {
    const result = pickDefined({ count: 0, missing: undefined });
    expect(result).toEqual({ count: 0 });
  });

  it('should keep empty string', () => {
    const result = pickDefined({ name: '', gone: undefined });
    expect(result).toEqual({ name: '' });
  });

  it('should return empty object when all values are undefined', () => {
    const result = pickDefined({ a: undefined, b: undefined });
    expect(result).toEqual({});
  });

  it('should return all entries when none are undefined', () => {
    const input = { x: 1, y: 'two', z: true };
    const result = pickDefined(input);
    expect(result).toEqual(input);
  });

  it('should handle empty object', () => {
    const result = pickDefined({});
    expect(result).toEqual({});
  });
});
