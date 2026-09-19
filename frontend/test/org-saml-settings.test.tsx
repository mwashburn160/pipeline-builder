// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SAML 2.0 connection editor (#4).
 *
 * Covers what the editor is actually responsible for, as opposed to what the
 * server re-checks anyway:
 *   - showing the service-provider values an administrator needs BEFORE the
 *     connection exists (otherwise configuring the IdP is a deadlock);
 *   - the protocol selector, and that saving here never sends the OIDC fields —
 *     the two editors share one config and must not wipe each other;
 *   - splitting a pasted certificate blob into certificates, and saying so when
 *     more than one is trusted (a rotation window is open);
 *   - refusing to submit a SAML config that could not sign anyone in.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OrgSamlSettings } from '../src/components/settings/OrgSamlSettings';
import type { OrgIdpConfigDto } from '../src/types';

const putOwnOrgIdpConfig = jest.fn();

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { putOwnOrgIdpConfig: (...a: unknown[]) => putOwnOrgIdpConfig(...a) },
}));

const CERT_A = `-----BEGIN CERTIFICATE-----\n${'A'.repeat(64)}\n${'B'.repeat(64)}\n-----END CERTIFICATE-----`;
const CERT_B = `-----BEGIN CERTIFICATE-----\n${'C'.repeat(64)}\n${'D'.repeat(64)}\n-----END CERTIFICATE-----`;

const samlConfig: OrgIdpConfigDto = {
  orgId: 'org-1',
  protocol: 'saml',
  hasClientSecret: false,
  samlEntityId: 'https://idp.example.com/saml/metadata',
  samlSsoUrl: 'https://idp.example.com/sso/saml',
  samlCertificates: [CERT_A],
  samlAttributes: { email: 'email', groups: 'groups' },
  samlSp: {
    entityId: 'https://pb.test/api/auth/sso/org-1/saml/metadata',
    acsUrl: 'https://pb.test/api/auth/sso/org-1/saml/acs',
    metadataUrl: 'https://pb.test/api/auth/sso/org-1/saml/metadata',
  },
  allowedEmailDomains: [],
  enabled: true,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  putOwnOrgIdpConfig.mockResolvedValue({ success: true, data: { config: samlConfig } });
});

describe('OrgSamlSettings', () => {
  it('shows the service-provider values before any config exists', () => {
    render(<OrgSamlSettings orgId="org-1" config={null} readOnly={false} />);
    // Derived from the page origin when the server has nothing stored yet — an
    // admin needs these to create the application at the IdP in the first place.
    expect(screen.getByText(/\/api\/auth\/sso\/org-1\/saml\/acs/)).toBeInTheDocument();
    expect(screen.getAllByText(/\/api\/auth\/sso\/org-1\/saml\/metadata/).length).toBeGreaterThan(0);
  });

  it('says the SAML fields are unused while the org is on OIDC', () => {
    render(<OrgSamlSettings orgId="org-1" config={{ ...samlConfig, protocol: 'oidc' }} readOnly={false} />);
    expect(screen.getByText(/signs in over OIDC/i)).toBeInTheDocument();
  });

  it('mirrors a stored SAML config into the form', () => {
    render(<OrgSamlSettings orgId="org-1" config={samlConfig} readOnly={false} />);
    expect(screen.getByLabelText(/Identity provider entity ID/i)).toHaveValue('https://idp.example.com/saml/metadata');
    expect(screen.getByLabelText(/Identity provider SSO URL/i)).toHaveValue('https://idp.example.com/sso/saml');
    expect(screen.getByLabelText(/Email attribute/i)).toHaveValue('email');
  });

  it('saves the protocol and the SAML fields, and never the OIDC ones', async () => {
    const onConfigChange = jest.fn();
    render(<OrgSamlSettings orgId="org-1" config={samlConfig} readOnly={false} onConfigChange={onConfigChange} />);

    fireEvent.click(screen.getByRole('button', { name: /Save SAML settings/i }));
    await waitFor(() => expect(putOwnOrgIdpConfig).toHaveBeenCalled());

    const [, payload] = putOwnOrgIdpConfig.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.protocol).toBe('saml');
    expect(payload.samlEntityId).toBe('https://idp.example.com/saml/metadata');
    expect(payload.samlCertificates).toEqual([CERT_A]);
    // The OIDC editor owns these; sending them here would clobber its connection.
    expect(payload).not.toHaveProperty('clientId');
    expect(payload).not.toHaveProperty('clientSecret');
    expect(payload).not.toHaveProperty('provider');
    expect(onConfigChange).toHaveBeenCalledWith(samlConfig);
  });

  it('splits a pasted blob into two certificates and warns that a rotation window is open', async () => {
    render(<OrgSamlSettings orgId="org-1" config={samlConfig} readOnly={false} />);
    fireEvent.change(screen.getByLabelText(/Signing certificate/i), {
      target: { value: `${CERT_B}\n\n${CERT_A}` },
    });

    expect(await screen.findByText(/rotation window is open/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Save SAML settings/i }));
    await waitFor(() => expect(putOwnOrgIdpConfig).toHaveBeenCalled());
    const [, payload] = putOwnOrgIdpConfig.mock.calls[0] as [string, Record<string, unknown>];
    // New first, outgoing second — both trusted until the IdP has cut over.
    expect(payload.samlCertificates).toEqual([CERT_B, CERT_A]);
  });

  it('refuses to save a SAML config with no certificate', async () => {
    render(<OrgSamlSettings orgId="org-1" config={samlConfig} readOnly={false} />);
    fireEvent.change(screen.getByLabelText(/Signing certificate/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Save SAML settings/i }));

    expect(await screen.findByText(/At least one signing certificate is required/i)).toBeInTheDocument();
    expect(putOwnOrgIdpConfig).not.toHaveBeenCalled();
  });

  it('refuses an SSO URL that is not https', async () => {
    render(<OrgSamlSettings orgId="org-1" config={samlConfig} readOnly={false} />);
    fireEvent.change(screen.getByLabelText(/Identity provider SSO URL/i), {
      target: { value: 'http://idp.example.com/sso/saml' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save SAML settings/i }));

    // The field's own hint also says "must use https", so match the error text.
    expect(await screen.findByText(/^The SSO URL must use https$/i)).toBeInTheDocument();
    expect(putOwnOrgIdpConfig).not.toHaveBeenCalled();
  });

  it('states that single logout is not supported', () => {
    render(<OrgSamlSettings orgId="org-1" config={samlConfig} readOnly={false} />);
    expect(screen.getByText(/Single logout is not supported/i)).toBeInTheDocument();
  });

  it('disables every control for a read-only (impersonated) session', () => {
    render(<OrgSamlSettings orgId="org-1" config={samlConfig} readOnly />);
    expect(screen.getByLabelText(/Identity provider entity ID/i)).toBeDisabled();
    expect(screen.getByRole('button', { name: /Save SAML settings/i })).toBeDisabled();
  });
});
