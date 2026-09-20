// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Security posture: the user's own strip on the Security page and the admin's
 * "Organization security" card on the home page. Both state only what the APIs
 * report — no item is shown for something that couldn't be read.
 */

import { render, screen, waitFor } from '@testing-library/react';
import type { User } from '@/types';

let entitled = true;
jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  useFeatures: () => ({ isEnabled: () => entitled, isLoaded: true, isSuperAdmin: false }),
}));

const api = {
  getTotpStatus: jest.fn(),
  listSessions: jest.fn(),
  getOwnOrgIdpConfig: jest.fn(),
  getMfaPolicy: jest.fn(),
};
jest.mock('@/lib/api', () => ({ __esModule: true, default: api }));

import { SecurityPostureStrip, derivePosture } from '../src/components/security/SecurityPostureStrip';
import { OrgSecurityCard } from '../src/components/security/OrgSecurityCard';

const baseUser = (over: Partial<User> = {}): User => ({
  id: 'u1', username: 'ada', email: 'ada@example.com', role: 'member', isEmailVerified: true,
  organizationId: 'org-1', permissions: [],
  authFactors: { hasPassword: true, passkeyCount: 0, hasTotp: false, providers: [] },
  ...over,
} as User);

beforeEach(() => {
  jest.clearAllMocks();
  entitled = true;
  api.getTotpStatus.mockResolvedValue({ success: true, data: { totp: { enabled: true, recoveryCodesRemaining: 2, recoveryCodesTotal: 10 } } });
  api.listSessions.mockResolvedValue({ success: true, data: { sessions: [{ id: 's1' }, { id: 's2' }, { id: 's3' }], machineSessions: [] } });
  api.getOwnOrgIdpConfig.mockResolvedValue({ success: true, data: { config: { enabled: true, protocol: 'oidc' } } });
  api.getMfaPolicy.mockResolvedValue({
    success: true,
    data: { requireMfa: true, enforced: true, own: true, idpEnforcesMfa: false, defaultGraceDays: 14, enrolment: { members: 10, enrolled: 7 } },
  });
});

describe('derivePosture', () => {
  const byId = (items: ReturnType<typeof derivePosture>) => Object.fromEntries(items.map((i) => [i.id, i]));

  it('reports factors straight from the profile', () => {
    const items = byId(derivePosture({
      user: baseUser({ authFactors: { hasPassword: false, passkeyCount: 2, hasTotp: true, providers: [] } }),
      recoveryCodes: { remaining: 8, total: 10 }, activeSessions: 1, sso: undefined, canManageOrg: false,
    }));
    expect(items.password.value).toBe('Not set');
    expect(items.password.tone).toBe('neutral'); // normal for OAuth / SSO accounts
    expect(items.passkeys.value).toBe('2');
    expect(items.totp.value).toBe('On');
    expect(items.recovery).toMatchObject({ value: '8 of 10 left', tone: 'good' });
    expect(items.sessions.value).toBe('1');
  });

  it('warns at two or fewer recovery codes', () => {
    const items = byId(derivePosture({
      user: baseUser({ authFactors: { hasPassword: true, passkeyCount: 0, hasTotp: true, providers: [] } }),
      recoveryCodes: { remaining: 2, total: 10 }, activeSessions: null, sso: undefined, canManageOrg: false,
    }));
    expect(items.recovery.tone).toBe('warn');
    expect(items.sessions).toBeUndefined();
  });

  it('flags an org MFA requirement the user cannot meet, and shows the grace deadline', () => {
    const items = byId(derivePosture({
      user: baseUser({ mfaPolicy: { requireMfa: true, enforced: false, graceUntil: '2026-10-01T00:00:00Z', aal: 1 } }),
      recoveryCodes: null, activeSessions: null, sso: undefined, canManageOrg: false,
    }));
    expect(items['org-mfa'].value).toMatch(/^Required from /);
    expect(items['org-mfa'].tone).toBe('warn');
    expect(items['org-mfa'].href).toContain('#passkeys');
  });

  it('says "Not required" when the org has no policy', () => {
    const items = byId(derivePosture({ user: baseUser(), recoveryCodes: null, activeSessions: null, sso: undefined, canManageOrg: true }));
    expect(items['org-mfa']).toMatchObject({ value: 'Not required', href: '/dashboard/settings?tab=organization' });
  });

  it('omits SSO when it cannot be read and the account has no SSO link', () => {
    const items = byId(derivePosture({ user: baseUser(), recoveryCodes: null, activeSessions: null, sso: undefined, canManageOrg: false }));
    expect(items.sso).toBeUndefined();
  });

  it('reports an SSO link on the account for a non-admin', () => {
    const user = baseUser({ authFactors: { hasPassword: false, passkeyCount: 0, hasTotp: false, providers: [{ type: 'sso', provider: 'okta', orgId: 'org-1' }] } });
    const items = byId(derivePosture({ user, recoveryCodes: null, activeSessions: null, sso: undefined, canManageOrg: false }));
    expect(items.sso.value).toBe('Linked to your account');
  });

  it('distinguishes configured, disabled and missing SSO for an admin', () => {
    const run = (sso: { enabled: boolean } | null) =>
      byId(derivePosture({ user: baseUser(), recoveryCodes: null, activeSessions: null, sso, canManageOrg: true })).sso.value;
    expect(run({ enabled: true })).toBe('Configured');
    expect(run({ enabled: false })).toBe('Configured, disabled');
    expect(run(null)).toBe('Not configured');
  });
});

describe('SecurityPostureStrip', () => {
  it('loads recovery codes, sessions and (for an IdP admin) SSO, each linking to its section', async () => {
    const user = baseUser({
      permissions: ['org:idp'],
      authFactors: { hasPassword: true, passkeyCount: 1, hasTotp: true, providers: [] },
    });
    render(<SecurityPostureStrip user={user} />);

    expect(await screen.findByTestId('posture-recovery')).toHaveTextContent('2 of 10 left');
    expect(screen.getByTestId('posture-recovery')).toHaveTextContent(/running low/i);
    expect(await screen.findByTestId('posture-sessions')).toHaveTextContent('3');
    expect(await screen.findByTestId('posture-sso')).toHaveTextContent('Configured');
    expect(screen.getByTestId('posture-passkeys')).toHaveAttribute('href', '/dashboard/security?tab=factors#passkeys');
    expect(screen.getByTestId('posture-sessions')).toHaveAttribute('href', '/dashboard/security?tab=sessions#devices');
  });

  it('does not read the IdP config without org:idp, nor TOTP status without an app', async () => {
    render(<SecurityPostureStrip user={baseUser()} />);
    await screen.findByTestId('posture-sessions');
    expect(api.getOwnOrgIdpConfig).not.toHaveBeenCalled();
    expect(api.getTotpStatus).not.toHaveBeenCalled();
    expect(screen.queryByTestId('posture-sso')).not.toBeInTheDocument();
  });

  it('leaves out an item whose read failed instead of guessing', async () => {
    api.listSessions.mockRejectedValue(new Error('boom'));
    render(<SecurityPostureStrip user={baseUser()} />);
    await waitFor(() => expect(api.listSessions).toHaveBeenCalled());
    expect(screen.queryByTestId('posture-sessions')).not.toBeInTheDocument();
    expect(screen.getByTestId('posture-password')).toBeInTheDocument();
  });
});

describe('OrgSecurityCard', () => {
  it('shows the requirement, members without a factor, SSO and the IdP-MFA declaration', async () => {
    render(<OrgSecurityCard orgId="org-1" canReadIdp />);
    expect(await screen.findByText('Required')).toBeInTheDocument();
    expect(screen.getByText('3 of 10')).toBeInTheDocument();
    expect(await screen.findByText('Configured (OIDC)')).toBeInTheDocument();
    expect(screen.getByText('IdP enforces MFA (declared)').nextSibling).toHaveTextContent('No');
  });

  it('does not read SSO without org:idp, and says so plainly when the plan lacks it', async () => {
    entitled = false;
    render(<OrgSecurityCard orgId="org-1" canReadIdp />);
    expect(await screen.findByText('Not on your plan')).toBeInTheDocument();
    expect(api.getOwnOrgIdpConfig).not.toHaveBeenCalled();
  });

  it('offers a retry when the policy cannot be loaded', async () => {
    api.getMfaPolicy.mockRejectedValue(new Error('nope'));
    render(<OrgSecurityCard orgId="org-1" canReadIdp={false} />);
    expect(await screen.findByText('nope')).toBeInTheDocument();
  });
});
