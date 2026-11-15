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

  // npm semantics for partial operands, wildcards and caret/tilde edges.
  it.each([
    // bare / `=` partial = the whole span it names
    ['26.5.0', '26', true],
    ['26.0.0', '26', true],
    ['27.0.0', '26', false],
    ['25.9.9', '26', false],
    ['26.0.0-rc.1', '26', false],
    ['26.5.0', '=26', true],
    ['26.5.0', '26.x', true],
    ['26.5.0', '26.X', true],
    ['26.5.0', '26.*', true],
    ['26.5.0', '26.x.x', true],
    ['27.0.0', '26.x', false],
    ['26.5.9', '26.5', true],
    ['26.6.0', '26.5', false],
    ['26.4.9', '26.5', false],
    ['26.5.0', '26.5.x', true],
    ['1.0.0', 'x', true],
    // <=, <, >, >= with partials
    ['26.5.0', '<=26', true],
    ['26.99.99', '<=26', true],
    ['27.0.0', '<=26', false],
    ['27.0.0-rc.1', '<=26', false],
    ['26.5.9', '<=26.5', true],
    ['26.6.0', '<=26.5', false],
    ['26.5.0', '<=26.5.0', true],
    ['26.5.1', '<=26.5.0', false],
    ['26.5.0', '<26', false],
    ['25.9.9', '<26', true],
    ['26.0.0-rc.1', '<26', false],
    ['26.5.0', '<26.6', true],
    ['26.6.0', '<26.6', false],
    ['26.5.0', '>26', false],
    ['27.0.0', '>26', true],
    ['26.6.0', '>26.5', true],
    ['26.5.9', '>26.5', false],
    ['26.5.1', '>26.5.0', true],
    ['26.5.0', '>26.5.0', false],
    ['26.5.0', '>=26', true],
    ['26.0.0', '>=26', true],
    ['25.9.9', '>=26', false],
    ['26.5.0', '>=26.5', true],
    ['26.4.9', '>=26.5', false],
    // tilde: major.minor fixed, or major alone when only that is given
    ['26.5.0', '~26', true],
    ['26.0.0', '~26', true],
    ['27.0.0', '~26', false],
    ['26.5.7', '~26.5', true],
    ['26.6.0', '~26.5', false],
    ['26.4.0', '~26.5', false],
    ['1.4.2', '~1.4.2', true],
    ['1.4.1', '~1.4.2', false],
    // caret: the left-most non-zero part is fixed
    ['1.9.9', '^1.2.3', true],
    ['1.2.2', '^1.2.3', false],
    ['2.0.0', '^1.2.3', false],
    ['2.0.0-rc.1', '^1.2.3', false],
    ['0.2.9', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
    ['0.0.5', '^0.0.3', false],
    ['0.0.2', '^0.0.3', false],
    ['1.9.0', '^1', true],
    ['2.0.0', '^1', false],
    ['0.9.0', '^0', true],
    ['1.0.0', '^0', false],
    ['0.0.9', '^0.0', true],
    ['0.1.0', '^0.0', false],
    ['1.5.0', '^1.x', true],
    // combined with || and space-AND
    ['26.5.0', '^24 || 26', true],
    ['25.0.0', '^24 || 26', false],
    ['26.5.0', '>=24 <=26', true],
    ['27.0.0', '>=24 <=26', false],
  ] as Array<[string, string, boolean]>)('%s in %j = %s (npm partial semantics)', (v, range, want) => {
    expect(satisfiesRange(v, range)).toBe(want);
  });

  it('matches nothing for `<` or `>` a bare wildcard', () => {
    expect(satisfiesRange('1.0.0', '<*')).toBe(false);
    expect(satisfiesRange('1.0.0', '>x')).toBe(false);
  });

  it('returns null for syntax it does not support, or a non-version', () => {
    expect(satisfiesRange('1.0.0', '1.0.0 - 2.0.0')).toBeNull();
    expect(satisfiesRange('1.0.0', '1.x.3')).toBeNull();
    expect(satisfiesRange('1.0.0', '1.2-rc.1')).toBeNull();
    expect(satisfiesRange('1.0.0', '>=latest')).toBeNull();
    expect(satisfiesRange('node', '>= 1')).toBeNull();
  });
});
