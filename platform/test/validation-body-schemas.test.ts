// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The request-body schemas that replaced hand-rolled `typeof` checks: the
 * lenient fields stay lenient (a non-boolean `enabled` is ignored, not
 * refused), and the key routes keep the error codes their clients branch on.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';

jest.unstable_mockModule('../src/config/index.js', () => mockConfig());

const v = await import('../src/utils/validation.js');

function res() {
  const r: any = {};
  r.status = jest.fn(() => r);
  r.json = jest.fn(() => r);
  return r;
}

describe('access-key bodies', () => {
  it('answer the field\'s own error code', () => {
    const r1 = res();
    expect(v.validateBody(v.keyRevokeSchema, { key: 'pb_sa_x' }, r1, v.ACCESS_KEY_BODY_CODES)).toBeNull();
    expect(r1.json.mock.calls[0][0]).toMatchObject({ code: 'INVALID_KEY_ID' });

    const r2 = res();
    expect(v.validateBody(v.keyRotateSchema, { key: 'pb_sa_x', expiresIn: 'soon' }, r2, v.ACCESS_KEY_BODY_CODES)).toBeNull();
    expect(r2.json.mock.calls[0][0]).toMatchObject({ code: 'INVALID_EXPIRES_IN' });
  });

  it('trims the key and name, and parses expiresIn from a string', () => {
    expect(v.keyRotateSchema.parse({ key: ' pb_sa_x ', name: '  ', expiresIn: '3600' }))
      .toEqual({ key: 'pb_sa_x', name: undefined, expiresIn: 3600 });
  });
});

describe('notify-email body', () => {
  it('drops non-string target users and treats an absent list as null', () => {
    expect(v.notifyEmailSchema.parse({ orgId: 'o', subject: 's', text: 't', targetUsers: ['a', 1] }).targetUsers).toEqual(['a']);
    expect(v.notifyEmailSchema.parse({ orgId: 'o', subject: 's', text: 't' }).targetUsers).toBeNull();
  });
});

describe('admin user-create schema', () => {
  const base = { username: 'ops2', email: 'ops2@example.com', password: 'Str0ng!Passw0rd', organizationId: 'org-1' };

  it('refuses role: owner — the org already has one, and ownership moves only by transfer', () => {
    expect(v.adminCreateUserSchema.safeParse({ ...base, role: 'owner' }).success).toBe(false);
  });

  it('accepts the grantable roles', () => {
    expect(v.adminCreateUserSchema.safeParse({ ...base, role: 'admin' }).success).toBe(true);
    expect(v.adminCreateUserSchema.safeParse({ ...base, role: 'member' }).success).toBe(true);
  });
});
