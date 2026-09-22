// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// git-analysis SSRF posture: every outbound provider call goes through api-core's
// pinned-connection `safeFetch` (resolve → PIN the vetted IP → refuse redirects →
// cap body + time), NOT the old `assertSafeUrl`-then-global-`fetch` pattern that
// left a DNS-rebinding window. These assert (a) the guard rejects before any
// connection, (b) a refused redirect is a hard failure (never retried, never
// read), (c) a 5xx is retried, (d) the body cap is passed down, and (e) the
// analyzers encodeURIComponent their path segments.

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

type SafeFetchArgs = [string, Record<string, unknown>?];
const mockSafeFetch = jest.fn<(...a: SafeFetchArgs) => Promise<any>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  safeFetch: (...args: SafeFetchArgs) => mockSafeFetch(...args),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  CoreConstants: {
    GITHUB_API_BASE_URL: 'https://api.github.com',
    BITBUCKET_API_BASE_URL: 'https://api.bitbucket.org/2.0',
  },
}));

const { fetchWithTimeout, MAX_RESPONSE_BYTES } = await import('../src/services/git-analysis/http.js');
const { analyzeGitHubRepo } = await import('../src/services/git-analysis/github-analyzer.js');
const { analyzeBitbucketRepo } = await import('../src/services/git-analysis/bitbucket-analyzer.js');

/** Minimal SafeFetchResponse double. */
function safeRes(body: string, over: Record<string, unknown> = {}) {
  const buf = Buffer.from(body, 'utf8');
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    redirected: false,
    headers: {},
    body: buf,
    text: () => body,
    json: () => JSON.parse(body),
    ...over,
  };
}

beforeEach(() => {
  mockSafeFetch.mockReset();
  mockSafeFetch.mockImplementation(async () => safeRes('{}'));
});

describe('fetchWithTimeout', () => {
  it('rejects (without a second attempt) when safeFetch refuses an unsafe host', async () => {
    mockSafeFetch.mockRejectedValue(new Error('url resolves to a private address'));
    await expect(fetchWithTimeout('https://169.254.169.254/latest/meta-data'))
      .rejects.toThrow('private address');
  });

  it('passes the https-only guard, per-attempt timeout and body cap down to safeFetch', async () => {
    await fetchWithTimeout('https://api.github.com/repos/a/b', { headers: { Accept: 'x' } });

    expect(mockSafeFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/a/b',
      expect.objectContaining({
        headers: { Accept: 'x' },
        protocols: ['https:'],
        maxResponseBytes: MAX_RESPONSE_BYTES,
        timeoutMs: expect.any(Number),
      }),
    );
  });

  it('treats a refused redirect as a hard failure — never retried, body never read', async () => {
    const redirect = safeRes('', { ok: false, status: 302, redirected: true, json: () => { throw new Error('read'); } });
    mockSafeFetch.mockResolvedValue(redirect);

    await expect(fetchWithTimeout('https://api.github.com/repos/a/b')).rejects.toThrow(/redirected \(refused\)/);
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx and returns the successful attempt', async () => {
    const bad = safeRes('boom', { ok: false, status: 500, statusText: 'Server Error' });
    const good = safeRes('{}');
    mockSafeFetch.mockResolvedValueOnce(bad).mockResolvedValueOnce(good);

    const out = await fetchWithTimeout('https://api.github.com/repos/a/b');

    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
    expect(out).toBe(good);
  });
});

describe('analyzer path-segment encoding', () => {
  it('encodeURIComponent-s owner/repo so a traversal owner cannot escape api.github.com', async () => {
    mockSafeFetch.mockImplementation(async () => safeRes(JSON.stringify({ default_branch: 'main' })));

    await analyzeGitHubRepo({ host: 'github.com', owner: '../../evil', repo: 'x', provider: 'github' } as any).catch(() => {});

    const urls: string[] = mockSafeFetch.mock.calls.map((c) => c[0]);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => !u.includes('../'))).toBe(true);
    expect(urls[0]).toContain(encodeURIComponent('../../evil'));
  });

  it('encodeURIComponent-s owner/repo for Bitbucket', async () => {
    mockSafeFetch.mockImplementation(async () => safeRes(JSON.stringify({ mainbranch: { name: 'main' } })));

    await analyzeBitbucketRepo({ host: 'bitbucket.org', owner: '..%2f..', repo: 'x/y', provider: 'bitbucket' } as any).catch(() => {});

    const urls: string[] = mockSafeFetch.mock.calls.map((c) => c[0]);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => !u.includes('/x/y'))).toBe(true);
    expect(urls[0]).toContain(encodeURIComponent('x/y'));
  });
});
