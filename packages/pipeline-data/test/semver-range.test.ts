// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for api/semver-range — the SQL the plugin lookup filters and orders
 * with, and that the JS half is api-core's semver module re-exported unchanged
 * (its behaviour is tested in api-core's semver.test.ts).
 */

import { describe, it, expect } from '@jest/globals';
import { PgDialect, pgTable, varchar } from 'drizzle-orm/pg-core';
import {
  compareSemver as deprecatedCompareSemver, compareSemverLenient, isVersionRange, maxSatisfying, parseSemver, parseVersionSpec,
  satisfiesVersionSpec, semverOrderBy, versionSpecCondition,
} from '../src/api/semver-range.js';

// The JS parser / matcher / precedence moved to api-core's single semver module
// (tested there); this file re-exports it unchanged and owns only the SQL half.
describe('re-exports api-core\'s semver module', () => {
  it('is the same implementation, and the deprecated compareSemver is the LENIENT one', async () => {
    const core = await import('@pipeline-builder/api-core');
    expect(parseSemver).toBe(core.parseSemver);
    expect(parseVersionSpec).toBe(core.parseVersionSpec);
    expect(satisfiesVersionSpec).toBe(core.satisfiesVersionSpec);
    expect(maxSatisfying).toBe(core.maxSatisfying);
    expect(isVersionRange).toBe(core.isVersionRange);
    expect(compareSemverLenient).toBe(core.compareSemverLenient);
    expect(deprecatedCompareSemver('garbage', '0.0.1')).toBeLessThan(0); // never throws
    expect(deprecatedCompareSemver('1.0.1', '1.0.0')).toBeGreaterThan(0);
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
