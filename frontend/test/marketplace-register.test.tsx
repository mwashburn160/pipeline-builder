// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS Marketplace fulfillment — the money path from a paid AWS subscription to
 * a linked org:
 *  - `resolveRegistrationToken` (server-only): every failure mode is a buyer-
 *    readable `error` outcome (never a throw, never the token or internals),
 *    `already` / `pending` on success, and the token goes only to the internal
 *    billing URL, in the body;
 *  - `getServerSideProps`: the token is read from the POSTed form ONLY (no
 *    `?token=` fallback), exchanged server-side, and never shipped to the page;
 *  - the page: pending → link (claim) for a signed-in user, sign-up / sign-in
 *    for a new buyer (ref stashed), the stashed ref picked up after the auth
 *    hop, `already`, and a refused claim.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AnyFn } from './helpers/mock-fn';
import { mockRouter, pageToast } from './helpers/pageMocks';
import { apiFn, resetApiMock } from './helpers/apiMock';

jest.mock('@/lib/api', () => require('./helpers/apiMock').apiMockModule());
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule());
jest.mock('next/head', () => require('./helpers/pageMocks').headModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
let auth: Record<string, unknown> = {};
jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => auth));

import MarketplaceRegisterPage, { getServerSideProps } from '../pages/marketplace/register';
import { resolveRegistrationToken } from '@/lib/marketplace/resolve';
import { readMarketplaceRef, stashMarketplaceRef } from '@/hooks/usePendingMarketplaceClaim';

const originalFetch = global.fetch;
const fetchMock = jest.fn<AnyFn>();
const jsonRes = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

beforeEach(() => {
  resetApiMock();
  fetchMock.mockReset();
  (global as { fetch: unknown }).fetch = fetchMock;
  process.env.BILLING_INTERNAL_URL = 'http://billing.internal:3000/';
  jest.spyOn(console, 'error').mockImplementation(() => {});
  try { sessionStorage.clear(); } catch { /* none */ }
  document.cookie.split(';').forEach((c) => { document.cookie = `${c.split('=')[0].trim()}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`; });
  auth = { user: null, isAuthenticated: false, isInitialized: true };
  mockRouter();
});
afterEach(() => {
  (global as { fetch: unknown }).fetch = originalFetch;
  delete process.env.BILLING_INTERNAL_URL;
});

describe('resolveRegistrationToken', () => {
  it('posts the token to the internal billing route and returns a pending ref', async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { success: true, data: { registrationRef: 'ref-1', planName: 'Pro' } }));
    await expect(resolveRegistrationToken('tok-123')).resolves.toEqual({ state: 'pending', registrationRef: 'ref-1', planName: 'Pro' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://billing.internal:3000/billing/marketplace/resolve');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ 'x-amzn-marketplace-token': 'tok-123' });
  });

  it('a missing planName is null; an already-bound subscription is `already`', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { success: true, data: { registrationRef: 'ref-2' } }));
    await expect(resolveRegistrationToken('t')).resolves.toEqual({ state: 'pending', registrationRef: 'ref-2', planName: null });
    fetchMock.mockResolvedValueOnce(jsonRes(200, { success: true, data: { alreadyRegistered: true } }));
    await expect(resolveRegistrationToken('t')).resolves.toEqual({ state: 'already' });
  });

  it('every failure is a buyer-readable error, never a throw or the token', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(400, { success: false, message: 'This token is for another product.' }));
    await expect(resolveRegistrationToken('secret-tok')).resolves.toEqual({ state: 'error', message: 'This token is for another product.' });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => { throw new Error('not json'); } });
    await expect(resolveRegistrationToken('secret-tok')).resolves.toEqual({ state: 'error', message: 'Could not verify your AWS Marketplace subscription.' });
    fetchMock.mockResolvedValueOnce(jsonRes(200, { success: false }));
    await expect(resolveRegistrationToken('secret-tok')).resolves.toMatchObject({ state: 'error' });
    fetchMock.mockResolvedValueOnce(jsonRes(200, { success: true, data: {} }));
    await expect(resolveRegistrationToken('secret-tok')).resolves.toEqual({ state: 'error', message: expect.stringMatching(/could not be prepared/) });
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED 10.0.0.1'));
    const net = await resolveRegistrationToken('secret-tok');
    expect(net).toEqual({ state: 'error', message: 'Could not reach AWS Marketplace. Please try again shortly.' });
    // The token is never logged.
    for (const call of (console.error as unknown as jest.Mock<AnyFn>).mock.calls) {
      expect(JSON.stringify(call)).not.toContain('secret-tok');
    }
  });

  it('no BILLING_INTERNAL_URL is a deployment fault: no request, a vague message', async () => {
    delete process.env.BILLING_INTERNAL_URL;
    await expect(resolveRegistrationToken('t')).resolves.toEqual({ state: 'error', message: expect.stringMatching(/unavailable right now/) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a hung exchange is aborted at the timeout', async () => {
    jest.useFakeTimers();
    try {
      fetchMock.mockImplementation((_u: string, init: RequestInit) => new Promise((_r, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }));
      const pending = resolveRegistrationToken('t');
      jest.advanceTimersByTime(10_000);
      await expect(pending).resolves.toMatchObject({ state: 'error' });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('getServerSideProps', () => {
  function req(method: string, body = '') {
    const r = new EventEmitter() as EventEmitter & { method: string; destroy: () => void };
    r.method = method;
    r.destroy = jest.fn<AnyFn>();
    setTimeout(() => { if (body) r.emit('data', body); r.emit('end'); }, 0);
    return r;
  }
  const ctx = (r: unknown, query: Record<string, string> = {}) => ({ req: r, query, res: {}, resolvedUrl: '/marketplace/register' }) as never;

  it('exchanges the POSTed form token and ships only the outcome', async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { success: true, data: { registrationRef: 'ref-9', planName: 'Team' } }));
    const out = await getServerSideProps(ctx(req('POST', 'x-amzn-marketplace-token=aws-tok%2B1&other=x')));
    expect(out).toEqual({ props: { outcome: { state: 'pending', registrationRef: 'ref-9', planName: 'Team' } } });
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ 'x-amzn-marketplace-token': 'aws-tok+1' });
    expect(JSON.stringify(out)).not.toContain('aws-tok');
  });

  it('accepts the plain `token` field too', async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { success: true, data: { alreadyRegistered: true } }));
    await expect(getServerSideProps(ctx(req('POST', 'token=t2')))).resolves.toEqual({ props: { outcome: { state: 'already' } } });
  });

  it('a GET (even with ?token=) and an empty POST exchange nothing', async () => {
    await expect(getServerSideProps(ctx(req('GET'), { token: 'leaked' }))).resolves.toEqual({ props: { outcome: null } });
    await expect(getServerSideProps(ctx(req('POST', '')))).resolves.toEqual({ props: { outcome: null } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a request stream error reads as no token', async () => {
    const r = new EventEmitter() as EventEmitter & { method: string };
    r.method = 'POST';
    setTimeout(() => r.emit('error', new Error('reset')), 0);
    await expect(getServerSideProps(ctx(r))).resolves.toEqual({ props: { outcome: null } });
  });
});

describe('MarketplaceRegisterPage', () => {
  const pending = { state: 'pending' as const, registrationRef: 'ref-1', planName: 'Pro' };

  it('a signed-in buyer links the subscription to their org', async () => {
    auth = { user: { id: 'u1', organizationName: 'Acme', permissions: ['billing:manage'] }, isAuthenticated: true, isInitialized: true };
    apiFn('claimMarketplaceRegistration').mockResolvedValue({ success: true });
    const router = mockRouter();
    render(<MarketplaceRegisterPage outcome={pending} />);
    expect(screen.getByText('Pro')).toBeInTheDocument();
    expect(readMarketplaceRef()).toEqual({ registrationRef: 'ref-1', planName: 'Pro' });
    fireEvent.click(screen.getByRole('button', { name: 'Link to Acme' }));
    await waitFor(() => expect(apiFn('claimMarketplaceRegistration')).toHaveBeenCalledWith('ref-1'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/dashboard/billing'));
    expect(pageToast.success).toHaveBeenCalledWith('AWS Marketplace subscription linked');
    expect(readMarketplaceRef()).toBeNull();
  });

  it('a refused claim returns to the link step with the reason', async () => {
    auth = { user: { id: 'u1', permissions: ['billing:manage'] }, isAuthenticated: true, isInitialized: true };
    apiFn('claimMarketplaceRegistration').mockResolvedValue({ success: false, message: 'Your org already has a subscription' });
    render(<MarketplaceRegisterPage outcome={{ ...pending, planName: null }} />);
    expect(screen.getByText(/your plan/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Link to my organization' }));
    expect(await screen.findByText(/Your org already has a subscription/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link to my organization' })).toBeEnabled();
  });

  // `POST /billing/marketplace/claim` is `any(billing:manage)`: a member without
  // it (or a read-only impersonation session) used to get a Link button that
  // could only come back 403. They are told who can finish instead, and the
  // stashed ref is kept for that person.
  it.each([
    ['a member without billing:manage', { id: 'u2', organizationName: 'Acme', permissions: ['pipelines:read'] }, false],
    ['a read-only session', { id: 'u3', organizationName: 'Acme', permissions: ['billing:manage'] }, true],
  ])('%s is not offered a claim the API refuses', (_label, user, isReadOnly) => {
    auth = { user, isAuthenticated: true, isInitialized: true, isReadOnly };
    render(<MarketplaceRegisterPage outcome={pending} />);
    expect(screen.queryByRole('button', { name: 'Link to Acme' })).toBeNull();
    expect(screen.getByText(/permission to manage billing/)).toBeInTheDocument();
    expect(apiFn('claimMarketplaceRegistration')).not.toHaveBeenCalled();
    expect(readMarketplaceRef()?.registrationRef).toBe('ref-1');
  });

  it('a new buyer is sent to sign up or sign in with the ref stashed', () => {
    const router = mockRouter();
    render(<MarketplaceRegisterPage outcome={pending} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(router.push).toHaveBeenCalledWith('/auth/register');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(router.push).toHaveBeenCalledWith('/');
    expect(readMarketplaceRef()?.registrationRef).toBe('ref-1');
  });

  it('back from the auth hop with no token, the stashed ref is picked up', async () => {
    stashMarketplaceRef('ref-stashed', 'Team');
    auth = { user: { id: 'u1', organizationName: 'Acme', permissions: ['billing:manage'] }, isAuthenticated: true, isInitialized: true };
    render(<MarketplaceRegisterPage outcome={null} />);
    expect(await screen.findByText('Team')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link to Acme' })).toBeInTheDocument();
  });

  it('no token and nothing stashed says to start again from AWS', async () => {
    render(<MarketplaceRegisterPage outcome={null} />);
    expect(await screen.findByText(/No AWS Marketplace registration token was provided/)).toBeInTheDocument();
  });

  it('`already` and `error` outcomes render as terminal', () => {
    const { unmount } = render(<MarketplaceRegisterPage outcome={{ state: 'already' }} />);
    expect(screen.getByText(/already linked to an organization/)).toBeInTheDocument();
    unmount();
    render(<MarketplaceRegisterPage outcome={{ state: 'error', message: 'Could not reach AWS Marketplace.' }} />);
    expect(screen.getByText('Could not reach AWS Marketplace.')).toBeInTheDocument();
  });

  it('waits for auth to initialise before deciding', () => {
    auth = { user: null, isAuthenticated: false, isInitialized: false };
    render(<MarketplaceRegisterPage outcome={pending} />);
    expect(screen.getByText(/Verifying your AWS Marketplace subscription/)).toBeInTheDocument();
  });
});
