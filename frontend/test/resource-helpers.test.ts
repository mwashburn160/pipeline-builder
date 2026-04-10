// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for resource-helpers.ts: mapCommonParams and canModify.
 */
import { mapCommonParams, canModify } from '../src/lib/resource-helpers';

// ---------------------------------------------------------------------------
// mapCommonParams
// ---------------------------------------------------------------------------
describe('mapCommonParams', () => {
  it('should map access filter to accessModifier param', () => {
    expect(mapCommonParams({ access: 'public' }, true)).toEqual({ accessModifier: 'public' });
    expect(mapCommonParams({ access: 'private' }, true)).toEqual({ accessModifier: 'private' });
  });

  it('should default to private when canViewPublic is false and no access filter', () => {
    expect(mapCommonParams({}, false)).toEqual({ accessModifier: 'private' });
  });

  it('should not add accessModifier when canViewPublic is true and no access filter', () => {
    expect(mapCommonParams({}, true)).toEqual({});
  });

  it('should map status filter to isActive param', () => {
    expect(mapCommonParams({ status: 'active' }, true)).toEqual({ isActive: 'true' });
    expect(mapCommonParams({ status: 'inactive' }, true)).toEqual({ isActive: 'false' });
  });

  it('should map default filter to isDefault param', () => {
    expect(mapCommonParams({ default: 'default' }, true)).toEqual({ isDefault: 'true' });
    expect(mapCommonParams({ default: 'non-default' }, true)).toEqual({ isDefault: 'false' });
  });

  it('should map multiple filters at once', () => {
    const result = mapCommonParams({ access: 'private', status: 'active', default: 'default' }, true);
    expect(result).toEqual({ accessModifier: 'private', isActive: 'true', isDefault: 'true' });
  });

  it('should ignore unknown filter keys', () => {
    expect(mapCommonParams({ name: 'test', foo: 'bar' }, true)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// canModify
// ---------------------------------------------------------------------------
describe('canModify', () => {
  it('should allow system admin to modify any resource', () => {
    expect(canModify(true, 'public')).toBe(true);
    expect(canModify(true, 'private')).toBe(true);
  });

  it('should allow non-admin to modify private resources', () => {
    expect(canModify(false, 'private')).toBe(true);
  });

  it('should deny non-admin from modifying public resources', () => {
    expect(canModify(false, 'public')).toBe(false);
  });
});
