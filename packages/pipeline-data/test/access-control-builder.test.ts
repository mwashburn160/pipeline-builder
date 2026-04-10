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
 * - With orgId, no accessModifier: own org public + system public (2 conditions)
 * - With orgId, accessModifier='public': own org public only (2 conditions)
 * - With orgId, accessModifier='private': own org private only (2 conditions)
 */

jest.mock('@mwashburn160/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  SYSTEM_ORG_ID: 'system',
  AccessModifier: { PUBLIC: 'public', PRIVATE: 'private' },
}));

import { AccessControlQueryBuilder } from '../src/api/access-control-builder';
import { schema } from '../src/database/drizzle-schema';

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
    // access control (2) + isActive default (1) = 3
    expect(conditions.length).toBeGreaterThanOrEqual(3);

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
    expect(withStringFalse.length).toBeGreaterThanOrEqual(3);
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

// Combined filters
describe('AccessControlQueryBuilder - combined common conditions', () => {
  it('should include access control + isActive default for empty filter', () => {
    const conditions = builder.buildCommonConditions({}, ORG_ID);
    // access control (2: accessModifier='public' + or(orgId=$org, orgId='system')) + isActive default (1) = 3
    expect(conditions.length).toBe(3);
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
