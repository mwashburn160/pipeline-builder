// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for api/semver-range — semver parsing and precedence, the supported
 * version specs (exact, latest, ^, ~, partials), the JS matcher, and the SQL
 * the plugin lookup filters and orders with.
 */

import { describe, it, expect } from '@jest/globals';
import { PgDialect, pgTable, varchar } from 'drizzle-orm/pg-core';
import {
  compareSemver, isVersionRange, maxSatisfying, parseSemver, parseVersionSpec, satisfiesVersionSpec,
  semverOrderBy, versionSpecCondition,
} from '../src/api/semver-range.js';

describe('parseSemver', () => {
  it('parses stable, prerelease and build metadata', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver(' 1.2.3-rc.1+sha.abc ')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ['rc', '1'] });
  });

  it.each(['1.2', '01.2.3', '1.2.3-', 'v1.2.3', 'latest', '3000000000.0.0'])('refuses %p', (v) => {
    expect(parseSemver(v)).toBeNull();
  });
});

describe('compareSemver (semver 2.0 precedence)', () => {
  const ordered = [
    '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11',
    '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '1.10.0', '2.0.0',
  ];

  it('orders the spec example chain', () => {
    const shuffled = [...ordered].reverse();
    expect(shuffled.sort(compareSemver)).toEqual(ordered);
  });

  it('treats equal versions as equal and sorts unparseable ones lowest', () => {
    expect(compareSemver('1.2.3', '1.2.3+build')).toBe(0);
    expect(compareSemver('garbage', '0.0.1')).toBeLessThan(0);
    expect(compareSemver('0.0.1', 'garbage')).toBeGreaterThan(0);
    expect(compareSemver('x', 'y')).toBe(0);
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

describe('SQL', () => {
  const t = pgTable('plugins', { version: varchar('version') });
  const dialect = new PgDialect();
  const render = (s: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(s);

  it('an exact or unparseable spec is a plain equality', () => {
    expect(render(versionSpecCondition(t.version, '1.2.3'))).toMatchObject({ params: ['1.2.3'] });
    expect(render(versionSpecCondition(t.version, 'not a spec')).params).toEqual(['not a spec']);
  });

  it('latest is "stable only"', () => {
    expect(render(versionSpecCondition(t.version, 'latest')).sql).toContain('IS NULL');
  });

  it('a range compares the numeric tuple and bounds are parameters', () => {
    const q = render(versionSpecCondition(t.version, '^1.2.3'));
    expect(q.sql).toContain('split_part');
    expect(q.params).toEqual(expect.arrayContaining([1, 2, 3, 2, 0, 0]));
  });

  it('a prerelease lower bound also admits prereleases of its own tuple', () => {
    const q = render(versionSpecCondition(t.version, '^2.0.0-rc.1'));
    expect(q.sql).toMatch(/ or /i);
  });

  it('orders highest semver first with stable above prerelease', () => {
    const terms = semverOrderBy(t.version).map((s) => render(s).sql);
    expect(terms).toHaveLength(6);
    expect(terms[0]).toMatch(/desc$/i);
    expect(terms[3]).toContain('IS NULL DESC');
  });
});
