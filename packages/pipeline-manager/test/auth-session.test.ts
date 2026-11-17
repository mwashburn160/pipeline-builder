// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The stored-session lifecycle across commands, against a local HTTP server:
 *
 * - `auth login --url X` makes X the platform later commands talk to, so they
 *   find the session it stored (it used to be saved under X while every other
 *   command looked under config.yml / localhost and reported "Not signed in").
 * - A refresh the platform REJECTS (401) forgets the session; a network failure
 *   or a 5xx keeps it (one blip used to force a fresh browser sign-in).
 * - `auth logout` revokes the session on the platform and deletes it locally,
 *   and still deletes it locally when the platform can't be told.
 */

import { rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { useTempHome } from './helpers/temp-home.js';

const HOME = useTempHome('pm-auth-session-');
process.env.CLI_CONFIG_PATH = join(HOME, 'missing-config.yml');

// The device flow itself is covered by device-auth.test.ts; here it just hands
// back a session so the command's storing logic runs for real.
const beginDeviceApproval = jest.fn<AnyFn>(async () => ({ device_code: 'dc' }));
const pollForDeviceToken = jest.fn<AnyFn>(async () => ({ access_token: 'login.jwt', refresh_token: 'login.refresh', expires_in: 900 }));
jest.unstable_mockModule('../src/utils/device-auth.js', () => ({
  beginDeviceApproval,
  pollForDeviceToken,
  DeviceAuthError: class DeviceAuthError extends Error {},
}));

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let handler: Handler = (_req, _body, res) => { res.end('{}'); };
const seen: Array<{ method?: string; url?: string; auth?: string; client?: string; body: string }> = [];
let server: Server;
let baseUrl = '';

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, client: req.headers['x-pb-client'] as string | undefined, body });
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(HOME, { recursive: true, force: true });
});

const store = await import('../src/utils/credential-store.js');
const { getApiConfig } = await import('../src/utils/config-loader.js');
const { resolveToken } = await import('../src/utils/command-utils.js');
const { login } = await import('../src/commands/login.js');
const { logout } = await import('../src/commands/logout.js');
const { Command } = await import('commander');

const logged: string[] = [];
const text = () => logged.join('\n');
class ExitError extends Error { constructor(readonly code?: number) { super(`__EXIT_${code}__`); } }

beforeEach(() => {
  seen.length = 0;
  logged.length = 0;
  handler = (_req, _body, res) => json(res, 200, {});
  delete process.env.PLATFORM_TOKEN;
  delete process.env.PLATFORM_BASE_URL;
  rmSync(join(HOME, '.pipeline-manager'), { recursive: true, force: true });
  for (const m of ['log', 'error', 'warn', 'info'] as const) {
    jest.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  }
  jest.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new ExitError(c); }) as never);
});

async function runAuth(register: (p: InstanceType<typeof Command>) => void, args: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  const auth = program.command('auth');
  register(auth);
  try {
    return await program.parseAsync(['node', 'pm', 'auth', ...args]);
  } catch (e) {
    return e;
  }
}

it('runs against a temp home, never the real ~/.pipeline-manager', () => {
  expect(store.credentialStorePath().startsWith(HOME)).toBe(true);
});

describe('auth login --url (G3)', () => {
  it('makes the signed-in platform the one later commands use, so they find its session', async () => {
    expect(getApiConfig().api.baseUrl).toBe('https://localhost:8443');

    await runAuth(login, ['login', '--url', `${baseUrl}/`, '--no-browser']);

    // Stored under the platform AND remembered as the active one.
    expect(store.activePlatform()).toBe(baseUrl);
    expect(getApiConfig().api.baseUrl).toBe(baseUrl);
    // …which is what the next command resolves its credential from.
    await expect(resolveToken({})).resolves.toBe('login.jwt');
  });

  it('PLATFORM_BASE_URL still wins over the remembered platform', async () => {
    store.setActivePlatform(baseUrl);
    process.env.PLATFORM_BASE_URL = 'https://override.example.com';
    expect(getApiConfig().api.baseUrl).toBe('https://override.example.com');
  });

  it('without --url, signs in to the resolved platform (not a hard-coded localhost)', async () => {
    process.env.PLATFORM_BASE_URL = baseUrl;
    await runAuth(login, ['login', '--no-browser']);
    expect(beginDeviceApproval).toHaveBeenLastCalledWith(expect.objectContaining({ url: baseUrl }), expect.anything());
    expect(store.loadSession(baseUrl)?.accessToken).toBe('login.jwt');
  });
});

describe('auth login --org', () => {
  it('keeps the sign-in\'s refresh token and stores only the switched ACCESS token', async () => {
    handler = (req, _body, res) => {
      if (req.url === '/api/auth/switch-org') return json(res, 200, { success: true, data: { accessToken: 'switched.jwt', expiresIn: 600 } });
      return json(res, 200, {});
    };
    await runAuth(login, ['login', '--url', baseUrl, '--org', 'org-2', '--no-browser']);

    const sw = seen.find((r) => r.url === '/api/auth/switch-org');
    expect(sw).toMatchObject({ method: 'POST', auth: 'Bearer login.jwt', client: 'cli' });
    expect(JSON.parse(sw!.body)).toEqual({ organizationId: 'org-2' });
    expect(store.loadSession(baseUrl)).toMatchObject({
      accessToken: 'switched.jwt',
      refreshToken: 'login.refresh',
      organizationId: 'org-2',
    });
  });

  it('ignores a refresh token in the switch response — switch-org never rotates the session', async () => {
    handler = (req, _body, res) => {
      if (req.url === '/api/auth/switch-org') return json(res, 200, { success: true, data: { accessToken: 'switched.jwt', refreshToken: 'stray.refresh', expiresIn: 600 } });
      return json(res, 200, {});
    };
    await runAuth(login, ['login', '--url', baseUrl, '--org', 'org-2', '--no-browser']);
    expect(store.loadSession(baseUrl)?.refreshToken).toBe('login.refresh');
  });
});

describe('session renewal (G5)', () => {
  const expired = () => store.saveSession(baseUrl, { accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() - 1000 });
  beforeEach(() => { process.env.PLATFORM_BASE_URL = baseUrl; });

  it('a 5xx from /auth/refresh keeps the session and surfaces the failure', async () => {
    expired();
    handler = (_req, _body, res) => json(res, 503, { message: 'unavailable' });
    await expect(resolveToken({})).rejects.toThrow();
    expect(store.loadSession(baseUrl)?.refreshToken).toBe('r1');
    expect(text()).toContain('it is kept');
    expect(text()).not.toContain('could not be renewed');
  });

  it('an unreachable platform keeps the session', async () => {
    process.env.PLATFORM_BASE_URL = 'http://127.0.0.1:1';
    store.saveSession('http://127.0.0.1:1', { accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() - 1000 });
    await expect(resolveToken({})).rejects.toThrow();
    expect(store.loadSession('http://127.0.0.1:1')?.refreshToken).toBe('r1');
  });

  it('a 400 rejection forgets the session (as a 401 does)', async () => {
    expired();
    handler = (_req, _body, res) => json(res, 400, { message: 'Refresh token required' });
    await expect(resolveToken({})).rejects.toThrow('Authentication required');
    expect(store.loadSession(baseUrl)).toBeUndefined();
  });
});

describe('auth logout (G4)', () => {
  it('revokes the session on the platform, then deletes it locally', async () => {
    store.saveSession(baseUrl, { accessToken: 'live.jwt', refreshToken: 'r', expiresAt: Date.now() + 600_000 });
    await runAuth(logout, ['logout', '--url', baseUrl]);

    expect(seen).toEqual([expect.objectContaining({ method: 'POST', url: '/api/auth/logout', auth: 'Bearer live.jwt', client: 'cli' })]);
    expect(store.loadSession(baseUrl)).toBeUndefined();
    expect(text()).toContain('the session is revoked');
  });

  it('renews an expired access token first, so the platform can still be told', async () => {
    store.saveSession(baseUrl, { accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() - 1000 });
    handler = (req, _body, res) => (req.url === '/api/auth/refresh'
      ? json(res, 200, { data: { accessToken: 'fresh.jwt', refreshToken: 'r2', expiresIn: 60 } })
      : json(res, 200, {}));
    await runAuth(logout, ['logout', '--url', baseUrl]);

    expect(seen.map((r) => r.url)).toEqual(['/api/auth/refresh', '/api/auth/logout']);
    expect(seen[1]!.auth).toBe('Bearer fresh.jwt');
    expect(store.loadSession(baseUrl)).toBeUndefined();
  });

  it('still deletes the local session when the platform cannot be told, and says so', async () => {
    store.saveSession(baseUrl, { accessToken: 'live.jwt', refreshToken: 'r', expiresAt: Date.now() + 600_000 });
    handler = (_req, _body, res) => json(res, 500, { message: 'boom' });
    await runAuth(logout, ['logout', '--url', baseUrl]);

    expect(store.loadSession(baseUrl)).toBeUndefined();
    expect(text()).toContain('Could not revoke the session on the platform');
    expect(text()).toContain('Sessions and devices');
  });

  it('with no stored session, does nothing and calls nothing', async () => {
    await runAuth(logout, ['logout', '--url', baseUrl]);
    expect(seen).toHaveLength(0);
    expect(text()).toContain('nothing to sign out');
  });

  it('defaults to the active platform', async () => {
    store.setActivePlatform(baseUrl);
    store.saveSession(baseUrl, { accessToken: 'live.jwt', expiresAt: Date.now() + 600_000 });
    await runAuth(logout, ['logout']);
    expect(seen[0]!.url).toBe('/api/auth/logout');
    expect(store.loadSession(baseUrl)).toBeUndefined();
  });
});
