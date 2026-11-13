// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from '@jest/globals';
import { compareSemver, isSemver, satisfiesRange } from '../src/utils/semver.js';

describe('compareSemver (SemVer 2.0 §11)', () => {
  it.each([
    ['4.4.19', '4.4.17', 1],
    ['4.4.17', '4.4.19', -1],
    ['4.10.0', '4.9.9', 1],
    ['5.0.0', '5.0.0', 0],
    ['v5.0.0', '5.0.0', 0],
    ['5.0.0+build.1', '5.0.0', 0],
    ['5.0.0-rc.1', '5.0.0', -1],
    ['5.0.0', '5.0.0-rc.1', 1],
    ['5.0.0-rc.2', '5.0.0-rc.10', -1],
    ['5.0.0-alpha', '5.0.0-alpha.1', -1],
    ['5.0.0-alpha.1', '5.0.0-alpha.beta', -1],
    ['5.0.0-beta', '5.0.0-alpha', 1],
  ] as Array<[string, string, number]>)('%s vs %s = %d', (a, b, want) => {
    expect(compareSemver(a, b)).toBe(want);
  });

  it('throws on a non-version', () => {
    expect(() => compareSemver('latest', '1.0.0')).toThrow('Not a semver version: latest');
  });

  it('isSemver', () => {
    expect(isSemver('1.2.3-rc.1+b')).toBe(true);
    expect(isSemver('1.2')).toBe(false);
    expect(isSemver('next')).toBe(false);
  });
});

describe('satisfiesRange', () => {
  it.each([
    ['v26.14.0', '>= 26.13.0', true],
    ['v26.12.9', '>= 26.13.0', false],
    ['v26.13.0', '>=26', true],
    ['v20.1.0', '^20.0.0 || >= 22', true],
    ['v21.0.0', '^20.0.0 || >= 22', false],
    ['v22.5.0', '>=22 <24', true],
    ['v24.0.0', '>=22 <24', false],
    ['1.4.9', '~1.4.2', true],
    ['1.5.0', '~1.4.2', false],
    ['0.2.5', '^0.2.1', true],
    ['0.3.0', '^0.2.1', false],
    ['1.0.0', '1.0.0', true],
    ['1.0.0', '*', true],
    ['1.0.0', '', true],
  ] as Array<[string, string, boolean]>)('%s in %j = %s', (v, range, want) => {
    expect(satisfiesRange(v, range)).toBe(want);
  });

  it('returns null for syntax it does not support, or a non-version', () => {
    expect(satisfiesRange('1.0.0', '1.x')).toBeNull();
    expect(satisfiesRange('1.0.0', '1.0.0 - 2.0.0')).toBeNull();
    expect(satisfiesRange('node', '>= 1')).toBeNull();
  });
});
