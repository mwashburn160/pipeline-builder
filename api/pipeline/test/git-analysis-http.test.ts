// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Fix 3 — git-analysis SSRF defense-in-depth: fetchWithTimeout must (a) refuse
// redirects, (b) run the shared assertSafeUrl guard, (c) release the body on a
// 5xx retry; the analyzers must encodeURIComponent path segments; and
// readJsonCapped must reject oversized bodies before parsing.

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockAssertSafeUrl = jest.fn<(...a: any[]) => Promise<void>>().mockResolvedValue(undefined);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  assertSafeUrl: (...args: any[]) => mockAssertSafeUrl(...args),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  CoreConstants: {
    GITHUB_API_BASE_URL: 'https://api.github.com',
    BITBUCKET_API_BASE_URL: 'https://api.bitbucket.org/2.0',
  },
}));

const { fetchWithTimeout, readJsonCapped, MAX_RESPONSE_BYTES } = await import('../src/services/git-analysis/http.js');
const { analyzeGitHubRepo } = await import('../src/services/git-analysis/github-analyzer.js');
const { analyzeBitbucketRepo } = await import('../src/services/git-analysis/bitbucket-analyzer.js');

const realFetch = global.fetch;

/** Minimal streaming-Response double with a single-chunk body + spies. */
function streamRes(body: string, opts: { contentLength?: string } = {}) {
  const bytes = new TextEncoder().encode(body);
  const cancel = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  let sent = false;
  return {
    status: 200,
    ok: true,
    statusText: 'OK',
    headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? (opts.contentLength ?? null) : null) },
    body: {
      cancel,
      getReader: () => ({
        read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes })),
        cancel: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      }),
    },
    _cancel: cancel,
  } as any;
}

beforeEach(() => {
  mockAssertSafeUrl.mockResolvedValue(undefined);
});
afterEach(() => {
  global.fetch = realFetch;
});

describe('fetchWithTimeout', () => {
  it('runs the SSRF guard and rejects (without fetching) when the host is unsafe', async () => {
    mockAssertSafeUrl.mockRejectedValueOnce(new Error('url resolves to a private address'));
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;

    await expect(fetchWithTimeout('https://169.254.169.254/latest/meta-data')).rejects.toThrow('private address');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses redirects by passing redirect: "error" to fetch', async () => {
    const fetchSpy = jest.fn<(...a: any[]) => Promise<any>>().mockResolvedValue(streamRes('{}'));
    global.fetch = fetchSpy as any;

    await fetchWithTimeout('https://api.github.com/repos/a/b', { headers: { Accept: 'x' } });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.github.com/repos/a/b',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('retries a 5xx and cancels the failed attempt body before retrying', async () => {
    const bad = streamRes('boom');
    bad.status = 500;
    bad.statusText = 'Server Error';
    const good = streamRes('{}');
    const fetchSpy = jest.fn<(...a: any[]) => Promise<any>>()
      .mockResolvedValueOnce(bad)
      .mockResolvedValueOnce(good);
    global.fetch = fetchSpy as any;

    const out = await fetchWithTimeout('https://api.github.com/repos/a/b');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(bad._cancel).toHaveBeenCalled(); // failed 5xx body released
    expect(out).toBe(good);
  });
});

describe('readJsonCapped', () => {
  it('rejects (and cancels) a body whose Content-Length exceeds the cap', async () => {
    const cancel = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const res = {
      headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(MAX_RESPONSE_BYTES + 1) : null) },
      body: { cancel },
    } as any;

    await expect(readJsonCapped(res)).rejects.toThrow(/exceeds/);
    expect(cancel).toHaveBeenCalled();
  });

  it('rejects an oversized streamed body even when Content-Length is absent', async () => {
    const res = streamRes('x'.repeat(100)); // no content-length header
    await expect(readJsonCapped(res, 50)).rejects.toThrow(/exceeds/);
  });

  it('parses a normal JSON body', async () => {
    const res = streamRes(JSON.stringify({ default_branch: 'main' }));
    await expect(readJsonCapped(res)).resolves.toEqual({ default_branch: 'main' });
  });

  it('falls back to text() when the response has no stream body', async () => {
    const res = {
      headers: { get: () => null },
      text: async () => JSON.stringify({ ok: true }),
    } as any;
    await expect(readJsonCapped(res)).resolves.toEqual({ ok: true });
  });
});

describe('analyzer path-segment encoding', () => {
  it('encodeURIComponent-s owner/repo so a traversal owner cannot escape api.github.com', async () => {
    const fetchSpy = jest.fn<(...a: any[]) => Promise<any>>()
      .mockImplementation(async () => streamRes(JSON.stringify({ default_branch: 'main' })));
    global.fetch = fetchSpy as any;

    await analyzeGitHubRepo({ host: 'github.com', owner: '../../evil', repo: 'x', provider: 'github' } as any).catch(() => {});

    const urls: string[] = fetchSpy.mock.calls.map((c) => c[0] as string);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => !u.includes('../'))).toBe(true);
    expect(urls[0]).toContain(encodeURIComponent('../../evil'));
    // The guard saw every outbound URL (defense-in-depth).
    expect(mockAssertSafeUrl).toHaveBeenCalled();
  });

  it('encodeURIComponent-s owner/repo for Bitbucket', async () => {
    const fetchSpy = jest.fn<(...a: any[]) => Promise<any>>()
      .mockImplementation(async () => streamRes(JSON.stringify({ mainbranch: { name: 'main' } })));
    global.fetch = fetchSpy as any;

    await analyzeBitbucketRepo({ host: 'bitbucket.org', owner: '..%2f..', repo: 'x/y', provider: 'bitbucket' } as any).catch(() => {});

    const urls: string[] = fetchSpy.mock.calls.map((c) => c[0] as string);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => !u.includes('/x/y'))).toBe(true);
    expect(urls[0]).toContain(encodeURIComponent('x/y'));
  });
});
