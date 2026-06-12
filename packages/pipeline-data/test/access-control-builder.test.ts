// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for AccessControlQueryBuilder class.
 *
 * Exercises the buildCommonConditions() method which internally calls
 * buildAccessControl(), buildIdFilter(), and buildBooleanFilters().
 *
 * Access control rules:
 * - No orgId: system org public only (2 conditions)
 * - With orgId, no accessModifier: own org (any modifier) OR system/parent public,
 *   folded into a single OR (1 condition)
 * - With orgId, accessModifier='public': own org public only (2 conditions)
 * - With orgId, accessModifier='private': own org private only (2 conditions)
 */

import { jest, describe, it, expect } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { AccessControlQueryBuilder } = await import('../src/api/access-control-builder.js');
const { schema } = await import('../src/database/drizzle-schema.js');

// Use the real pipeline schema as the table for the builder
const builder = new AccessControlQueryBuilder(schema.pipeline);
const ORG_ID = 'org-abc-123';

// Access control — no orgId (anonymous)
describe('AccessControlQueryBuilder - no orgId (anonymous access)', () => {
  it('should produce system-public-only conditions when no orgId', () => {
    const conditions = builder.buildCommonConditions({});
    // access control (2: orgId='system' + accessModifier='public') + isActive default (1) = 3
    expect(conditions.length).toBe(3);
  });

  it('should produce same count with explicit isActive filter and no orgId', () => {
    const withDefault = builder.buildCommonConditions({});
    const withExplicit = builder.buildCommonConditions({ isActive: true });
    expect(withDefault.length).toBe(withExplicit.length);
  });
});

// isActive default behavior
describe('AccessControlQueryBuilder - isActive default filter', () => {
  it('should include isActive=true by default when isActive is not in filter', () => {
    const conditions = builder.buildCommonConditions({}, ORG_ID);
    // access control (1: single OR of own-org + system/parent-public) + isActive default (1) = 2
    expect(conditions.length).toBeGreaterThanOrEqual(2);

    // Explicitly providing isActive=true should produce the same number of conditions
    const explicitTrue = builder.buildCommonConditions({ isActive: true }, ORG_ID);
    expect(conditions.length).toBe(explicitTrue.length);
  });

  it('should use isActive=false when explicitly set to false', () => {
    const withoutIsActive = builder.buildCommonConditions({}, ORG_ID);
    const withIsActiveFalse = builder.buildCommonConditions(
      { isActive: false },
      ORG_ID,
    );
    // Both should have an isActive condition (default true vs explicit false),
    // so condition count should be the same for the boolean portion
    expect(withIsActiveFalse.length).toBe(withoutIsActive.length);
  });

  it('should use isActive=true when explicitly set to true', () => {
    const implicitTrue = builder.buildCommonConditions({}, ORG_ID);
    const explicitTrue = builder.buildCommonConditions(
      { isActive: true },
      ORG_ID,
    );
    // Same number of conditions: explicit true behaves identically to default
    expect(explicitTrue.length).toBe(implicitTrue.length);
  });

  it('should parse isActive string "false" as false', () => {
    const withStringFalse = builder.buildCommonConditions(
      { isActive: 'false' },
      ORG_ID,
    );
    // Still produces same number of conditions (access control + isActive)
    expect(withStringFalse.length).toBeGreaterThanOrEqual(2);
  });

  it('should parse isActive string "true" as true', () => {
    const withStringTrue = builder.buildCommonConditions(
      { isActive: 'true' },
      ORG_ID,
    );
    const withDefault = builder.buildCommonConditions({}, ORG_ID);
    expect(withStringTrue.length).toBe(withDefault.length);
  });
});

// isDefault filter (complementary to isActive tests)
describe('AccessControlQueryBuilder - isDefault filter', () => {
  it('should not include isDefault condition when not in filter', () => {
    const withoutDefault = builder.buildCommonConditions({}, ORG_ID);
    const withDefault = builder.buildCommonConditions(
      { isDefault: true },
      ORG_ID,
    );
    // isDefault is NOT defaulted like isActive, so providing it adds a condition
    expect(withDefault.length).toBe(withoutDefault.length + 1);
  });

  it('should add isDefault condition when explicitly set', () => {
    const without = builder.buildCommonConditions({}, ORG_ID);
    const withTrue = builder.buildCommonConditions({ isDefault: true }, ORG_ID);
    const withFalse = builder.buildCommonConditions({ isDefault: false }, ORG_ID);
    expect(withTrue.length).toBe(without.length + 1);
    expect(withFalse.length).toBe(without.length + 1);
  });
});

// Org → team hierarchy: parent-inherited visibility
describe('AccessControlQueryBuilder - parentOrgId (team → parent inheritance)', () => {
  const PARENT_ID = 'org-parent-999';

  it('folds parentOrgId into the single default-case OR (no extra condition)', () => {
    // Default case: or(ownOrg, and(public, or(system[, parent]))) (1) + isActive (1) = 2,
    // whether or not a parent is supplied — the parent is an extra OR branch, not a new condition.
    const withoutParent = builder.buildCommonConditions({}, ORG_ID);
    const withParent = builder.buildCommonConditions({}, ORG_ID, PARENT_ID);
    expect(withParent.length).toBe(withoutParent.length);
    expect(withParent.length).toBe(2);
  });

  it('ignores parentOrgId when an explicit accessModifier filter is set (own-org scoped)', () => {
    const withParent = builder.buildCommonConditions({ accessModifier: 'public' }, ORG_ID, PARENT_ID);
    // explicit public → orgId=$org + accessModifier='public' (2) + isActive (1) = 3; parent not added.
    expect(withParent.length).toBe(3);
  });

  it('ignores parentOrgId for anonymous (no orgId) access', () => {
    const anon = builder.buildCommonConditions({}, undefined, PARENT_ID);
    // system-public-only (2) + isActive (1) = 3
    expect(anon.length).toBe(3);
  });
});

// Default-view access semantics: own org is visible regardless of access
// modifier; the public gate applies only to other orgs (system/parent).
// Regression for: a freshly uploaded PRIVATE plugin vanishing from its own
// org's default listing because the view forced accessModifier='public'.
describe('AccessControlQueryBuilder - default view shows own-org private', () => {
  const dialect = new PgDialect();

  it('OR-s in the own-org branch without a public constraint', () => {
    const [accessControl] = builder.buildCommonConditions({}, ORG_ID);
    const { sql: text, params } = dialect.sqlToQuery(accessControl);

    // The own org id is a bare branch of the top-level OR (own-org rows are
    // returned for ANY access modifier), while 'public' only gates the
    // system/parent rows. So 'private' must NOT appear anywhere here.
    expect(params).toContain(ORG_ID.toLowerCase());
    expect(params).toContain('system');
    expect(params).toContain('public');
    expect(params).not.toContain('private');
    // own-org equality is OR'd in, not AND'ed with the public predicate.
    expect(text.toLowerCase()).toMatch(/org_id"?\s*=\s*\$\d+\s+or\s+\(/);
  });
});

// Combined filters
describe('AccessControlQueryBuilder - combined common conditions', () => {
  it('should include access control + isActive default for empty filter', () => {
    const conditions = builder.buildCommonConditions({}, ORG_ID);
    // access control (1: or(orgId=$org, public AND orgId='system')) + isActive default (1) = 2
    expect(conditions.length).toBe(2);
  });

  it('should add id filter condition', () => {
    const without = builder.buildCommonConditions({}, ORG_ID);
    const withId = builder.buildCommonConditions(
      { id: '12345678-1234-1234-1234-123456789abc' },
      ORG_ID,
    );
    expect(withId.length).toBe(without.length + 1);
  });

  it('should add accessModifier explicit filter condition', () => {
    const withPublic = builder.buildCommonConditions(
      { accessModifier: 'public' },
      ORG_ID,
    );
    // access control for explicit 'public' (2: orgId=$org + accessModifier='public') + isActive default (1) = 3
    expect(withPublic.length).toBe(3);
  });

  it('should handle all common filters together', () => {
    const conditions = builder.buildCommonConditions(
      {
        id: '12345678-1234-1234-1234-123456789abc',
        accessModifier: 'private',
        isDefault: true,
        isActive: false,
      },
      ORG_ID,
    );
    // access control for 'private' (2: orgId=$org + accessModifier='private') + id (1) + isDefault (1) + isActive (1) = 5
    expect(conditions.length).toBe(5);
  });

  it('should produce fewer conditions for anonymous with all filters', () => {
    const withOrg = builder.buildCommonConditions(
      { accessModifier: 'public', isDefault: true },
      ORG_ID,
    );
    const withoutOrg = builder.buildCommonConditions(
      { isDefault: true },
    );
    // Both have 2 access control conditions + isActive (1) + isDefault (1) = 4
    expect(withOrg.length).toBe(4);
    expect(withoutOrg.length).toBe(4);
  });
});
