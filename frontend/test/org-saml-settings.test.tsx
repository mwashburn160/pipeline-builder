// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SAML 2.0 connection editor.
 *
 * Covers what the editor is actually responsible for, as opposed to what the
 * server re-checks anyway:
 *   - showing the service-provider values an administrator needs BEFORE the
 *     connection exists (otherwise configuring the IdP is a deadlock) — from the
 *     SERVER's sp-info, never the browser's origin, each with a copy button;
 *   - importing IdP metadata to pre-fill the form (nothing saved until Save);
 *   - the SLO URL and the sign-requests / encrypted-assertions switches;
 *   - wizard mode: no protocol selector, SAML selected, a new connection
 *     created DISABLED;
 *   - the protocol selector, and that saving here never sends the OIDC fields —
 *     the two editors share one config and must not wipe each other;
 *   - CREATE with PUT when no connection exists, otherwise PATCH only what
 *     changed (and nothing at all when nothing did);
 *   - splitting a pasted certificate blob into certificates, and saying so when
 *     more than one is trusted (a rotation window is open);
 *   - refusing to submit a SAML config that could not sign anyone in.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OrgSamlSettings } from '../src/components/settings/OrgSamlSettings';
import type { OrgIdpConfigDto } from '../src/types';

const putOwnOrgIdpConfig = jest.fn<AnyFn>();
const patchOwnOrgIdpConfig = jest.fn<AnyFn>();
const getOwnOrgIdpSpInfo = jest.fn<AnyFn>();
const importIdpMetadata = jest.fn<AnyFn>();

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    putOwnOrgIdpConfig: (...a: unknown[]) => putOwnOrgIdpConfig(...a),
    patchOwnOrgIdpConfig: (...a: unknown[]) => patchOwnOrgIdpConfig(...a),
    getOwnOrgIdpSpInfo: (...a: unknown[]) => getOwnOrgIdpSpInfo(...a),
    importIdpMetadata: (...a: unknown[]) => importIdpMetadata(...a),
  },
}));

const SP = {
  entityId: 'https://pb.public/api/auth/sso/org-1/saml/metadata',
  acsUrl: 'https://pb.public/api/auth/sso/org-1/saml/acs',
  metadataUrl: 'https://pb.public/api/auth/sso/org-1/saml/metadata',
  sloUrl: 'https://pb.public/api/auth/sso/org-1/saml/slo',
  oidcRedirectUri: 'https://pb.public/auth/sso/org-1/callback',
  signingCertificate: 'SIGNING-CERT',
  encryptionCertificate: 'ENCRYPTION-CERT',
};

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
  samlSignAuthnRequests: false,
  samlEncryptAssertions: false,
  allowedEmailDomains: [],
  enabled: true,
  ssoRequired: false,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  putOwnOrgIdpConfig.mockResolvedValue({ success: true, data: { config: samlConfig } });
  patchOwnOrgIdpConfig.mockResolvedValue({ success: true, data: { config: samlConfig } });
  getOwnOrgIdpSpInfo.mockResolvedValue({ success: true, data: { sp: SP } });
});

const noop = () => undefined;

describe('OrgSamlSettings', () => {
  it('shows the SERVER\'s service-provider values, with copy buttons, before any config exists', async () => {
    render(<OrgSamlSettings orgId="org-1" config={null} readOnly={false} onSaved={noop} />);
    // From sp-info (the deployment's public URL) — never window.location, which
    // differs whenever the dashboard is reached through another hostname.
    expect(await screen.findByText(SP.acsUrl)).toBeInTheDocument();
    expect(screen.getByText(SP.sloUrl)).toBeInTheDocument();
    expect(screen.getAllByText(SP.metadataUrl).length).toBe(2); // entity ID + metadata URL
    expect(getOwnOrgIdpSpInfo).toHaveBeenCalledWith('org-1', expect.anything());
    // Every value copyable — the metadata URL included.
    expect(screen.getAllByRole('button', { name: /copy to clipboard/i }).length).toBeGreaterThanOrEqual(6);
  });

  it('pre-fills the form from imported IdP metadata, saving nothing until Save', async () => {
    importIdpMetadata.mockResolvedValue({
      success: true,
      data: { metadata: { entityId: 'https://idp.new/entity', ssoUrl: 'https://idp.new/sso', sloUrl: 'https://idp.new/slo', certificates: [CERT_B], wantsSignedRequests: true } },
    });
    render(<OrgSamlSettings orgId="org-1" config={samlConfig} readOnly={false} onSaved={noop} />);
    fireEvent.change(screen.getByLabelText('Metadata URL'), { target: { value: 'https://idp.new/metadata' } });
    fireEvent.click(screen.getByRole('button', { name: /Import metadata/i }));

    await waitFor(() => expect(screen.getByLabelText(/Identity provider entity ID/i)).toHaveValue('https://idp.new/entity'));
    expect(importIdpMetadata).toHaveBeenCalledWith('org-1', { url: 'https://idp.new/metadata' });
    expect(screen.getByLabelText(/Identity provider SSO URL/i)).toHaveValue('https://idp.new/sso');
    expect(screen.getByLabelText(/single-logout URL/i)).toHaveValue('https://idp.new/slo');
    expect(screen.getByRole('checkbox', { name: /Sign AuthnRequests/i })).toBeChecked();
    expect(patchOwnOrgIdpConfig).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Save SAML settings/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(patchOwnOrgIdpConfig).toHaveBeenCalled());
    const [, patch] = patchOwnOrgIdpConfig.mock.calls[0] as [string, Record<string, unknown>];
    expect(patch).toMatchObject({
      samlEntityId: 'https://idp.new/entity',
      samlSsoUrl: 'https://idp.new/sso',
      samlSloUrl: 'https://idp.new/slo',
      samlCertificates: [CERT_B],
      samlSignAuthnRequests: true,
    });
  });

  it('sends the encrypted-assertions switch', async () => {
    render(<OrgSamlSettings orgId="org-1" config={samlConfig} readOnly={false} onSaved={noop} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /encrypts assertions/i }));
    fireEvent.click(screen.getByRole('button', { name: /Save SAML settings/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(patchOwnOrgIdpConfig).toHaveBeenCalled());
    expect(patchOwnOrgIdpConfig.mock.calls[0][1]).toEqual({ samlEncryptAssertions: true });
  });

  it('in the wizard: no protocol selector, SAML selected, a new connection created DISABLED', async () => {
    render(<OrgSamlSettings orgId="org-1" config={null} readOnly={false} onSaved={noop} wizard={{ presetAttributes: { email: 'mail' }, submitLabel: 'Save and continue' }} />);
    expect(screen.queryByLabelText(/^Protocol$/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Email attribute/i)).toHaveValue('mail');
    fireEvent.change(screen.getByLabelText(/Identity provider entity ID/i), { target: { value: 'https://idp.example.com/saml/metadata' } });
    fireEvent.change(screen.getByLabelText(/Identity provider SSO URL/i), { target: { value: 'https://idp.example.com/sso/saml' } });
    fireEvent.change(screen.getByLabelText(/Signing certificate/i), { target: { value: CERT_A } });
    fireEvent.click(screen.getByRole('button', { name: /Save and continue/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(putOwnOrgIdpConfig).toHaveBeenCalled());
    expect(putOwnOrgIdpConfig.mock.calls[0][1]).toMatchObject({ protocol: 'saml', enabled: false });
  });

  it('says the SAML fields are unused while the org is on OIDC', () => {
    render(<OrgSamlSettings orgId="org-1" config={{ ...samlConfig, protocol: 'oidc' }} readOnly={false} onSaved={noop} />);
    expect(screen.getByText(/signs in over OIDC/i)).toBeInTheDocument();
  });

  it('mirrors a stored SAML config into the form', () => {
    render(<OrgSamlSettings orgId="org-1" config={samlConfig} readOnly={false} onSaved={noop} />);
    expect(screen.getByLabelText(/Identity provider entity ID/i)).toHaveValue('https://idp.example.com/saml/metadata');
    expect(screen.getByLabelText(/Identity provider SSO URL/i)).toHaveValue('https://idp.example.com/sso/saml');
    expect(screen.getByLabelText(/Email attribute/i)).toHaveValue('email');
  });

  it('creates a new connection with PUT: the protocol and the SAML fields, never the OIDC ones', async () => {
    const onSaved = jest.fn<AnyFn>();
    render(<OrgSamlSettings orgId="org-1" config={null} readOnly={false} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText(/Protocol/i), { target: { value: 'saml' } });
    fireEvent.change(screen.getByLabelText(/Identity provider entity ID/i), { target: { value: 'https://idp.example.com/saml/metadata' } });
    fireEvent.change(screen.getByLabelText(/Identity provider SSO URL/i), { target: { value: 'https://idp.example.com/sso/saml' } });
    fireEvent.change(screen.getByLabelText(/Signing certificate/i), { target: { value: CERT_A } });

    fireEvent.click(screen.getByRole('button', { name: /Save SAML settings/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(putOwnOrgIdpConfig).toHaveBeenCalled());

    const [, payload] = putOwnOrgIdpConfig.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.protocol).toBe('saml');
    expect(payload.samlEntityId).toBe('https://idp.example.com/saml/metadata');
    expect(payload.samlCertificates).toEqual([CERT_A]);
    // The OIDC editor owns these; sending them here would clobber its connection.
    expect(payload).not.toHaveProperty('clientId');
    expect(payload).not.toHaveProperty('clientSecret');
    expect(payload).not.toHaveProperty('provider');
    expect(patchOwnOrgIdpConfig).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith(samlConfig);
  });

  it('edits an existing connection with PATCH, sending only what changed', async () => {
    render(<OrgSamlSettings orgId="org-1" config={samlConfig} readOnly={false} onSaved={noop} />);
    fireEvent.change(screen.getByLabelText(/Name attribute/i), { target: { value: 'displayName' } });

    fireEvent.click(screen.getByRole('button', { name: /Save SAML settings/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(patchOwnOrgIdpConfig).toHaveBeenCalled());

    const [, patch, token] = patchOwnOrgIdpConfig.mock.calls[0] as [string, Record<string, unknown>, string];
    expect(patch).toEqual({ samlAttributes: { email: 'email', name: 'displayName', groups: 'groups' } });
    expect(token).toBe('tok');
    expect(putOwnOrgIdpConfig).not.toHaveBeenCalled();
  });

  it('sends nothing when nothing changed', async () => {
    render(<OrgSamlSettings orgId="org-1" config={samlConfig} readOnly={false} onSaved={noop} />);
    fireEvent.click(screen.getByRole('button', { name: /Save SAML settings/i }));

    expect(await screen.findByText(/No changes to save/i)).toBeInTheDocument();
    expect(patchOwnOrgIdpConfig).not.toHaveBeenCalled();
    expect(putOwnOrgIdpConfig).not.toHaveBeenCalled();
  });

  it('splits a pasted blob into two certificates and warns that a rotation window is open', async () => {
    render(<OrgSamlSettings orgId="org-1" config={samlConfig} readOnly={false} onSaved={noop} />);
    fireEvent.change(screen.getByLabelText(/Signing certificate/i), {
      target: { value: `${CERT_B}\n\n${CERT_A}` },
    });

    expect(await screen.findByText(/rotation window is open/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Save SAML settings/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(patchOwnOrgIdpConfig).toHaveBeenCalled());
    const [, payload] = patchOwnOrgIdpConfig.mock.calls[0] as [string, Record<string, unknown>];
    // New first, outgoing second — both trusted until the IdP has cut over.
    expect(payload.samlCertificates).toEqual([CERT_B, CERT_A]);
  });

  it('refuses to save a SAML config with no certificate', async () => {
    render(<OrgSamlSettings orgId="org-1" config={samlConfig} readOnly={false} onSaved={noop} />);
    fireEvent.change(screen.getByLabelText(/Signing certificate/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Save SAML settings/i }));

    expect(await screen.findByText(/At least one signing certificate is required/i)).toBeInTheDocument();
    expect(putOwnOrgIdpConfig).not.toHaveBeenCalled();
    expect(patchOwnOrgIdpConfig).not.toHaveBeenCalled();
  });

  it('refuses an SSO URL that is not https', async () => {
    render(<OrgSamlSettings orgId="org-1" config={samlConfig} readOnly={false} onSaved={noop} />);
    fireEvent.change(screen.getByLabelText(/Identity provider SSO URL/i), {
      target: { value: 'http://idp.example.com/sso/saml' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save SAML settings/i }));

    // The field's own hint also says "must use https", so match the error text.
    expect(await screen.findByText(/^The SSO URL must use https$/i)).toBeInTheDocument();
    expect(putOwnOrgIdpConfig).not.toHaveBeenCalled();
    expect(patchOwnOrgIdpConfig).not.toHaveBeenCalled();
  });

  it('refuses a non-https single-logout URL', async () => {
    render(<OrgSamlSettings orgId="org-1" config={samlConfig} readOnly={false} onSaved={noop} />);
    fireEvent.change(screen.getByLabelText(/single-logout URL/i), { target: { value: 'http://idp.example.com/slo' } });
    fireEvent.click(screen.getByRole('button', { name: /Save SAML settings/i }));
    expect(await screen.findByText(/^The single-logout URL must use https$/i)).toBeInTheDocument();
    expect(patchOwnOrgIdpConfig).not.toHaveBeenCalled();
  });

  it('disables every control for a read-only (impersonated) session', () => {
    render(<OrgSamlSettings orgId="org-1" config={samlConfig} readOnly onSaved={noop} />);
    expect(screen.getByLabelText(/Identity provider entity ID/i)).toBeDisabled();
    expect(screen.getByRole('button', { name: /Save SAML settings/i })).toBeDisabled();
  });
});
