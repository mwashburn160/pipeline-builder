// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The operator consoles (Grafana / Kiali / pgAdmin / mongo-express) behind the
 * AWS gateway's `auth_request` to `GET /admin/console-check`, which reads the
 * bearer from the `pb_admin_console` cookie:
 *   - OPENING a console mints that cookie through the server
 *     (`POST /api/admin/console-session`), so the entry is audited; the
 *     dashboard no longer writes it on this path, and a refusal is shown in the
 *     dashboard rather than arriving as a bare 401 in an already-open tab;
 *   - the cookie this module still writes is the ROTATION follow-up — Secure,
 *     SameSite=Strict, Path=/, and never outliving the access token;
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
/**
 * The server-side mint. It sets the cookie through `Set-Cookie`, which this
 * stub cannot do and does not need to: the cookie's own shape is asserted in
 * platform's `admin-console-session` suite, against the real handler. What
 * matters HERE is that the dashboard calls it, with the right class, instead of
 * writing the cookie itself — the whole point of the change is that opening a
 * console goes through the server so it can be audited.
 */
const openConsoleSession = jest.fn<AnyFn>(async () => undefined);
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getAccessToken: () => accessToken,
    ensureFreshToken: (...a: unknown[]) => ensureFreshToken(...a),
    openConsoleSession: (...a: unknown[]) => openConsoleSession(...a),
    // The re-auth dialog reads the account's factors on mount to decide which
    // route to offer; stubbed so that read SETTLES inside the test.
    getProfile: () => Promise.resolve({ success: true, data: { user: { authFactors: null } } }),
  },
  // lib/jwt decodes through it.
  base64UrlDecode: (str: string) => jest.requireActual<typeof import('../src/lib/api/util')>('../src/lib/api/util').base64UrlDecode(str),
}));
jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => ({ logout: jest.fn<AnyFn>() })));
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ push: jest.fn<AnyFn>(), asPath: '/dashboard/admin/settings' })));
let deployTarget = 'aws-eks';
let adminConsolesEnabled = true;
jest.mock('@/hooks/useFeatures', () => ({ __esModule: true, useFeatures: () => ({ deployTarget, adminConsolesEnabled }) }));

import {
  ADMIN_CONSOLE_COOKIE, clearAdminConsoleCookie, setAdminConsoleCookie, syncAdminConsoleCookie,
} from '../src/lib/admin-console';

/** Whether the jar above currently carries the console cookie. */
const cookieIsSet = () => !!jar.get(ADMIN_CONSOLE_COOKIE);
import { AdminConsoleLinks } from '../src/components/admin/AdminConsoleLinks';
import { ApiCore } from '../src/lib/api/core';

beforeEach(() => {
  jar = new Map();
  writes.length = 0;
  accessToken = null;
  deployTarget = 'aws-eks';
  adminConsolesEnabled = true;
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => { jest.restoreAllMocks(); });

describe('the console cookie', () => {
  it('is Secure, SameSite=Strict, Path=/ and lives no longer than the token', () => {
    expect(setAdminConsoleCookie(admin())).toBe(true);
    expect(writes[0]).toMatch(new RegExp(`^${ADMIN_CONSOLE_COOKIE}=`));
    expect(writes[0]).toContain('; Secure; SameSite=Strict; Path=/; Max-Age=600');
    expect(cookieIsSet()).toBe(true);
  });

  it('is not written for a token with no time left', () => {
    expect(setAdminConsoleCookie(admin({ exp: NOW / 1000 - 1 }))).toBe(false);
    expect(cookieIsSet()).toBe(false);
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
    ['a read-only impersonation token', admin({ impersonationReadOnly: true })],
    ['a full impersonation token', admin({ impersonatorId: 'u9' })],
    ['a different user', admin({ sub: 'u2' })],
  ])('is dropped on %s', (_label, token) => {
    setAdminConsoleCookie(admin());
    syncAdminConsoleCookie(token as string | null);
    expect(cookieIsSet()).toBe(false);
  });

  // It used to be dropped here, from when the consoles were flag-gated. A
  // Console Administrator holds `database_console:open` WITHOUT the flag, so
  // dropping it on rotation would 401 them mid-session with nothing to explain
  // it — and keeping it grants nothing, because the gateway re-checks the
  // permission, the org and the assurance level on every request.
  it('SURVIVES a rotation for a non-superadmin — the gateway re-checks, not the cookie', () => {
    setAdminConsoleCookie(admin({ isSuperAdmin: false }));
    const rotated = admin({ isSuperAdmin: false, exp: NOW / 1000 + 900 });
    syncAdminConsoleCookie(rotated);
    expect(decodeURIComponent(jar.get(ADMIN_CONSOLE_COOKIE)!)).toBe(rotated);
  });

  it('is never written by a token change when no console was opened', () => {
    syncAdminConsoleCookie(admin());
    expect(writes).toHaveLength(0);
  });

  it('clears', () => {
    setAdminConsoleCookie(admin());
    clearAdminConsoleCookie();
    expect(cookieIsSet()).toBe(false);
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

  it('is hidden from a viewer holding no console permission, and on an unknown target', () => {
    const { container, rerender } = render(<AdminConsoleLinks user={{ isSuperAdmin: false }} />);
    expect(container).toBeEmptyDOMElement();
    // `local` is the config DEFAULT, not a deployment that serves consoles —
    // the four real targets are aws-ec2, aws-eks, minikube and docker.
    deployTarget = 'local';
    rerender(<AdminConsoleLinks user={sysadmin} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists all five consoles on eks, with RustFS as a command rather than a dead link', () => {
    render(<AdminConsoleLinks user={sysadmin} />);
    for (const label of ['Grafana', 'Kiali', 'pgAdmin', 'mongo-express', 'RustFS']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // :9001 has no ALB listener on eks, so an Open button would fail with a
    // connection error the operator would have to diagnose.
    expect(screen.queryByRole('button', { name: 'Open RustFS' })).not.toBeInTheDocument();
    expect(screen.getByText(/port-forward -n pipeline-builder svc\/nginx 9001:9001/)).toBeInTheDocument();
  });

  it('links RustFS on ec2, where :9001 is published, from the CURRENT origin', async () => {
    deployTarget = 'aws-ec2';
    accessToken = admin();
    const win = { opener: {} as unknown, location: { href: 'about:blank' }, close: jest.fn<AnyFn>() };
    jest.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    render(<AdminConsoleLinks user={sysadmin} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open RustFS' }));
    await waitFor(() => expect(win.location.href).toMatch(/^https?:\/\/[^/]+:9001\/rustfs\/console\/$/));
  });

  // minikube forwards nginx 9001:9001 in `pb_console_port_forwards`, so the
  // tile is a link there too — eks is the only target that needs the command.
  it('links RustFS on minikube, which forwards :9001 at provision and resume', () => {
    deployTarget = 'minikube';
    render(<AdminConsoleLinks user={sysadmin} />);
    expect(screen.getByRole('button', { name: 'Open RustFS' })).toBeInTheDocument();
    expect(screen.queryByText(/port-forward/)).not.toBeInTheDocument();
  });

  // The deploy switch: with it off the gateway serves a 404 stub for all five,
  // so five tiles that each dead-end is worse than no card.
  it('renders nothing when ADMIN_CONSOLES_ENABLED is false', () => {
    adminConsolesEnabled = false;
    const { container } = render(<AdminConsoleLinks user={sysadmin} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('drops Kiali on docker, which runs no Istio', () => {
    deployTarget = 'docker';
    render(<AdminConsoleLinks user={sysadmin} />);
    expect(screen.getByText('Grafana')).toBeInTheDocument();
    expect(screen.queryByText('Kiali')).not.toBeInTheDocument();
  });

  // On minikube and docker the gateway runs no `auth_request`, so demanding a
  // second factor in the UI would refuse a developer a console that is open.
  it('opens without a cookie or a second factor on an ungated target', () => {
    deployTarget = 'docker';
    accessToken = admin({ aal: 1 });
    const open = jest.spyOn(window, 'open').mockReturnValue(null);
    render(<AdminConsoleLinks user={{ isSuperAdmin: true }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Grafana' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(open).toHaveBeenCalledWith('/grafana/', '_blank', 'noopener');
    expect(cookieIsSet()).toBe(false);
    // No gateway to get past, so nothing to mint — and nothing to audit.
    expect(openConsoleSession).not.toHaveBeenCalled();
  });

  it('asks a single-factor session to sign in again with a second factor, and sets nothing', async () => {
    accessToken = admin({ aal: 1 });
    const open = jest.spyOn(window, 'open').mockReturnValue(null);
    render(<AdminConsoleLinks user={sysadmin} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Grafana' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    expect(cookieIsSet()).toBe(false);
    expect(openConsoleSession).not.toHaveBeenCalled();
    // The dialog's factors read settles after the click; let it land here.
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
  });

  it('mints the session SERVER-side for the console’s class, then opens it', async () => {
    accessToken = admin();
    const win = { opener: {} as unknown, location: { href: 'about:blank' }, close: jest.fn<AnyFn>() };
    jest.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    render(<AdminConsoleLinks user={sysadmin} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Kiali' }));
    await waitFor(() => expect(win.location.href).toBe('/kiali/'));
    expect(ensureFreshToken).toHaveBeenCalled();
    // The CLASS, not the console id: it is what platform gates on and what the
    // audit row records. Kiali is observability, so a Console Administrator
    // holding only `database_console:open` is refused by the server.
    expect(openConsoleSession).toHaveBeenCalledWith('observability');
    expect(win.opener).toBeNull();
    // The dashboard writes NOTHING: the cookie arrives as `Set-Cookie`, which
    // is what makes the entry attributable instead of invisible.
    expect(cookieIsSet()).toBe(false);
  });

  it('shows the server’s refusal and closes the tab it opened', async () => {
    accessToken = admin();
    openConsoleSession.mockRejectedValueOnce(new Error('You do not hold database_console:open'));
    const win = { opener: {} as unknown, location: { href: 'about:blank' }, close: jest.fn<AnyFn>() };
    jest.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    render(<AdminConsoleLinks user={sysadmin} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open pgAdmin' }));

    // Before, a refusal arrived as a bare 401 from the gateway in a tab that
    // had already navigated — nothing the operator could act on. The mint is
    // the one point where the reason can still be shown in the dashboard.
    await waitFor(() => expect(screen.getByText('You do not hold database_console:open')).toBeInTheDocument());
    expect(win.close).toHaveBeenCalled();
    expect(win.location.href).toBe('about:blank');
  });
});
