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
  it('should map the visibility filter to the visibility param', () => {
    expect(mapCommonParams({ visibility: 'public' }, true)).toEqual({ visibility: 'public' });
    expect(mapCommonParams({ visibility: 'private' }, true)).toEqual({ visibility: 'private' });
  });

  // Regression: previously this helper forced `visibility=private` for
  // non-admins, which made the API exclude all system-public catalog rows from
  // the dashboard. The backend's AccessControlQueryBuilder already returns the
  // correct scope (caller's own org + system-org public catalog), so this
  // helper now passes nothing through unless the user explicitly picked an
  // Access filter.
  it('should NOT force visibility when canViewPublic is false and no visibility filter', () => {
    expect(mapCommonParams({}, false)).toEqual({});
  });

  it('should not add visibility when canViewPublic is true and no visibility filter', () => {
    expect(mapCommonParams({}, true)).toEqual({});
  });

  it('honors an explicit visibility filter regardless of canViewPublic', () => {
    expect(mapCommonParams({ visibility: 'public' }, false)).toEqual({ visibility: 'public' });
    expect(mapCommonParams({ visibility: 'private' }, false)).toEqual({ visibility: 'private' });
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
    const result = mapCommonParams({ visibility: 'private', status: 'active', default: 'default' }, true);
    expect(result).toEqual({ visibility: 'private', isActive: 'true', isDefault: 'true' });
  });

  it('should ignore unknown filter keys', () => {
    expect(mapCommonParams({ name: 'test', foo: 'bar' }, true)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// canModify
// ---------------------------------------------------------------------------
// Mirrors the backend's requireVisibilityWriteAccess, rung for rung — the UI
// must never offer an action the API would refuse (or hide one it would allow).
describe('canModify', () => {
  const admin = { isSuperAdmin: true, canPublish: false, userId: 'u1' };
  const publisher = { isSuperAdmin: false, canPublish: true, userId: 'u1' };
  const member = { isSuperAdmin: false, canPublish: false, userId: 'u1' };

  it('allows a system admin at every rung', () => {
    for (const visibility of ['private', 'org', 'public']) {
      expect(canModify({ visibility, createdBy: 'someone-else' }, admin)).toBe(true);
    }
  });

  it('allows any member on an `org` row', () => {
    expect(canModify({ visibility: 'org', createdBy: 'someone-else' }, member)).toBe(true);
  });

  it('allows the AUTHOR on their own private draft', () => {
    expect(canModify({ visibility: 'private', createdBy: 'u1' }, member)).toBe(true);
  });

  it("denies a colleague on someone else's private draft", () => {
    expect(canModify({ visibility: 'private', createdBy: 'u2' }, member)).toBe(false);
  });

  it('fails closed on a private row when the viewer is unknown', () => {
    expect(canModify({ visibility: 'private', createdBy: '' }, { ...member, userId: undefined })).toBe(false);
  });

  it('gates the public rung on the publish permission', () => {
    expect(canModify({ visibility: 'public' }, member)).toBe(false);
    expect(canModify({ visibility: 'public' }, publisher)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// canWritePipeline — requires BOTH `pipelines:write` AND ownership (canModify).
// Guards against the list/detail pages diverging (detail page previously only
// checked canModify, showing enabled write controls to read-only members).
// ---------------------------------------------------------------------------
describe('canWritePipeline', () => {
  const canWrite = (p: string) => p === 'pipelines:write';
  const canWriteAndPublish = (p: string) => p === 'pipelines:write' || p === 'pipelines:publish';
  const cannotWrite = () => false;

  it('allows a member with pipelines:write on their own private draft', () => {
    expect(canWritePipeline(canWrite, false, { visibility: 'private', createdBy: 'u1' }, 'u1')).toBe(true);
  });

  it('allows a member with pipelines:write on an `org` pipeline they did not author', () => {
    expect(canWritePipeline(canWrite, false, { visibility: 'org', createdBy: 'u2' }, 'u1')).toBe(true);
  });

  it("denies a member on a colleague's private draft", () => {
    expect(canWritePipeline(canWrite, false, { visibility: 'private', createdBy: 'u2' }, 'u1')).toBe(false);
  });

  it('denies a read-only member (no pipelines:write) even on their own draft', () => {
    expect(canWritePipeline(cannotWrite, false, { visibility: 'private', createdBy: 'u1' }, 'u1')).toBe(false);
  });

  it('denies a writer without pipelines:publish on a public pipeline', () => {
    expect(canWritePipeline(canWrite, false, { visibility: 'public' }, 'u1')).toBe(false);
  });

  it('allows a writer WITH pipelines:publish on a public pipeline', () => {
    expect(canWritePipeline(canWriteAndPublish, false, { visibility: 'public' }, 'u1')).toBe(true);
  });

  it('requires the capability even for superadmins on a public pipeline', () => {
    // canModify would allow a superadmin, but without the capability the write
    // gate must still be closed — both conditions are required.
    expect(canWritePipeline(cannotWrite, true, { visibility: 'public' }, 'u1')).toBe(false);
  });

  it('allows a superadmin holding the capability at any rung', () => {
    for (const visibility of ['private', 'org', 'public']) {
      expect(canWritePipeline(canWrite, true, { visibility, createdBy: 'u2' }, 'u1')).toBe(true);
    }
  });
});
