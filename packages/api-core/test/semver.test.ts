// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from '@jest/globals';
import {
  compareSemver, compareSemverLenient, isSemver, isVersionRange, maxSatisfying, parseSemver, parseVersionSpec,
  satisfiesRange, satisfiesVersionSpec,
} from '../src/utils/semver.js';

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

// -- Plugin version specs + lenient precedence (formerly pipeline-data's semver-range) --

describe('parseSemver', () => {
  it('parses stable, prerelease and build metadata', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver(' 1.2.3-rc.1+sha.abc ')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ['rc', '1'] });
  });

  it.each(['1.2', '01.2.3', '1.2.3-', 'v1.2.3', 'latest', '3000000000.0.0'])('refuses %p', (v) => {
    expect(parseSemver(v)).toBeNull();
  });
});

describe('compareSemverLenient (semver 2.0 precedence, invalid lowest)', () => {
  const ordered = [
    '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11',
    '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '1.10.0', '2.0.0',
  ];

  it('orders the spec example chain', () => {
    const shuffled = [...ordered].reverse();
    expect(shuffled.sort(compareSemverLenient)).toEqual(ordered);
  });

  it('treats equal versions as equal and sorts unparseable ones lowest', () => {
    expect(compareSemverLenient('1.2.3', '1.2.3+build')).toBe(0);
    expect(compareSemverLenient('garbage', '0.0.1')).toBeLessThan(0);
    expect(compareSemverLenient('0.0.1', 'garbage')).toBeGreaterThan(0);
    expect(compareSemverLenient('x', 'y')).toBe(0);
  });
});

describe('parseVersionSpec + isVersionRange', () => {
  it.each([
    ['latest', { kind: 'latest' }],
    ['1.2.3', { kind: 'exact', version: '1.2.3' }],
  ])('%s', (spec, expected) => {
    expect(parseVersionSpec(spec)).toEqual(expected);
  });

  it.each([
    ['^1.2.3', [1, 2, 3], [2, 0, 0]],
    ['^0.2.3', [0, 2, 3], [0, 3, 0]],
    ['^0.0.3', [0, 0, 3], [0, 0, 4]],
    ['~1.2.3', [1, 2, 3], [1, 3, 0]],
    ['1', [1, 0, 0], [2, 0, 0]],
    ['1.x', [1, 0, 0], [2, 0, 0]],
    ['1.*', [1, 0, 0], [2, 0, 0]],
    ['1.2', [1, 2, 0], [1, 3, 0]],
    ['1.2.x', [1, 2, 0], [1, 3, 0]],
    // Partial caret / tilde (npm) — what the directory's copyable reference writes.
    ['^1', [1, 0, 0], [2, 0, 0]],
    ['^1.x', [1, 0, 0], [2, 0, 0]],
    ['^1.2', [1, 2, 0], [2, 0, 0]],
    ['^0.2', [0, 2, 0], [0, 3, 0]],
    ['^0', [0, 0, 0], [1, 0, 0]],
    ['~1', [1, 0, 0], [2, 0, 0]],
    ['~1.2', [1, 2, 0], [1, 3, 0]],
    ['~1.2.x', [1, 2, 0], [1, 3, 0]],
  ])('%s is the range [%p, %p)', (spec, min, max) => {
    const parsed = parseVersionSpec(spec);
    expect(parsed).toMatchObject({
      kind: 'range',
      min: { major: min[0], minor: min[1], patch: min[2] },
      max: { major: max[0], minor: max[1], patch: max[2] },
    });
    expect(isVersionRange(spec)).toBe(true);
  });

  it.each(['^banana', '>=1.0.0', '1.2.3.4', '', 'x', '^99999999999', '~1.99999999999'])('does not parse %p', (spec) => {
    expect(parseVersionSpec(spec)).toBeNull();
    expect(isVersionRange(spec)).toBe(false);
  });

  it('an exact version is not a range', () => {
    expect(isVersionRange('1.2.3')).toBe(false);
  });
});

describe('satisfiesVersionSpec + maxSatisfying', () => {
  const versions = ['1.0.0', '1.2.0', '1.9.9', '2.0.0-rc.1', '2.0.0', '2.1.0-beta', '3.0.0'];

  it('matches caret, tilde and partials, excluding prereleases', () => {
    expect(maxSatisfying(versions, '^1.0.0')).toBe('1.9.9');
    expect(maxSatisfying(versions, '~1.2.0')).toBe('1.2.0');
    expect(maxSatisfying(versions, '2')).toBe('2.0.0');
    expect(maxSatisfying(versions, 'latest')).toBe('3.0.0');
    expect(maxSatisfying(versions, '^4.0.0')).toBeNull();
    expect(maxSatisfying(versions, '^1')).toBe('1.9.9');
    expect(maxSatisfying(versions, '~1.2')).toBe('1.2.0');
  });

  it('admits prereleases only of the lower bound\'s own tuple', () => {
    expect(satisfiesVersionSpec('2.0.0-rc.2', '^2.0.0-rc.1')).toBe(true);
    expect(satisfiesVersionSpec('2.1.0-beta', '^2.0.0-rc.1')).toBe(false);
    expect(satisfiesVersionSpec('2.0.0-rc.1', '^2.0.0')).toBe(false);
  });

  it('matches exact and literal specs literally', () => {
    expect(satisfiesVersionSpec('1.2.0', '1.2.0')).toBe(true);
    expect(satisfiesVersionSpec('1.2.0', '1.2.1')).toBe(false);
    expect(satisfiesVersionSpec('weird', 'weird')).toBe(true);
    expect(satisfiesVersionSpec('not-semver', '^1.0.0')).toBe(false);
    expect(satisfiesVersionSpec('1.0.0', parseVersionSpec('^1.0.0')!)).toBe(true);
  });
});

describe('strict and lenient comparators agree on valid versions', () => {
  it.each([
    ['1.0.0', '1.0.1'], ['1.0.0-rc.1', '1.0.0'], ['2.0.0', '2.0.0'], ['1.0.0-alpha.beta', '1.0.0-alpha.1'], ['1.10.0', '1.9.0'],
  ])('%s vs %s', (a, b) => {
    expect(Math.sign(compareSemverLenient(a, b))).toBe(compareSemver(a, b));
  });

  it('differ exactly where documented: strict throws / accepts `v`, lenient sorts invalid lowest', () => {
    expect(compareSemver('v1.0.0', '1.0.0')).toBe(0);
    expect(compareSemverLenient('v1.0.0', '1.0.0')).toBeLessThan(0); // `v1.0.0` is not canonical
    expect(() => compareSemver('nope', '1.0.0')).toThrow();
    expect(compareSemverLenient('nope', '1.0.0')).toBeLessThan(0);
  });
});
