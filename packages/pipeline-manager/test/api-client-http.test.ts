// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The CLI's HTTP path end to end against a local HTTP server: ApiClient (every
 * verb, the bearer header, error mapping — API message, network code hints —
 * and the expired-token advisory), credential resolution (env token → stored
 * `auth login` session → refresh of an expired one → `--store-tokens` secret),
 * and the shared list/get runners behind `pipeline list` / `plugin get`.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';

const HOME = mkdtempSync(join(tmpdir(), 'pm-api-client-'));
process.env.HOME = HOME;
process.env.CLI_CONFIG_PATH = join(HOME, 'missing-config.yml');

const getSecretValue = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/utils/aws-secrets.js', () => ({ getSecretValue }));

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let handler: Handler = (_req, _body, res) => { res.end('{}'); };
const seen: Array<{ method?: string; url?: string; auth?: string; body: string }> = [];
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
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.PLATFORM_BASE_URL = baseUrl;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(HOME, { recursive: true, force: true });
});

const { ApiClient } = await import('../src/utils/api-client.js');
const { resolveToken, createAuthenticatedClientAsync, createAuthenticatedClient } = await import('../src/utils/command-utils.js');
const store = await import('../src/utils/credential-store.js');
const { Command } = await import('commander');
const { listPipelines } = await import('../src/commands/list-pipelines.js');
const { listPlugins } = await import('../src/commands/list-plugins.js');
const { getPlugin } = await import('../src/commands/get-plugin.js');
const { getPipeline } = await import('../src/commands/get-pipeline.js');

const logged: string[] = [];
class ExitError extends Error { constructor(readonly code?: number) { super(`__EXIT_${code}__`); } }

beforeEach(() => {
  seen.length = 0;
  logged.length = 0;
  handler = (_req, _body, res) => json(res, 200, {});
  process.env.PLATFORM_TOKEN = 'tok-env';
  delete process.env.PLATFORM_SECRET_NAME;
  for (const m of ['log', 'error', 'warn', 'info'] as const) {
    jest.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  }
  jest.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new ExitError(c); }) as never);
});

const config = (over: Record<string, unknown> = {}) => ({ api: { baseUrl, timeout: 2000, pipelineUrl: '/api/pipelines', pluginUrl: '/api/plugins', ...over }, auth: { token: 'tok-1' } }) as any;
const jwt = (payload: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;

describe('ApiClient', () => {
  it('refuses to exist without a token', () => {
    expect(() => new ApiClient({ api: { baseUrl }, auth: {} } as any)).toThrow('Authentication token is required');
  });

  it('sends every verb with the bearer token and returns the body', async () => {
    handler = (req, body, res) => json(res, 200, { method: req.method, body: body ? JSON.parse(body) : null });
    const c = new ApiClient(config());
    expect(await c.get('/x', { q: 1 })).toEqual({ method: 'GET', body: null });
    expect(await c.post('/x', { a: 1 })).toEqual({ method: 'POST', body: { a: 1 } });
    expect(await c.put('/x', { b: 2 })).toMatchObject({ method: 'PUT' });
    expect(await c.patch('/x', { c: 3 })).toMatchObject({ method: 'PATCH' });
    expect(await c.delete('/x')).toMatchObject({ method: 'DELETE' });
    expect(seen.every((s) => s.auth === 'Bearer tok-1')).toBe(true);
    expect(seen[0]!.url).toBe('/x?q=1');
    expect(c.getBaseUrl()).toBe(baseUrl);
    expect(c.isAuthenticated()).toBe(true);
  });

  it('posts multipart forms', async () => {
    const { default: FormData } = await import('form-data');
    const form = new FormData();
    form.append('field', 'value');
    handler = (req, body, res) => json(res, 200, { type: req.headers['content-type'], hasField: body.includes('value') });
    const r = await new ApiClient(config({ uploadTimeout: 5000 })).postForm<{ type: string; hasField: boolean }>('/upload', form);
    expect(r.type).toMatch(/^multipart\/form-data; boundary=/);
    expect(r.hasField).toBe(true);
  });

  it('maps an error response to ApiError with the API\'s message (or a status fallback)', async () => {
    handler = (_req, _body, res) => json(res, 409, { message: 'Plugin name taken' });
    await expect(new ApiClient(config()).get('/x')).rejects.toMatchObject({ message: 'Plugin name taken', status: 409 });
    handler = (_req, _body, res) => json(res, 500, { oops: true });
    await expect(new ApiClient(config()).get('/x')).rejects.toMatchObject({ message: 'API request failed with status 500' });
  });

  it('maps an unreachable server to a NetworkError with a hint', async () => {
    const c = new ApiClient(config({ baseUrl: 'http://127.0.0.1:1' }));
    await expect(c.get('/x')).rejects.toMatchObject({ message: expect.stringContaining('ECONNREFUSED: Server is not running') });
  });

  it('warns (advisory) on an expired JWT and when certificate validation is off', () => {
    new ApiClient({ api: { baseUrl, rejectUnauthorized: false }, auth: { token: jwt({ exp: 1 }) } } as any);
    const text = logged.join('\n');
    expect(text).toContain('Token expired at 1970-01-01T00:00:01.000Z');
    expect(text).toContain('Certificate validation is disabled');
  });
});

describe('credential resolution', () => {
  beforeEach(() => {
    delete process.env.PLATFORM_TOKEN;
    store.clearSession(baseUrl);
  });

  it('prefers PLATFORM_TOKEN', async () => {
    process.env.PLATFORM_TOKEN = 'from-env';
    await expect(resolveToken({})).resolves.toBe('from-env');
  });

  it('uses a usable stored session', async () => {
    store.saveSession(baseUrl, { accessToken: 'stored', refreshToken: 'r', expiresAt: Date.now() + 600_000 });
    await expect(resolveToken({})).resolves.toBe('stored');
  });

  it('renews an expired stored session and persists the rotated pair', async () => {
    store.saveSession(baseUrl, { accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() - 1000, organizationId: 'org-1' });
    handler = (req, body, res) => {
      expect(req.headers['x-pb-client']).toBe('cli');
      expect(JSON.parse(body)).toEqual({ refreshToken: 'r1' });
      json(res, 200, { data: { accessToken: 'new', refreshToken: 'r2', expiresIn: 60 } });
    };
    await expect(resolveToken({})).resolves.toBe('new');
    expect(store.loadSession(baseUrl)).toMatchObject({ accessToken: 'new', refreshToken: 'r2', organizationId: 'org-1' });
    expect(seen[0]!.url).toBe('/api/auth/refresh');
  });

  it('forgets a session the platform refuses to renew, then demands sign-in', async () => {
    store.saveSession(baseUrl, { accessToken: 'old', refreshToken: 'dead', expiresAt: Date.now() - 1000 });
    handler = (_req, _body, res) => json(res, 401, { message: 'revoked' });
    await expect(resolveToken({})).rejects.toThrow('Authentication required');
    expect(store.loadSession(baseUrl)).toBeUndefined();
    expect(logged.join('\n')).toContain('could not be renewed');
  });

  it('an expired session without a refresh token is not usable', async () => {
    store.saveSession(baseUrl, { accessToken: 'old', expiresAt: Date.now() - 1000 });
    await expect(resolveToken({})).rejects.toThrow('Authentication required');
  });

  it('--store-tokens reads the service-account key from Secrets Manager (never the laptop session)', async () => {
    store.saveSession(baseUrl, { accessToken: 'laptop', refreshToken: 'r', expiresAt: Date.now() + 600_000 });
    await expect(resolveToken({ storeTokens: true })).rejects.toThrow('PLATFORM_SECRET_NAME env var is required');
    process.env.PLATFORM_SECRET_NAME = 'pb/token';
    getSecretValue.mockResolvedValueOnce(JSON.stringify({ username: 'org-1' }));
    await expect(resolveToken({ storeTokens: true, region: 'us-east-1' })).rejects.toThrow('Secret missing password');
    getSecretValue.mockResolvedValueOnce(JSON.stringify({ username: 'org-1', password: 'pb_sa_key' }));
    await expect(createAuthenticatedClientAsync({ storeTokens: true })).resolves.toBeInstanceOf(ApiClient);
    expect(process.env.PLATFORM_TOKEN).toBe('pb_sa_key');
    expect(getSecretValue).toHaveBeenLastCalledWith('pb/token', { region: undefined, profile: undefined });
  });

  it('the sync client needs a token', () => {
    expect(() => createAuthenticatedClient({})).toThrow();
  });
});

async function run(register: (p: InstanceType<typeof Command>) => void, group: string, args: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  const g = program.command(group);
  register(g);
  try {
    return await program.parseAsync(['node', 'pm', group, ...args]);
  } catch (e) {
    return e;
  }
}

describe('list + get commands (shared runners)', () => {
  it('pipeline list: common + pipeline filters reach the API, results paginate and render as a table', async () => {
    handler = (_req, _body, res) => json(res, 200, { success: true, data: { pipelines: [{ id: 'p1', pipelineName: 'web', project: 'acme', organization: 'org', isActive: true, isDefault: false, visibility: 'org' }], total: 5, hasMore: true } });
    await run(listPipelines, 'pipeline', ['list', '--id', 'a, b', '--is-active', 'true', '--project', 'acme', '--sort', 'createdAt:desc', '--limit', '2', '--format', 'table']);
    const url = new URL(seen[0]!.url!, baseUrl);
    expect(url.pathname).toBe('/api/pipelines');
    expect(url.searchParams.getAll('id[]').length + url.searchParams.getAll('id').length).toBeGreaterThan(0);
    expect(url.searchParams.get('project')).toBe('acme');
    expect(url.searchParams.get('limit')).toBe('2');
    const text = logged.join('\n');
    expect(text).toContain('Use --offset 2 to see next page');
    expect(text).toContain('web');
  });

  it('plugin list: no filters, json output to a file', async () => {
    const cwd = process.cwd();
    process.chdir(HOME);
    try {
      handler = (_req, _body, res) => json(res, 200, { plugins: [{ id: 'x', name: 'scan', version: '1.0.0' }], total: 1 });
      await run(listPlugins, 'plugin', ['list', '--format', 'json', '--output', 'plugins.json']);
      expect(JSON.parse(readFileSync(join(HOME, 'plugins.json'), 'utf8'))).toEqual(expect.anything());
      expect(logged.join('\n')).toContain('No filters applied');
    } finally {
      process.chdir(cwd);
    }
  });

  it('a list API failure exits non-zero', async () => {
    handler = (_req, _body, res) => json(res, 403, { message: 'forbidden' });
    const err = await run(listPlugins, 'plugin', ['list']);
    expect(err).toBeInstanceOf(ExitError);
    expect((err as ExitError).code).toBeGreaterThan(0);
  });

  it('plugin get: fetches by id, shows metadata in table format', async () => {
    handler = (_req, _body, res) => json(res, 200, { plugin: { id: '11111111-1111-4111-8111-111111111111', name: 'scan', version: '1.0.0', fileSize: 2048, metadata: { lang: 'go' } } });
    await run(getPlugin, 'plugin', ['get', '--id', '11111111-1111-4111-8111-111111111111', '--format', 'table', '--show-metadata']);
    expect(seen[0]!.url).toBe('/api/plugins/11111111-1111-4111-8111-111111111111');
    expect(logged.join('\n')).toContain('"lang": "go"');
  });

  it('pipeline get: an empty response is an error (exit non-zero)', async () => {
    handler = (_req, _body, res) => json(res, 200, {});
    const err = await run(getPipeline, 'pipeline', ['get', '--id', '11111111-1111-4111-8111-111111111111']);
    expect(err).toBeInstanceOf(ExitError);
  });
});
