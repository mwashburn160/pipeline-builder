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
const obs = await import('../src/utils/validation-observability.js');

function res() {
  const r: any = {};
  r.status = jest.fn(() => r);
  r.json = jest.fn(() => r);
  return r;
}

describe('alert destination schemas', () => {
  it('defaults a non-string target to empty and ignores a non-boolean enabled', () => {
    expect(obs.createAlertDestinationSchema.parse({ channel: 'in-app', label: 'x', target: 5, enabled: 'yes' }))
      .toEqual({ channel: 'in-app', label: 'x', target: '', enabled: undefined });
  });

  it('refuses an unknown channel and a bad severity', () => {
    expect(obs.createAlertDestinationSchema.safeParse({ channel: 'fax', label: 'x' }).success).toBe(false);
    expect(obs.updateAlertDestinationSchema.safeParse({ minSeverity: 'info' }).success).toBe(false);
  });
});

describe('dashboard schemas', () => {
  it('accepts a null description, ignores a non-object layout and keeps panel extras only when typed', () => {
    const parsed = obs.updateDashboardSchema.parse({
      description: null,
      layoutJson: 'nope',
      panels: [{ queryKey: 'k', title: 't', groupBy: 3, format: 'bytes', position: 'x' }],
    });
    expect(parsed.description).toBeNull();
    expect(parsed.layoutJson).toBeUndefined();
    expect(parsed.panels?.[0]).toEqual({ queryKey: 'k', title: 't', groupBy: null, format: 'bytes', position: undefined });
  });

  it('refuses an empty name, an unknown visibility and a panel span out of range', () => {
    expect(obs.createDashboardSchema.safeParse({ name: '' }).success).toBe(false);
    expect(obs.createDashboardSchema.safeParse({ name: 'd', visibility: 'world' }).success).toBe(false);
    expect(obs.createDashboardSchema.safeParse({ name: 'd', panels: [{ queryKey: 'k', title: 't', span: 13 }] }).success).toBe(false);
  });
});

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
