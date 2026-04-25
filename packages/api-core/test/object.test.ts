// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { pickDefined } from '../src/utils/object';

describe('pickDefined', () => {
  it('removes undefined values', () => {
    expect(pickDefined({ a: 1, b: undefined, c: 'x' })).toEqual({ a: 1, c: 'x' });
  });

  it('preserves null, false, 0, and empty string', () => {
    expect(pickDefined({ a: null, b: false, c: 0, d: '' })).toEqual({ a: null, b: false, c: 0, d: '' });
  });

  it('returns empty object when input is empty', () => {
    expect(pickDefined({})).toEqual({});
  });

  it('returns empty object when all values are undefined', () => {
    expect(pickDefined({ a: undefined, b: undefined })).toEqual({});
  });

  it('does not recurse into nested objects', () => {
    expect(pickDefined({ a: { b: undefined } })).toEqual({ a: { b: undefined } });
  });

  it('does not mutate the input', () => {
    const input = { a: 1, b: undefined };
    pickDefined(input);
    expect(input).toEqual({ a: 1, b: undefined });
  });
});
