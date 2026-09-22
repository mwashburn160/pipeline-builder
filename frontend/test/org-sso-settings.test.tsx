// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org's own OIDC connection editor and its disconnect control.
 *
 *   - CREATE goes through PUT (the full body); an EXISTING connection is edited
 *     with PATCH carrying only what changed, and a save with no changes sends
 *     nothing at all.
 *   - Every write goes through ONE strong-factor step-up dialog, and its token
 *     rides the request.
 *   - A secret is demanded only until one is on file.
 *   - The redirect URI to register at the IdP comes from the SERVER, with a
 *     copy button.
 *   - Allowed domains are PICKED from the org's verified domains (no free text).
 *   - In the setup wizard: saving selects OIDC and a new connection starts
 *     disabled; domains and enabling are later steps.
 *   - Disconnect confirms first (in that same dialog), states what members will
 *     experience, and only then calls DELETE.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OrgSsoSettings } from '../src/components/settings/OrgSsoSettings';
import { SsoDisconnect } from '../src/components/settings/SsoDisconnect';
import { DOMAIN_SETTINGS_HREF } from '../src/components/sso/VerifiedDomainPicker';
import type { OrgIdpConfigDto } from '../src/types';

const putOwnOrgIdpConfig = jest.fn<AnyFn>();
const patchOwnOrgIdpConfig = jest.fn<AnyFn>();
const deleteOwnOrgIdpConfig = jest.fn<AnyFn>();
const getOwnOrgIdpSpInfo = jest.fn<AnyFn>();
const listOrgDomains = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    putOwnOrgIdpConfig: (...a: unknown[]) => putOwnOrgIdpConfig(...a),
    patchOwnOrgIdpConfig: (...a: unknown[]) => patchOwnOrgIdpConfig(...a),
    deleteOwnOrgIdpConfig: (...a: unknown[]) => deleteOwnOrgIdpConfig(...a),
    getOwnOrgIdpSpInfo: (...a: unknown[]) => getOwnOrgIdpSpInfo(...a),
    listOrgDomains: (...a: unknown[]) => listOrgDomains(...a),
  },
}));
// The step-up dialog is exercised in its own suite; here it confirms with a
// fixed token (and renders what it was given, so the consequences are visible).
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed, onClose, details, requireStrongFactor }: {
    onConfirmed: (t: string) => void; onClose: () => void; details?: React.ReactNode; requireStrongFactor?: boolean;
  }) => (
    <div data-testid="stepup-modal" data-strong={String(!!requireStrongFactor)}>
      {details}
      <button type="button" onClick={() => onConfirmed('tok')}>Verify</button>
      <button type="button" onClick={onClose}>Cancel</button>
    </div>
  ),
}));
const toastSuccess = jest.fn<AnyFn>();
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => ({ success: toastSuccess, error: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() })));

const stored: OrgIdpConfigDto = {
  orgId: 'org-1',
  protocol: 'oidc',
  provider: 'generic-oidc',
  clientId: 'cid',
  hasClientSecret: true,
  discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
  samlCertificates: [],
  samlSignAuthnRequests: false,
  samlEncryptAssertions: false,
  allowedEmailDomains: [],
  enabled: true,
  ssoRequired: false,
  updatedAt: '2026-09-01T00:00:00Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  putOwnOrgIdpConfig.mockResolvedValue({ success: true, data: { config: stored } });
  patchOwnOrgIdpConfig.mockResolvedValue({ success: true, data: { config: { ...stored, enabled: false } } });
  deleteOwnOrgIdpConfig.mockResolvedValue({ success: true, data: {} });
  getOwnOrgIdpSpInfo.mockResolvedValue({ success: true, data: { sp: { oidcRedirectUri: 'https://pb.public/auth/sso/org-1/callback' } } });
  // No verified domains by default: the picker then offers nothing to tick.
  listOrgDomains.mockResolvedValue({ success: true, data: { domains: [], entitled: true } });
});

describe('OrgSsoSettings', () => {
  it('creates a new connection with PUT, secret included', async () => {
    const onSaved = jest.fn<AnyFn>();
    render(<OrgSsoSettings orgId="org-1" config={null} readOnly={false} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'cid' } });
    fireEvent.change(screen.getByLabelText(/Client Secret/), { target: { value: 's3cret' } });
    fireEvent.change(screen.getByLabelText('Discovery URL'), { target: { value: stored.discoveryUrl } });

    fireEvent.click(screen.getByRole('button', { name: /Create SSO config/i }));
    // Nothing is sent until the strong factor is given.
    expect(screen.getByTestId('stepup-modal')).toHaveAttribute('data-strong', 'true');
    expect(putOwnOrgIdpConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(putOwnOrgIdpConfig).toHaveBeenCalled());

    const [orgId, body, token] = putOwnOrgIdpConfig.mock.calls[0] as [string, Record<string, unknown>, string];
    expect(orgId).toBe('org-1');
    expect(token).toBe('tok');
    expect(body).toMatchObject({ provider: 'generic-oidc', clientId: 'cid', clientSecret: 's3cret', discoveryUrl: stored.discoveryUrl });
    expect(patchOwnOrgIdpConfig).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith(stored);
  });

  it('refuses to create without a secret', async () => {
    render(<OrgSsoSettings orgId="org-1" config={null} readOnly={false} onSaved={jest.fn<AnyFn>()} />);
    expect(screen.getByRole('button', { name: /Create SSO config/i })).toBeDisabled();
  });

  it('edits an existing connection with PATCH, sending only the changed field (no secret)', async () => {
    const onSaved = jest.fn<AnyFn>();
    render(<OrgSsoSettings orgId="org-1" config={stored} readOnly={false} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enabled' }));

    fireEvent.click(screen.getByRole('button', { name: /Save SSO settings/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(patchOwnOrgIdpConfig).toHaveBeenCalled());

    expect(patchOwnOrgIdpConfig).toHaveBeenCalledWith('org-1', { enabled: false }, 'tok');
    expect(putOwnOrgIdpConfig).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith({ ...stored, enabled: false });
  });

  it('sends a typed secret as a rotation', async () => {
    render(<OrgSsoSettings orgId="org-1" config={stored} readOnly={false} onSaved={jest.fn<AnyFn>()} />);
    fireEvent.change(screen.getByLabelText(/Client Secret/), { target: { value: 'rotated' } });
    fireEvent.click(screen.getByRole('button', { name: /Save SSO settings/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(patchOwnOrgIdpConfig).toHaveBeenCalledWith('org-1', { clientSecret: 'rotated' }, 'tok'));
  });

  it('sends nothing when nothing changed', async () => {
    render(<OrgSsoSettings orgId="org-1" config={stored} readOnly={false} onSaved={jest.fn<AnyFn>()} />);
    fireEvent.click(screen.getByRole('button', { name: /Save SSO settings/i }));

    expect(await screen.findByText(/No changes to save/i)).toBeInTheDocument();
    // Not even a step-up prompt for a no-op.
    expect(screen.queryByTestId('stepup-modal')).not.toBeInTheDocument();
    expect(patchOwnOrgIdpConfig).not.toHaveBeenCalled();
    expect(putOwnOrgIdpConfig).not.toHaveBeenCalled();
  });

  it('shows the SERVER\'s redirect URI with a copy button', async () => {
    render(<OrgSsoSettings orgId="org-1" config={stored} readOnly={false} onSaved={jest.fn<AnyFn>()} />);
    expect(await screen.findByText('https://pb.public/auth/sso/org-1/callback')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy to clipboard/i })).toBeInTheDocument();
  });

  it('picks allowed domains from the VERIFIED ones only, and sends the selection', async () => {
    listOrgDomains.mockResolvedValue({
      success: true,
      data: { entitled: true, domains: [
        { id: 'd1', domain: 'acme.com', verified: true, autoJoin: 'off' },
        { id: 'd2', domain: 'pending.com', verified: false, autoJoin: 'off' },
      ] },
    });
    render(<OrgSsoSettings orgId="org-1" config={stored} readOnly={false} onSaved={jest.fn<AnyFn>()} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'acme.com' }));
    expect(screen.queryByRole('checkbox', { name: 'pending.com' })).not.toBeInTheDocument();
    // No free-text domain field any more.
    expect(screen.queryByPlaceholderText(/example\.com, acme\.io/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Save SSO settings/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(patchOwnOrgIdpConfig).toHaveBeenCalledWith('org-1', { allowedEmailDomains: ['acme.com'] }, 'tok'));
  });

  it('links to domain verification when the org has no verified domain', async () => {
    render(<OrgSsoSettings orgId="org-1" config={stored} readOnly={false} onSaved={jest.fn<AnyFn>()} />);
    // …at the "Email domains" CARD, not just the tab it is the sixth of.
    expect(await screen.findByRole('link', { name: /verify a domain/i }))
      .toHaveAttribute('href', DOMAIN_SETTINGS_HREF);
    expect(DOMAIN_SETTINGS_HREF).toContain('#email-domains');
  });

  it('in the wizard: selects OIDC, creates the connection DISABLED, and leaves domains/enabling to later steps', async () => {
    render(<OrgSsoSettings orgId="org-1" config={null} readOnly={false} onSaved={jest.fn<AnyFn>()} wizard={{ presetProvider: 'cognito', submitLabel: 'Save and continue' }} />);
    expect(screen.getByLabelText('Provider')).toHaveValue('cognito');
    expect(screen.queryByText('Enabled')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'cid' } });
    fireEvent.change(screen.getByLabelText(/Client Secret/), { target: { value: 's' } });
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'us-east-1' } });
    fireEvent.change(screen.getByLabelText('User Pool ID'), { target: { value: 'us-east-1_abc' } });
    fireEvent.click(screen.getByRole('button', { name: /Save and continue/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(putOwnOrgIdpConfig).toHaveBeenCalled());
    const body = putOwnOrgIdpConfig.mock.calls[0][1] as Record<string, unknown>;
    expect(body).toMatchObject({ protocol: 'oidc', provider: 'cognito', enabled: false });
    expect(body).not.toHaveProperty('allowedEmailDomains');
  });

  it('resets to the empty create form when the connection goes away', () => {
    const { rerender } = render(<OrgSsoSettings orgId="org-1" config={stored} readOnly={false} onSaved={jest.fn<AnyFn>()} />);
    expect(screen.getByLabelText('Client ID')).toHaveValue('cid');

    rerender(<OrgSsoSettings orgId="org-1" config={null} readOnly={false} onSaved={jest.fn<AnyFn>()} />);
    expect(screen.getByLabelText('Client ID')).toHaveValue('');
    expect(screen.getByRole('button', { name: /Create SSO config/i })).toBeInTheDocument();
  });
});

describe('SsoDisconnect', () => {
  it('confirms with the consequences before deleting', async () => {
    const onDisconnected = jest.fn<AnyFn>();
    render(<SsoDisconnect orgId="org-1" config={stored} readOnly={false} onDisconnected={onDisconnected} />);

    fireEvent.click(screen.getByRole('button', { name: /Disconnect SSO/i }));
    expect(screen.getByText(/fall back to their other sign-in methods/i)).toBeInTheDocument();
    expect(deleteOwnOrgIdpConfig).not.toHaveBeenCalled();

    expect(screen.getByTestId('stepup-modal')).toHaveAttribute('data-strong', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(deleteOwnOrgIdpConfig).toHaveBeenCalledWith('org-1', 'tok'));
    expect(onDisconnected).toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith('SSO disconnected');
  });

  it('cancelling deletes nothing', () => {
    render(<SsoDisconnect orgId="org-1" config={stored} readOnly={false} onDisconnected={jest.fn<AnyFn>()} />);
    fireEvent.click(screen.getByRole('button', { name: /Disconnect SSO/i }));
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(deleteOwnOrgIdpConfig).not.toHaveBeenCalled();
  });

  it('keeps the connection and says why when the delete fails', async () => {
    deleteOwnOrgIdpConfig.mockRejectedValue(new Error('step-up refused'));
    const onDisconnected = jest.fn<AnyFn>();
    render(<SsoDisconnect orgId="org-1" config={stored} readOnly={false} onDisconnected={onDisconnected} />);
    fireEvent.click(screen.getByRole('button', { name: /Disconnect SSO/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByText(/step-up refused/)).toBeInTheDocument();
    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it('is disabled for a read-only session', () => {
    render(<SsoDisconnect orgId="org-1" config={stored} readOnly onDisconnected={jest.fn<AnyFn>()} />);
    expect(screen.getByRole('button', { name: /Disconnect SSO/i })).toBeDisabled();
  });
});
