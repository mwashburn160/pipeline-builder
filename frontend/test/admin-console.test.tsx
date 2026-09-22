// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The operator consoles (Grafana / Kiali / pgAdmin / mongo-express) behind the
 * AWS gateway's `auth_request` to `GET /admin/console-check`, which reads the
 * bearer from the `pb_admin_console` cookie:
 *   - the cookie is written right before a console opens — Secure, SameSite=
 *     Strict, Path=/, and never outliving the access token;
 *   - it follows the token (rewritten on rotation) and is dropped on sign-out,
 *     an org switch or an impersonation token;
 *   - a single-factor session is told to sign in again with a second factor
 *     (a step-up cannot raise the session's AAL) instead of being sent to a 401;
 *   - only sysadmins on an AWS target see the links.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ── A cookie jar standing in for document.cookie (jsdom drops Secure cookies on http) ──
let jar = new Map<string, string>();
const writes: string[] = [];
Object.defineProperty(document, 'cookie', {
  configurable: true,
  get: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
  set: (raw: string) => {
    writes.push(raw);
    const [pair, ...attrs] = raw.split(';').map((p) => p.trim());
    const [k, v] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
    if (attrs.some((a) => a === 'Max-Age=0') || v === '') jar.delete(k); else jar.set(k, v);
  },
});

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}
const NOW = 1_800_000_000_000;
const admin = (over: Record<string, unknown> = {}) => jwt({ sub: 'u1', organizationId: 'sys', isSuperAdmin: true, aal: 2, exp: NOW / 1000 + 600, ...over });

let accessToken: string | null = null;
const ensureFreshToken = jest.fn<AnyFn>(async () => undefined);
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getAccessToken: () => accessToken,
    ensureFreshToken: (...a: unknown[]) => ensureFreshToken(...a),
  },
  // lib/jwt decodes through it.
  base64UrlDecode: (str: string) => jest.requireActual<typeof import('../src/lib/api/util')>('../src/lib/api/util').base64UrlDecode(str),
}));
jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => ({ logout: jest.fn<AnyFn>() })));
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ push: jest.fn<AnyFn>(), asPath: '/dashboard/admin/settings' })));
let deployTarget = 'aws-eks';
jest.mock('@/hooks/useFeatures', () => ({ __esModule: true, useFeatures: () => ({ deployTarget }) }));

import {
  ADMIN_CONSOLE_COOKIE, clearAdminConsoleCookie, hasAdminConsoleCookie, setAdminConsoleCookie, syncAdminConsoleCookie,
} from '../src/lib/admin-console';
import { AdminConsoleLinks } from '../src/components/admin/AdminConsoleLinks';
import { ApiCore } from '../src/lib/api/core';

beforeEach(() => {
  jar = new Map();
  writes.length = 0;
  accessToken = null;
  deployTarget = 'aws-eks';
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => { jest.restoreAllMocks(); });

describe('the console cookie', () => {
  it('is Secure, SameSite=Strict, Path=/ and lives no longer than the token', () => {
    expect(setAdminConsoleCookie(admin())).toBe(true);
    expect(writes[0]).toMatch(new RegExp(`^${ADMIN_CONSOLE_COOKIE}=`));
    expect(writes[0]).toContain('; Secure; SameSite=Strict; Path=/; Max-Age=600');
    expect(hasAdminConsoleCookie()).toBe(true);
  });

  it('is not written for a token with no time left', () => {
    expect(setAdminConsoleCookie(admin({ exp: NOW / 1000 - 1 }))).toBe(false);
    expect(hasAdminConsoleCookie()).toBe(false);
  });

  it('follows a rotated token of the same administrator and org', () => {
    setAdminConsoleCookie(admin());
    const rotated = admin({ exp: NOW / 1000 + 900, jti: 'next' });
    syncAdminConsoleCookie(rotated);
    expect(decodeURIComponent(jar.get(ADMIN_CONSOLE_COOKIE)!)).toBe(rotated);
    expect(writes.at(-1)).toContain('Max-Age=900');
  });

  it.each([
    ['sign-out', null],
    ['an org switch', admin({ organizationId: 'tenant' })],
    ['an impersonation token', admin({ impersonationReadOnly: true })],
    ['a non-administrator', admin({ isSuperAdmin: false })],
  ])('is dropped on %s', (_label, token) => {
    setAdminConsoleCookie(admin());
    syncAdminConsoleCookie(token as string | null);
    expect(hasAdminConsoleCookie()).toBe(false);
  });

  it('is never written by a token change when no console was opened', () => {
    syncAdminConsoleCookie(admin());
    expect(writes).toHaveLength(0);
  });

  it('clears', () => {
    setAdminConsoleCookie(admin());
    clearAdminConsoleCookie();
    expect(hasAdminConsoleCookie()).toBe(false);
  });
});

describe('the api client reports token changes', () => {
  it('on adoption and on sign-out', () => {
    const core = new ApiCore();
    const seen: Array<string | null> = [];
    const off = core.onAccessTokenChange((t) => seen.push(t));
    const t = admin();
    core.setTokens({ accessToken: t } as never);
    core.clearTokens();
    off();
    core.setTokens({ accessToken: t } as never);
    expect(seen).toEqual([t, null]);
  });
});

describe('AdminConsoleLinks', () => {
  const sysadmin = { isSuperAdmin: true, authFactors: { hasPassword: true, passkeyCount: 1, hasTotp: false, providers: [] } };

  it('is hidden from anyone but a platform administrator, and off AWS', () => {
    const { container, rerender } = render(<AdminConsoleLinks user={{ isSuperAdmin: false }} />);
    expect(container).toBeEmptyDOMElement();
    deployTarget = 'local';
    rerender(<AdminConsoleLinks user={sysadmin} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('asks a single-factor session to sign in again with a second factor, and sets nothing', () => {
    accessToken = admin({ aal: 1 });
    const open = jest.spyOn(window, 'open').mockReturnValue(null);
    render(<AdminConsoleLinks user={sysadmin} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Grafana' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    expect(hasAdminConsoleCookie()).toBe(false);
  });

  it('sets the cookie for a fresh token, then opens the console', async () => {
    accessToken = admin();
    const win = { opener: {} as unknown, location: { href: 'about:blank' }, close: jest.fn<AnyFn>() };
    jest.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    render(<AdminConsoleLinks user={sysadmin} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Kiali' }));
    await waitFor(() => expect(win.location.href).toBe('/kiali/'));
    expect(ensureFreshToken).toHaveBeenCalled();
    expect(decodeURIComponent(jar.get(ADMIN_CONSOLE_COOKIE)!)).toBe(accessToken);
    expect(win.opener).toBeNull();
  });
});
