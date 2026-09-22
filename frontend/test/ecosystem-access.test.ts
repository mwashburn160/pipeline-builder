// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { canSeeEcosystemConsole, isSystemOrgActive } from '../src/lib/ecosystem-access';
import { readSessionAssurance } from '../src/hooks/useSessionAssurance';
import { SYSTEM_ORG_ID } from '../src/lib/constants';

let token: string | null = null;
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { getAccessToken: () => token },
  base64UrlDecode: (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
}));

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload: unknown) => `${b64({ alg: 'ES256' })}.${b64(payload)}.sig`;

describe('ecosystem access', () => {
  it('recognizes the system org case-insensitively', () => {
    expect(isSystemOrgActive({ organizationId: SYSTEM_ORG_ID.toUpperCase() })).toBe(true);
    expect(isSystemOrgActive({ organizationId: 'tenant' })).toBe(false);
    expect(isSystemOrgActive(null)).toBe(false);
  });

  it('needs the system org AND an ecosystem permission', () => {
    const sys = { organizationId: SYSTEM_ORG_ID };
    expect(canSeeEcosystemConsole(sys, (p) => p === 'publishers:verify')).toBe(true);
    expect(canSeeEcosystemConsole(sys, () => false)).toBe(false);
    expect(canSeeEcosystemConsole({ organizationId: 'tenant' }, () => true)).toBe(false);
  });
});

describe('readSessionAssurance', () => {
  beforeEach(() => { token = null; });

  it('reads the access token aal claim', () => {
    token = jwt({ aal: 2 });
    expect(readSessionAssurance(null)).toBe(2);
    token = jwt({ aal: 1 });
    expect(readSessionAssurance({ mfaPolicy: { requireMfa: true, enforced: true, aal: 2 } })).toBe(1);
  });

  it('falls back to the profile echo, then to single-factor', () => {
    token = 'garbage';
    expect(readSessionAssurance({ mfaPolicy: { requireMfa: true, enforced: false, aal: 2 } })).toBe(2);
    expect(readSessionAssurance({})).toBe(1);
    token = null;
    expect(readSessionAssurance(undefined)).toBe(1);
  });
});
