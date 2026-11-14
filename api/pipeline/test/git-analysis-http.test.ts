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

/**
 * The analyzers' own branches (they sat at 12.5% / 16.7% branch coverage): the
 * token header, a failed repo read, the fail-soft secondary reads, the entry-type
 * filters and the field fallbacks.
 */
describe('analyzeGitHubRepo', () => {
  const parsed = { host: 'github.com', owner: 'acme', repo: 'web', provider: 'github' } as any;
  const route = (by: Record<string, ReturnType<typeof safeRes>>) =>
    mockSafeFetch.mockImplementation(async (url: string) => {
      const key = Object.keys(by).find((k) => url.endsWith(k));
      return key ? by[key]! : safeRes('{}');
    });

  it('sends the token as a Bearer header only when one is given', async () => {
    route({ '/repos/acme/web': safeRes('{}'), '/languages': safeRes('{}'), '/contents/': safeRes('[]') });
    await analyzeGitHubRepo(parsed, 'ghp_x');
    expect((mockSafeFetch.mock.calls[0][1] as any).headers.Authorization).toBe('Bearer ghp_x');
    mockSafeFetch.mockClear();
    await analyzeGitHubRepo(parsed);
    expect((mockSafeFetch.mock.calls[0][1] as any).headers.Authorization).toBeUndefined();
  });

  it('throws on a failed repo read, naming the status', async () => {
    route({ '/repos/acme/web': safeRes('{}', { ok: false, status: 404, statusText: 'Not Found' }) });
    await expect(analyzeGitHubRepo(parsed)).rejects.toThrow('GitHub API error: 404 Not Found');
  });

  it('reads metadata, languages and root entries (files and dirs only)', async () => {
    route({
      '/repos/acme/web': safeRes(JSON.stringify({ default_branch: 'trunk', description: 'web app', topics: ['cdk'] })),
      '/languages': safeRes(JSON.stringify({ TypeScript: 900 })),
      '/contents/': safeRes(JSON.stringify([
        { name: 'package.json', type: 'file' }, { name: 'src', type: 'dir' }, { name: 'link', type: 'symlink' }, { name: 'Dockerfile', type: 'file' },
      ])),
    });
    const a = await analyzeGitHubRepo(parsed);
    expect(a).toEqual(expect.objectContaining({
      defaultBranch: 'trunk',
      description: 'web app',
      topics: ['cdk'],
      languages: { TypeScript: 900 },
      detectedFiles: ['package.json', 'src', 'Dockerfile'],
      hasDockerfile: true,
      projectType: 'nodejs',
    }));
  });

  it('degrades a failed languages / contents read to empty, and falls back on missing fields', async () => {
    route({
      '/repos/acme/web': safeRes('{}'),
      '/languages': safeRes('', { ok: false, status: 403 }),
      '/contents/': safeRes('', { ok: false, status: 404 }),
    });
    const a = await analyzeGitHubRepo(parsed);
    expect(a).toEqual(expect.objectContaining({ defaultBranch: 'main', description: '', topics: [], languages: {}, detectedFiles: [] }));
  });
});

describe('analyzeBitbucketRepo', () => {
  const parsed = { host: 'bitbucket.org', owner: 'acme', repo: 'svc', provider: 'bitbucket' } as any;
  const route = (repo: ReturnType<typeof safeRes>, src: ReturnType<typeof safeRes>) =>
    mockSafeFetch.mockImplementation(async (url: string) => (url.includes('/src/') ? src : repo));

  it('sends the token as a Bearer header only when one is given', async () => {
    route(safeRes('{}'), safeRes('{}'));
    await analyzeBitbucketRepo(parsed, 'app-pw');
    expect((mockSafeFetch.mock.calls[0][1] as any).headers.Authorization).toBe('Bearer app-pw');
    mockSafeFetch.mockClear();
    await analyzeBitbucketRepo(parsed);
    expect((mockSafeFetch.mock.calls[0][1] as any).headers.Authorization).toBeUndefined();
  });

  it('throws on a failed repo read, naming the status', async () => {
    route(safeRes('{}', { ok: false, status: 401, statusText: 'Unauthorized' }), safeRes('{}'));
    await expect(analyzeBitbucketRepo(parsed)).rejects.toThrow('Bitbucket API error: 401 Unauthorized');
  });

  it('reads the main branch, the single language and the commit entries', async () => {
    route(
      safeRes(JSON.stringify({ mainbranch: { name: 'develop' }, language: 'python', description: 'svc' })),
      safeRes(JSON.stringify({
        values: [
          { path: 'requirements.txt', type: 'commit_file' }, { path: 'app', type: 'commit_directory' }, { path: 'x', type: 'commit_link' },
        ],
      })),
    );
    const a = await analyzeBitbucketRepo(parsed);
    expect(a).toEqual(expect.objectContaining({
      defaultBranch: 'develop',
      description: 'svc',
      topics: [],
      languages: { python: 100 },
      detectedFiles: ['requirements.txt', 'app'],
      projectType: 'python',
    }));
  });

  it('degrades a failed src read and a values-less body to no files, and falls back on missing fields', async () => {
    route(safeRes('{}'), safeRes('', { ok: false, status: 500 }));
    expect(await analyzeBitbucketRepo(parsed)).toEqual(expect.objectContaining({
      defaultBranch: 'main', description: '', languages: {}, detectedFiles: [],
    }));
    route(safeRes('{}'), safeRes('{}'));
    expect((await analyzeBitbucketRepo(parsed)).detectedFiles).toEqual([]);
  });
});
