// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * GET /user/profile reads its user through a `.select()` projection, so a field
 * the controller reads but the projection omits is silently `undefined`.
 *
 * That is how "Don't ask again" on the two-factor prompt stopped working:
 * `POST /user/mfa-prompt/decline` wrote `mfaNudge.declinedAt` (and answered 200),
 * but the projection did not include `mfaNudge`, so the profile never reported
 * the decline and the banner came back on every page load. isSuperAdmin was lost
 * the same way once before (see the comment on the projection).
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

/** A stored user carrying every field the profile might read. */
const STORED_USER: Record<string, unknown> = {
  _id: 'u1',
  username: 'alice',
  email: 'alice@example.com',
  isEmailVerified: true,
  isSuperAdmin: false,
  lastActiveOrgId: 'o1',
  featureOverrides: {},
  tokenVersion: 3,
  mfaResetGraceUntil: null,
  mfaNudge: { declinedAt: new Date('2026-10-15T18:25:00Z') },
  password: 'hash-that-must-never-be-selected',
};

/** Apply a space-separated Mongo projection the way `.select().lean()` does. */
function project(doc: Record<string, unknown>, fields: string): Record<string, unknown> {
  const keep = fields.split(/\s+/).filter(Boolean);
  return Object.fromEntries(Object.entries(doc).filter(([k]) => keep.includes(k)));
}

let selected = '';
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('../src/models/index.js', () => ({
  User: {
    findById: () => ({
      select: (fields: string) => {
        selected = fields;
        return { lean: async () => project(STORED_USER, fields) };
      },
    }),
  },
  UserOrganization: { find: () => ({ lean: async () => [] }) },
  Organization: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
  UserPreferences: {},
}));
for (const m of [
  '../src/services/api-key-service.js',
  '../src/services/auth-service.js',
  '../src/services/user-cascade.js',
  '../src/helpers/active-org-info.js',
  '../src/helpers/password-policy.js',
  '../src/helpers/session-revocation.js',
  '../src/utils/mongo-tx.js',
]) {
  jest.unstable_mockModule(m, () => ({
    apiKeyService: {},
    authService: {},
    deleteUserCascade: jest.fn(),
    loadActiveOrgInfo: jest.fn(),
    assertNewPasswordAcceptable: jest.fn(),
    publishUserRevocation: jest.fn(),
    publishUserDeletionRevocation: jest.fn(),
    withMongoTransaction: jest.fn(),
  }));
}

const { userProfileService, PROFILE_USER_FIELDS } = await import('../src/services/user-profile-service.js');

describe('GET /user/profile — the user projection', () => {
  it('reads back a declined two-factor prompt, so "Don\'t ask again" sticks', async () => {
    const { user } = await userProfileService.getProfileWithOrgs('u1');
    expect(selected).toBe(PROFILE_USER_FIELDS);
    expect((user as { mfaNudge?: unknown }).mfaNudge).toEqual(STORED_USER.mfaNudge);
  });

  it('still never selects the password hash', async () => {
    const { user } = await userProfileService.getProfileWithOrgs('u1');
    expect(user).not.toHaveProperty('password');
  });

  it('selects every field the profile controller reads off the user', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const controller = readFileSync(path.join(here, '../src/controllers/user-profile.ts'), 'utf8');
    // The controller reads optional fields as `(user as { field?: … }).field`.
    const read = [...controller.matchAll(/\(user as \{ (\w+)\??:/g)].map((m) => m[1]);
    expect(read.length).toBeGreaterThan(0); // guards an empty scan
    const fields = PROFILE_USER_FIELDS.split(/\s+/);
    for (const f of read) expect([f, fields.includes(f)]).toEqual([f, true]);
  });
});
