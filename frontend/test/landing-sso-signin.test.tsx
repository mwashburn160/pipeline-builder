// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Enterprise SSO on the sign-in card.
 *
 * An org can configure OIDC/SAML, group mappings and SCIM and still have nobody
 * able to sign in with it unless the login page offers the flow — so this suite
 * pins the two ways it is offered and, just as importantly, what is NOT offered
 * alongside it:
 *
 *   - DISCOVERY: an email-shaped identifier is checked against the backend's
 *     domain hint (`POST /auth/sso/discover`, `{ sso, required }`). A domain
 *     whose org REQUIRES SSO loses the password field, the passkey button and
 *     the social buttons — the backend refuses every one of them with
 *     SSO_REQUIRED — except through the OWNER break-glass link, which gives the
 *     password path back (the server decides who is an owner). A domain whose
 *     org merely OFFERS SSO keeps the password form and gains an SSO button.
 *   - A REFUSED PASSWORD: discovery is a hint and can miss (a username, a
 *     blocked request). The 403 names the org, so the same SSO action appears —
 *     and it can name the provider, which discovery deliberately never reveals.
 *
 * The lookup is rate-conscious on purpose: it is debounced, skipped entirely for
 * a username, and asked once per domain.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

const login = jest.fn<AnyFn>();
const completeMfaLogin = jest.fn<AnyFn>();
const loginWithPasskey = jest.fn<AnyFn>();
jest.mock('@/hooks/useAuth', () => ({
  __esModule: true,
  useAuth: () => ({ login, completeMfaLogin, loginWithPasskey, isSubmitting: false }),
}));
jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ query: {}, push: jest.fn<AnyFn>() }),
}));
jest.mock('@/lib/api', () => {
  const api = {
    listOAuthProviders: jest.fn<AnyFn>(),
    discoverSso: jest.fn<AnyFn>(),
    startSsoByEmail: jest.fn<AnyFn>(),
    getSsoUrl: jest.fn<AnyFn>(),
  };
  return { __esModule: true, default: api, api };
});
const mockApi = jest.requireMock<Record<string, unknown>>('@/lib/api').api as Record<
  'listOAuthProviders' | 'discoverSso' | 'startSsoByEmail' | 'getSsoUrl', jest.Mock<AnyFn>
>;
jest.mock('framer-motion', () => ({
  __esModule: true,
  motion: new Proxy({}, { get: () => ({ children }: { children?: React.ReactNode }) => <div>{children}</div> }),
}));
jest.mock('@/lib/passkeys', () => ({
  __esModule: true,
  browserSupportsWebAuthn: () => true,
  browserSupportsWebAuthnAutofill: async () => false,
  cancelPasskeyCeremony: jest.fn<AnyFn>(),
}));

import LandingPage from '../src/components/landing/LandingPage';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

// Starting SSO hands the whole window to the IdP. jsdom implements only
// hash navigation, so the stubbed authorize URLs are fragments (the same trick
// the OAuth callback suite uses) and `location.hash` is where the redirect
// shows up.
const IDP_OIDC_URL = '#idp-oidc-authorize';
const IDP_SAML_URL = '#idp-saml-authorize';

/** Type an identifier and tab away — blur runs the lookup at once, without
 *  waiting out the debounce.
 *
 *  The field is re-queried between the two events on purpose: the framer-motion
 *  stub above hands back a fresh component type on every render, so the whole
 *  card remounts and a node held across a render is detached. */
async function enterIdentifier(value: string) {
  const field = () => screen.getByLabelText('Email or username');
  fireEvent.change(field(), { target: { value } });
  await act(async () => { fireEvent.blur(field()); });
}

const ssoButton = () => screen.queryByRole('button', { name: /^continue with/i });

beforeEach(async () => {
  jest.clearAllMocks();
  window.location.hash = '';
  mockApi.listOAuthProviders.mockResolvedValue({ data: { providers: ['google'] } });
  mockApi.discoverSso.mockResolvedValue({ data: { sso: false, required: false } });
  mockApi.startSsoByEmail.mockResolvedValue({ data: { url: IDP_OIDC_URL, state: 's1' } });
  mockApi.getSsoUrl.mockResolvedValue({ data: { url: IDP_SAML_URL, state: 'r1' } });
  await act(async () => { render(<LandingPage />); });
});

describe('domain discovery', () => {
  it('replaces the password field with an SSO action for a federated domain', async () => {
    mockApi.discoverSso.mockResolvedValue({ data: { sso: true, required: true } });
    await enterIdentifier('ada@corp.example');

    expect(mockApi.discoverSso).toHaveBeenCalledWith('ada@corp.example');
    expect(ssoButton()).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    // …and the two other ways into an account, both of which the backend
    // refuses for a covered user.
    expect(screen.queryByRole('button', { name: /sign in with a passkey/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in with google/i })).not.toBeInTheDocument();
  });

  it('names the domain rather than the org — discovery is told nothing else', async () => {
    mockApi.discoverSso.mockResolvedValue({ data: { sso: true, required: true } });
    await enterIdentifier('ada@corp.example');

    expect(screen.getByText(/corp\.example is managed by your organization/i)).toBeInTheDocument();
    expect(ssoButton()).toHaveTextContent(/continue with single sign-on/i);
  });

  it('keeps the password path for a domain nobody federates', async () => {
    await enterIdentifier('ada@personal.example');

    expect(mockApi.discoverSso).toHaveBeenCalled();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(ssoButton()).not.toBeInTheDocument();
  });

  it('gives the password back when the identifier moves off the federated domain', async () => {
    mockApi.discoverSso.mockResolvedValueOnce({ data: { sso: true, required: true } });
    await enterIdentifier('ada@corp.example');
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();

    mockApi.discoverSso.mockResolvedValue({ data: { sso: false, required: false } });
    await enterIdentifier('ada@personal.example');
    await waitFor(() => expect(screen.getByLabelText('Password')).toBeInTheDocument());
  });

  it('never asks about a username — there is no domain to ask about', async () => {
    await enterIdentifier('ada');
    expect(mockApi.discoverSso).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('asks once per domain, however many addresses are typed on it', async () => {
    mockApi.discoverSso.mockResolvedValue({ data: { sso: true, required: true } });
    await enterIdentifier('ada@corp.example');
    await enterIdentifier('grace@corp.example');

    expect(mockApi.discoverSso).toHaveBeenCalledTimes(1);
    expect(ssoButton()).toBeInTheDocument();
  });

  it('falls back to the password when the lookup fails — a hint never blocks a sign-in', async () => {
    mockApi.discoverSso.mockRejectedValue(Object.assign(new Error('Too many requests'), { statusCode: 429 }));
    await enterIdentifier('ada@corp.example');

    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(ssoButton()).not.toBeInTheDocument();
  });
});

describe('SSO offered but not required, and the owner break-glass', () => {
  it('keeps the password form and adds a single sign-on button when SSO is optional', async () => {
    mockApi.discoverSso.mockResolvedValue({ data: { sso: true, required: false } });
    await enterIdentifier('ada@corp.example');

    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    const offered = screen.getByRole('button', { name: /continue with single sign-on/i });
    await act(async () => { fireEvent.click(offered); });
    expect(mockApi.startSsoByEmail).toHaveBeenCalledWith('ada@corp.example');
    expect(window.location.hash).toBe(IDP_OIDC_URL);
  });

  it('gives an owner the password path back on a REQUIRED domain, still offering SSO', async () => {
    mockApi.discoverSso.mockResolvedValue({ data: { sso: true, required: true } });
    await enterIdentifier('owner@corp.example');
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /organization owner\? sign in with your password/i })); });
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue with single sign-on/i })).toBeInTheDocument();
  });

  it('forgets the break-glass choice when a different identifier is typed', async () => {
    mockApi.discoverSso.mockResolvedValue({ data: { sso: true, required: true } });
    await enterIdentifier('owner@corp.example');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /organization owner/i })); });
    await enterIdentifier('member@corp.example');
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });
});

describe('starting the flow', () => {
  it('sends the browser to the IdP, resolving the org from the address', async () => {
    mockApi.discoverSso.mockResolvedValue({ data: { sso: true, required: true } });
    await enterIdentifier('ada@corp.example');
    await act(async () => { fireEvent.click(ssoButton()!); });

    expect(mockApi.startSsoByEmail).toHaveBeenCalledWith('ada@corp.example');
    // The org id never reaches this page — the redirect the backend built does.
    expect(window.location.hash).toBe(IDP_OIDC_URL);
    expect(login).not.toHaveBeenCalled();
  });

  it('reports a provider that cannot be reached, and stays on the page', async () => {
    mockApi.discoverSso.mockResolvedValue({ data: { sso: true, required: true } });
    mockApi.startSsoByEmail.mockRejectedValue(new Error('Could not load the identity provider configuration'));
    await enterIdentifier('ada@corp.example');
    await act(async () => { fireEvent.click(ssoButton()!); });

    expect(await screen.findByText(/could not load the identity provider configuration/i)).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(ssoButton()).toBeInTheDocument();
  });
});

describe('a password typed for a federated account', () => {
  /** Sign in by username, which discovery cannot cover, and be refused. */
  async function refusedPasswordAttempt(details?: Record<string, unknown>) {
    login.mockRejectedValue(Object.assign(
      new Error('This account must sign in with single sign-on (SSO).'),
      { code: 'SSO_REQUIRED', details },
    ));
    await enterIdentifier('ada');
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^sign in$/i })); });
  }

  it('swaps the password for the SSO action and names the provider', async () => {
    await refusedPasswordAttempt({ orgId: 'org-1', provider: 'okta' });

    expect(ssoButton()).toHaveTextContent(/continue with okta/i);
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.getByText(/a password here won’t work/i)).toBeInTheDocument();
  });

  it('initiates against the org the refusal named', async () => {
    await refusedPasswordAttempt({ orgId: 'org-1', provider: 'okta' });
    await act(async () => { fireEvent.click(ssoButton()!); });

    expect(mockApi.getSsoUrl).toHaveBeenCalledWith('org-1');
    expect(mockApi.startSsoByEmail).not.toHaveBeenCalled();
    expect(window.location.hash).toBe(IDP_SAML_URL);
  });

  it('still offers the flow when the refusal carried no provider name', async () => {
    await refusedPasswordAttempt({ orgId: 'org-1', provider: 'saml' });
    expect(ssoButton()).toHaveTextContent(/continue with single sign-on/i);
  });

  it('restores the password form once a different account is typed', async () => {
    await refusedPasswordAttempt({ orgId: 'org-1', provider: 'okta' });
    await enterIdentifier('grace');

    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(ssoButton()).not.toBeInTheDocument();
  });
});
