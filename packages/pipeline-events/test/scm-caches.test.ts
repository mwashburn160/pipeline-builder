// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * scm.ts's per-container caches:
 *
 *  - the per-org GitHub token caches a READ token for the container's life but a
 *    miss (including a transient GetSecretValue error) only for ~60s;
 *  - the "never deployed" set is bounded, oldest evicted first;
 *  - the range bound advances only on a SUCCESSFUL DEPLOY.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSend })),
  GetSecretValueCommand: jest.fn((params: unknown) => params),
}));

const {
  resolveCommitInfo, _resetScmForTests, _scmStateForTests, GITHUB_TOKEN_MISS_TTL_MS, NO_RECORDED_DEPLOY_MAX,
} = await import('../src/scm.js');

const realFetch = globalThis.fetch;
type Route = [RegExp, { ok?: boolean; status?: number; body?: unknown }];
function routeFetch(routes: Route[]) {
  const spy = jest.fn(async (url: unknown, _init?: unknown) => {
    const u = String(url);
    for (const [re, r] of routes) {
      if (re.test(u)) {
        return { ok: r.ok ?? true, status: r.status ?? 200, headers: { get: () => null }, json: async () => r.body ?? {} };
      }
    }
    throw new Error(`unrouted fetch: ${u}`);
  });
  (globalThis as { fetch: unknown }).fetch = spy;
  return spy;
}

const commit = (date: string) => ({ commit: { committer: { date } } });
const GH = (sha: string) => ({ provider: 'github' as const, owner: 'acme', repo: 'app', sha });
const BASE_ROUTES: Route[] = [
  [/token\/exchange/, { body: { data: { accessToken: 'tok', expiresIn: 300 } } }],
  [/last-deploy-commit/, { body: { data: {} } }],
  [/compare\//, { body: { commits: [commit('2026-11-05T08:00:00Z'), commit('2026-11-06T08:00:00Z')] } }],
  [/api\.github\.com\/repos\/acme\/app\/commits\//, { body: commit('2026-11-07T10:00:00Z') }],
];

/** The Authorization header each GitHub call carried, in order. */
const githubAuth = (spy: ReturnType<typeof routeFetch>) => spy.mock.calls
  .filter((c) => String(c[0]).includes('api.github.com'))
  .map((c) => ((c[1] as { headers?: Record<string, string> })?.headers ?? {}).Authorization);

let now = 1_000_000;
beforeEach(() => {
  _resetScmForTests();
  jest.clearAllMocks();
  now = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  process.env.PLATFORM_BASE_URL = 'https://platform.test';
  process.env.PLATFORM_ACCESS_KEY = 'pb_sa_testkey';
  process.env.PLATFORM_SECRET_NAME = 'pipeline-builder/container-org/platform';
});

afterEach(() => {
  jest.restoreAllMocks();
  (globalThis as { fetch: unknown }).fetch = realFetch;
  delete process.env.PLATFORM_BASE_URL;
  delete process.env.PLATFORM_ACCESS_KEY;
  delete process.env.PLATFORM_SECRET_NAME;
});

describe('GitHub token cache', () => {
  it('negative-caches a transient GetSecretValue error for ~60s, then retries and caches the token', async () => {
    mockSend
      .mockRejectedValueOnce(Object.assign(new Error('slow down'), { name: 'ThrottlingException' }))
      .mockResolvedValue({ SecretString: 'ghp_token\n' });
    const spy = routeFetch(BASE_ROUTES);

    await resolveCommitInfo('p1', 'org-1', 'us-east-1', GH('sha1'));
    expect(mockSend).toHaveBeenCalledTimes(1);

    // Inside the miss window: no second secret read, still unauthenticated.
    now += GITHUB_TOKEN_MISS_TTL_MS - 1;
    await resolveCommitInfo('p2', 'org-1', 'us-east-1', GH('sha2'));
    expect(mockSend).toHaveBeenCalledTimes(1);

    // Past it: retried, and the token is now used.
    now += 2;
    await resolveCommitInfo('p3', 'org-1', 'us-east-1', GH('sha3'));
    expect(mockSend).toHaveBeenCalledTimes(2);

    // A READ token is cached for the container's life.
    now += 10 * GITHUB_TOKEN_MISS_TTL_MS;
    await resolveCommitInfo('p4', 'org-1', 'us-east-1', GH('sha4'));
    expect(mockSend).toHaveBeenCalledTimes(2);

    expect(githubAuth(spy)).toEqual([undefined, undefined, 'Bearer ghp_token', 'Bearer ghp_token']);
    expect(mockSend.mock.calls[0]?.[0]).toEqual({ SecretId: 'pipeline-builder/org-1/github-token' });
  });

  it('treats an empty secret as a short-lived miss, not a permanent one', async () => {
    mockSend.mockResolvedValueOnce({ SecretString: '' }).mockResolvedValue({ SecretString: 'ghp_later' });
    const spy = routeFetch(BASE_ROUTES);
    await resolveCommitInfo('p1', 'org-1', 'us-east-1', GH('sha1'));
    now += GITHUB_TOKEN_MISS_TTL_MS;
    await resolveCommitInfo('p2', 'org-1', 'us-east-1', GH('sha2'));
    expect(githubAuth(spy)).toEqual([undefined, 'Bearer ghp_later']);
  });

  it('keys the token per org', async () => {
    mockSend.mockImplementation(async (cmd) => ({ SecretString: `tok-${(cmd as { SecretId: string }).SecretId.split('/')[1]}` }));
    const spy = routeFetch(BASE_ROUTES);
    await resolveCommitInfo('p1', 'org-a', 'us-east-1', GH('sha1'));
    await resolveCommitInfo('p2', 'org-b', 'us-east-1', GH('sha2'));
    expect(githubAuth(spy)).toEqual(['Bearer tok-org-a', 'Bearer tok-org-b']);
  });
});

describe('never-deployed set', () => {
  it(`is capped at ${NO_RECORDED_DEPLOY_MAX} entries, evicting the oldest`, async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('nf'), { name: 'ResourceNotFoundException' }));
    const spy = routeFetch(BASE_ROUTES);
    for (let i = 0; i <= NO_RECORDED_DEPLOY_MAX; i++) {
      await resolveCommitInfo(`pipe-${i}`, 'org-1', 'us-east-1', GH(`sha-${i}`));
    }
    expect(_scmStateForTests().noRecordedDeploy).toBe(NO_RECORDED_DEPLOY_MAX);

    const lookups = (id: string) => spy.mock.calls.filter((c) => String(c[0]).includes(`last-deploy-commit?pipelineId=${id}`)).length;
    // The newest is still remembered (no re-ask); the oldest was evicted (re-asks once).
    await resolveCommitInfo(`pipe-${NO_RECORDED_DEPLOY_MAX}`, 'org-1', 'us-east-1', GH('again-newest'));
    await resolveCommitInfo('pipe-0', 'org-1', 'us-east-1', GH('again-oldest'));
    expect(lookups(`pipe-${NO_RECORDED_DEPLOY_MAX}`)).toBe(1);
    expect(lookups('pipe-0')).toBe(2);
  });
});

describe('range bound advances only on a successful deploy', () => {
  beforeEach(() => {
    mockSend.mockRejectedValue(Object.assign(new Error('nf'), { name: 'ResourceNotFoundException' }));
  });

  it('a non-deploy resolution leaves the bound alone (next sha resolves as a single commit)', async () => {
    const spy = routeFetch(BASE_ROUTES);
    await expect(resolveCommitInfo('p1', 'org-1', 'us-east-1', GH('sha1'))).resolves.toMatchObject({ commitCount: 1 });
    expect(_scmStateForTests('p1').lastSha).toBeUndefined();
    await expect(resolveCommitInfo('p1', 'org-1', 'us-east-1', GH('sha2'))).resolves.toMatchObject({ commitCount: 1 });
    expect(spy.mock.calls.some((c) => String(c[0]).includes('/compare/'))).toBe(false);
  });

  it('a successful deploy sets the bound, so the next sha resolves the compare range', async () => {
    const spy = routeFetch(BASE_ROUTES);
    await resolveCommitInfo('p1', 'org-1', 'us-east-1', GH('sha1'), { successfulDeploy: true });
    expect(_scmStateForTests('p1').lastSha).toBe('sha1');
    await expect(resolveCommitInfo('p1', 'org-1', 'us-east-1', GH('sha2')))
      .resolves.toEqual({ commitTimestamp: '2026-11-05T08:00:00.000Z', commitCount: 2 });
    expect(spy.mock.calls.some((c) => String(c[0]).includes('/compare/sha1...sha2'))).toBe(true);
  });

  it('a successful deploy of an already-resolved sha (cache hit) still advances the bound', async () => {
    routeFetch(BASE_ROUTES);
    await resolveCommitInfo('p1', 'org-1', 'us-east-1', GH('sha1')); // source event: resolves + caches
    expect(_scmStateForTests('p1').lastSha).toBeUndefined();
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () => { throw new Error('must not refetch'); });
    await resolveCommitInfo('p1', 'org-1', 'us-east-1', GH('sha1'), { successfulDeploy: true });
    expect(_scmStateForTests('p1').lastSha).toBe('sha1');
  });

  it('a successful deploy advances the bound even when its commit metadata did not resolve', async () => {
    routeFetch([...BASE_ROUTES.slice(0, 2), [/api\.github\.com/, { ok: false, status: 404 }]]);
    await expect(resolveCommitInfo('p1', 'org-1', 'us-east-1', GH('sha1'), { successfulDeploy: true })).resolves.toEqual({});
    expect(_scmStateForTests('p1').lastSha).toBe('sha1');
  });
});
