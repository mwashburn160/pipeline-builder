// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The SSO setup wizard and what surrounds it (components/sso/*):
 *   - the six steps in order: protocol + preset → SP values from the server →
 *     IdP details → verified domains → test connection → enable / require SSO;
 *     steps after the details are locked until a connection exists;
 *   - a preset pre-fills what it knows (SAML attribute names, the OIDC provider);
 *   - TEST CONNECTION opens a popup, accepts the result only from our own origin
 *     and only for its own state, and shows the dry-run report;
 *   - "SSO required" stays locked until the connection is enabled AND a test has
 *     passed, and switching it goes through the strong step-up;
 *   - the configured-org summary routes Edit / Change / Resume to the right step;
 *   - the SAML landing page hands a `?test=` state back instead of signing in.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { SsoSetupWizard, resumeStep } from '../src/components/sso/SsoSetupWizard';
import { SsoStatusSummary } from '../src/components/sso/SsoStatusSummary';
import { SsoRequiredToggle, ssoRequiredBlocker } from '../src/components/sso/SsoRequiredToggle';
import type { OrgIdpConfigDto } from '../src/types';

jest.mock('@/lib/api', () => {
  const api = {
    getOwnOrgIdpSpInfo: jest.fn(),
    listOrgDomains: jest.fn(),
    putOwnOrgIdpConfig: jest.fn(),
    patchOwnOrgIdpConfig: jest.fn(),
    startSsoTest: jest.fn(),
    completeSsoTest: jest.fn(),
    importIdpMetadata: jest.fn(),
  };
  return { __esModule: true, default: api, api };
});
const api = jest.requireMock('@/lib/api').api as Record<string, jest.Mock>;
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed, onClose }: { onConfirmed: (t: string) => void; onClose: () => void }) => (
    <div data-testid="stepup-modal">
      <button type="button" onClick={() => onConfirmed('tok')}>Verify</button>
      <button type="button" onClick={onClose}>Cancel</button>
    </div>
  ),
}));

const SP = {
  entityId: 'https://pb.public/api/auth/sso/org-1/saml/metadata',
  acsUrl: 'https://pb.public/api/auth/sso/org-1/saml/acs',
  metadataUrl: 'https://pb.public/api/auth/sso/org-1/saml/metadata',
  sloUrl: 'https://pb.public/api/auth/sso/org-1/saml/slo',
  oidcRedirectUri: 'https://pb.public/auth/sso/org-1/callback',
  signingCertificate: 'SIGN',
  encryptionCertificate: 'ENC',
};

const CERT = `-----BEGIN CERTIFICATE-----\n${'A'.repeat(64)}\n-----END CERTIFICATE-----`;

const SAML: OrgIdpConfigDto = {
  orgId: 'org-1',
  protocol: 'saml',
  hasClientSecret: false,
  samlEntityId: 'https://idp.test/entity',
  samlSsoUrl: 'https://idp.test/sso',
  samlCertificates: [CERT],
  samlSignAuthnRequests: false,
  samlEncryptAssertions: false,
  allowedEmailDomains: [],
  enabled: false,
  ssoRequired: false,
  updatedAt: '2026-09-01T00:00:00Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  api.getOwnOrgIdpSpInfo.mockResolvedValue({ success: true, data: { sp: SP } });
  api.listOrgDomains.mockResolvedValue({ success: true, data: { entitled: true, domains: [{ id: 'd1', domain: 'acme.com', verified: true, autoJoin: 'off' }] } });
  api.putOwnOrgIdpConfig.mockResolvedValue({ success: true, data: { config: SAML } });
  api.patchOwnOrgIdpConfig.mockImplementation(async (_o: string, patch: Partial<OrgIdpConfigDto>) => ({ success: true, data: { config: { ...SAML, ...patch } } }));
});

/** The page's role: hold the config and hand saves back in. */
function Harness({ initial = null as OrgIdpConfigDto | null }) {
  const [config, setConfig] = useState<OrgIdpConfigDto | null>(initial);
  return <SsoSetupWizard orgId="org-1" config={config} readOnly={false} onSaved={setConfig} onDone={() => undefined} />;
}

describe('the wizard', () => {
  it('walks protocol → SP values → details, with later steps locked until a connection exists', async () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: /4\s*Domains/ })).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/SAML 2.0/));
    fireEvent.click(screen.getByLabelText('Microsoft Entra ID'));
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));

    // Step 2: the server's values, plus the provider's console pointers.
    expect(await screen.findByText(SP.acsUrl)).toBeInTheDocument();
    expect(screen.getByText(/Enterprise applications/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));

    // Step 3: the SAML form, pre-filled with Entra's attribute names.
    expect(screen.getByLabelText(/Email attribute/i)).toHaveValue('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress');
    expect(screen.queryByLabelText(/^Protocol$/)).not.toBeInTheDocument();
  });

  it('saves the details (created disabled) and moves on to the domains step', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText(/SAML 2.0/));
    fireEvent.click(screen.getByRole('button', { name: /3\s*Identity-provider details/ }));
    fireEvent.change(screen.getByLabelText(/Identity provider entity ID/i), { target: { value: SAML.samlEntityId } });
    fireEvent.change(screen.getByLabelText(/Identity provider SSO URL/i), { target: { value: SAML.samlSsoUrl } });
    fireEvent.change(screen.getByLabelText(/IdP signing|Signing certificate/i), { target: { value: CERT } });
    fireEvent.click(screen.getByRole('button', { name: /Save and continue/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(api.putOwnOrgIdpConfig).toHaveBeenCalled());
    expect(api.putOwnOrgIdpConfig.mock.calls[0][1]).toMatchObject({ protocol: 'saml', enabled: false });
    expect(await screen.findByRole('checkbox', { name: 'acme.com' })).toBeInTheDocument();
  });

  it('saves a domain pick through the step-up, then opens the test step', async () => {
    render(<Harness initial={SAML} />);
    fireEvent.click(screen.getByRole('button', { name: /4\s*Domains/ }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'acme.com' }));
    fireEvent.click(screen.getByRole('button', { name: /Save and continue/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(api.patchOwnOrgIdpConfig).toHaveBeenCalledWith('org-1', { allowedEmailDomains: ['acme.com'] }, 'tok'));
    expect(await screen.findByRole('button', { name: /^Test connection$/ })).toBeInTheDocument();
  });
});

describe('the wizard — keyboard and screen-reader', () => {
  it('names itself as a region', () => {
    render(<Harness initial={SAML} />);
    expect(screen.getByRole('region', { name: /single sign-on setup/i })).toBeInTheDocument();
  });

  it('announces each step from a live region that was already on the page', () => {
    render(<Harness initial={SAML} />);
    const live = screen.getByRole('status');
    expect(live).toHaveTextContent('Step 1 of 6: Protocol & provider');
    fireEvent.click(screen.getByRole('button', { name: /4\s*Domains/ }));
    expect(live).toHaveTextContent('Step 4 of 6: Domains');
  });

  it('moves focus to the new step\'s heading — steps 3 and 4 render no Next button', () => {
    render(<Harness initial={SAML} />);
    // Opening the wizard must not steal focus.
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(screen.getByRole('button', { name: /3\s*Identity-provider details/ }));
    expect(document.activeElement).toHaveTextContent('Step 3 of 6: Identity-provider details');
    fireEvent.click(screen.getByRole('button', { name: /4\s*Domains/ }));
    expect(document.activeElement).toHaveTextContent('Step 4 of 6: Domains');
  });

  it('the domains step cannot be submitted twice while the save is in flight', async () => {
    let release: (v: unknown) => void = () => undefined;
    api.patchOwnOrgIdpConfig.mockImplementation(() => new Promise((r) => { release = r; }));
    render(<Harness initial={SAML} />);
    fireEvent.click(screen.getByRole('button', { name: /4\s*Domains/ }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'acme.com' }));
    fireEvent.click(screen.getByRole('button', { name: /Save and continue/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    // The step-up dialog closes the moment it hands the token over; the button
    // must stay busy until the PATCH settles, or a second click sends it twice.
    await waitFor(() => expect(screen.getByRole('button', { name: /Save and continue/ })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Save and continue/ }));
    expect(api.patchOwnOrgIdpConfig).toHaveBeenCalledTimes(1);
    await act(async () => { release({ success: true, data: { config: SAML } }); });
  });
});

describe('test connection', () => {
  const popup = { location: { href: '' }, close: jest.fn() };
  beforeEach(() => {
    popup.location.href = '';
    window.open = jest.fn(() => popup as unknown as Window);
    api.startSsoTest.mockResolvedValue({ success: true, data: { url: 'https://idp.test/sso?SAMLRequest=x', state: 'ssotest.n.sig' } });
    api.completeSsoTest.mockResolvedValue({
      success: true,
      data: { report: {
        ok: true, protocol: 'saml', testedAt: '2026-09-19T10:00:00Z', recorded: true,
        identity: { email: 'ada@acme.com', name: 'Ada', subject: 'ada@acme.com', issuer: 'https://idp.test/entity', groups: ['Eng'] },
        mappings: { matchedGroups: ['Eng'], roles: [{ id: 'r1', name: 'Engineers' }] },
      } },
    });
  });

  const post = (data: unknown, origin = window.location.origin) =>
    act(async () => { window.dispatchEvent(new MessageEvent('message', { data, origin })); });

  it('runs the round trip in a popup and shows the dry-run report; the result unlocks "SSO required"', async () => {
    render(<Harness initial={{ ...SAML, enabled: true }} />);
    fireEvent.click(screen.getByRole('button', { name: /5\s*Test connection/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Test connection$/ })); });
    expect(popup.location.href).toBe('https://idp.test/sso?SAMLRequest=x');

    // A message from another origin, or for another test, is ignored.
    await post({ type: 'pb-sso-test', state: 'ssotest.n.sig' }, 'https://evil.test');
    await post({ type: 'pb-sso-test', state: 'ssotest.other.sig' });
    expect(api.completeSsoTest).not.toHaveBeenCalled();

    await post({ type: 'pb-sso-test', state: 'ssotest.n.sig' });
    await waitFor(() => expect(api.completeSsoTest).toHaveBeenCalledWith('org-1', { state: 'ssotest.n.sig' }));
    // Scoped to the report: the same sentence is also in the live region.
    expect(await screen.findByTestId('sso-test-report')).toHaveTextContent(/Test succeeded/);
    expect(screen.getByText(/Engineers \(from Eng\)/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /6\s*Enable/ }));
    expect(screen.getByRole('switch', { name: /Require single sign-on/ })).not.toBeDisabled();
  });

  it('explains a failed test in prose, never the raw reason code', async () => {
    api.completeSsoTest.mockResolvedValue({
      success: true,
      data: { report: { ok: false, protocol: 'saml', testedAt: '2026-09-19T10:00:00Z', reason: 'domain_not_verified', message: 'Not verified', recorded: true } },
    });
    render(<Harness initial={SAML} />);
    fireEvent.click(screen.getByRole('button', { name: /5\s*Test connection/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Test connection$/ })); });
    await post({ type: 'pb-sso-test', state: 'ssotest.n.sig' });
    expect(await screen.findByTestId('sso-test-report')).toHaveTextContent(/Test failed\./);
    expect(screen.getByTestId('sso-test-report')).not.toHaveTextContent('domain_not_verified');
    expect(screen.getByTestId('sso-test-report')).toHaveTextContent(/Verify the domain/);
  });

  it('announces the outcome through a live region that was already on the page', async () => {
    api.completeSsoTest.mockResolvedValue({
      success: true,
      data: { report: { ok: true, protocol: 'saml', testedAt: '2026-09-19T10:00:00Z', recorded: true, identity: { email: 'a@b.test', subject: 's', groups: [] } } },
    });
    render(<Harness initial={SAML} />);
    fireEvent.click(screen.getByRole('button', { name: /5\s*Test connection/ }));
    // The region exists — and is empty — before anything happens, which is what
    // makes the later text an announcement rather than a silent DOM insert.
    const live = screen.getByTestId('sso-test-connection').querySelector('[role="status"]')!;
    expect(live).toHaveTextContent('');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Test connection$/ })); });
    await post({ type: 'pb-sso-test', state: 'ssotest.n.sig' });
    await waitFor(() => expect(live).toHaveTextContent(/Test succeeded/));
  });

  it('says so when pop-ups are blocked, starting nothing', async () => {
    window.open = jest.fn(() => null);
    render(<Harness initial={SAML} />);
    fireEvent.click(screen.getByRole('button', { name: /5\s*Test connection/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Test connection$/ })); });
    // Once in the alert, once in the live region that announces it.
    expect(screen.getAllByText(/Allow pop-ups/)).toHaveLength(2);
    expect(api.startSsoTest).not.toHaveBeenCalled();
  });
});

describe('"SSO required"', () => {
  it('is locked until the connection is enabled and a test has passed on the current protocol', () => {
    expect(ssoRequiredBlocker(SAML)).toMatch(/Enable the connection/);
    expect(ssoRequiredBlocker({ ...SAML, enabled: true })).toMatch(/successful test/);
    expect(ssoRequiredBlocker({ ...SAML, enabled: true, lastTest: { at: 'x', ok: false, protocol: 'saml' } })).toMatch(/failed/);
    expect(ssoRequiredBlocker({ ...SAML, enabled: true, lastTest: { at: 'x', ok: true, protocol: 'oidc' } })).toMatch(/current protocol/);
    expect(ssoRequiredBlocker({ ...SAML, enabled: true, lastTest: { at: 'x', ok: true, protocol: 'saml' } })).toBeNull();
  });

  it('switches through the strong step-up and states the owner break-glass', async () => {
    const onSaved = jest.fn();
    render(<SsoRequiredToggle orgId="org-1" config={{ ...SAML, enabled: true, lastTest: { at: 'x', ok: true, protocol: 'saml' } }} readOnly={false} onSaved={onSaved} />);
    expect(screen.getByText(/Organization owners are always exempt/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: /Require single sign-on/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(api.patchOwnOrgIdpConfig).toHaveBeenCalledWith('org-1', { ssoRequired: true }, 'tok'));
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ ssoRequired: true }));
  });

  it('can always be switched off', () => {
    render(<SsoRequiredToggle orgId="org-1" config={{ ...SAML, ssoRequired: true }} readOnly={false} onSaved={jest.fn()} />);
    expect(screen.getByRole('switch', { name: /Require single sign-on/ })).not.toBeDisabled();
  });
});

describe('the configured-org summary', () => {
  it('shows the state and routes Edit / Change / Resume to the right wizard step', () => {
    const onEdit = jest.fn();
    render(<SsoStatusSummary orgId="org-1" config={SAML} readOnly={false} onSaved={jest.fn()} onEdit={onEdit} />);
    expect(screen.getByText('Disabled')).toBeInTheDocument();
    expect(screen.getByText('SSO optional')).toBeInTheDocument();
    expect(screen.getByText(/Not tested since the last change/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    expect(onEdit).toHaveBeenLastCalledWith(3);
    fireEvent.click(screen.getByRole('button', { name: /Change/ }));
    expect(onEdit).toHaveBeenLastCalledWith(4);
    fireEvent.click(screen.getByRole('button', { name: /Resume setup/ }));
    expect(onEdit).toHaveBeenLastCalledWith(5);
  });

  it('resumes at the enable step once a test has passed', () => {
    expect(resumeStep({ ...SAML, lastTest: { at: 'x', ok: true, protocol: 'saml' } })).toBe(6);
    expect(resumeStep(SAML)).toBe(5);
  });
});
