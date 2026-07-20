// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for resource-helpers.ts: mapCommonParams and canModify.
 */
import { mapCommonParams, canModify, canWritePipeline } from '../src/lib/resource-helpers';

// ---------------------------------------------------------------------------
// mapCommonParams
// ---------------------------------------------------------------------------
describe('mapCommonParams', () => {
  it('should map access filter to accessModifier param', () => {
    expect(mapCommonParams({ access: 'public' }, true)).toEqual({ accessModifier: 'public' });
    expect(mapCommonParams({ access: 'private' }, true)).toEqual({ accessModifier: 'private' });
  });

  // Regression: previously this helper forced `accessModifier=private` for
  // non-admins, which made the API exclude all system-public catalog rows from
  // the dashboard. The backend's AccessControlQueryBuilder already returns the
  // correct scope (caller's own org + system-org public catalog), so this
  // helper now passes nothing through unless the user explicitly picked an
  // Access filter.
  it('should NOT force accessModifier when canViewPublic is false and no access filter', () => {
    expect(mapCommonParams({}, false)).toEqual({});
  });

  it('should not add accessModifier when canViewPublic is true and no access filter', () => {
    expect(mapCommonParams({}, true)).toEqual({});
  });

  it('honors an explicit access filter regardless of canViewPublic', () => {
    expect(mapCommonParams({ access: 'public' }, false)).toEqual({ accessModifier: 'public' });
    expect(mapCommonParams({ access: 'private' }, false)).toEqual({ accessModifier: 'private' });
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

// ---------------------------------------------------------------------------
// canWritePipeline — requires BOTH `pipelines:write` AND ownership (canModify).
// Guards against the list/detail pages diverging (detail page previously only
// checked canModify, showing enabled write controls to read-only members).
// ---------------------------------------------------------------------------
describe('canWritePipeline', () => {
  const canWrite = (p: string) => p === 'pipelines:write';
  const cannotWrite = () => false;

  it('allows a member with pipelines:write on a private (owned) pipeline', () => {
    expect(canWritePipeline(canWrite, false, 'private')).toBe(true);
  });

  it('denies a read-only member (no pipelines:write) even on a private pipeline', () => {
    expect(canWritePipeline(cannotWrite, false, 'private')).toBe(false);
  });

  it('denies a writer on a public (unowned) pipeline when not a superadmin', () => {
    expect(canWritePipeline(canWrite, false, 'public')).toBe(false);
  });

  it('requires the capability even for superadmins on a public pipeline', () => {
    // canModify would allow a superadmin, but without the capability the write
    // gate must still be closed — both conditions are required.
    expect(canWritePipeline(cannotWrite, true, 'public')).toBe(false);
  });

  it('allows a superadmin holding the capability on any access modifier', () => {
    expect(canWritePipeline(canWrite, true, 'public')).toBe(true);
    expect(canWritePipeline(canWrite, true, 'private')).toBe(true);
  });
});
