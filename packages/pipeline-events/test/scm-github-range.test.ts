// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * GitHub commit resolution: the compare range, its fallbacks, and the
 * rate-limit cooldown.
 *
 * `scm.ts` had the package's second-worst branch coverage (73%), and the gap
 * was not in its error swallowing — it was in the RANGE logic that decides what
 * commit metadata reaches reporting. A compare that is rate-limited, non-2xx or
 * empty must each fall back differently, and getting that wrong does not throw:
 * it silently ships a DORA lead time measured from the wrong commit.
 *
 * `classifySource` is covered here too, for the one branch a malformed URL
 * takes.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSend })),
  GetSecretValueCommand: jest.fn((params: unknown) => params),
}));

const { classifySource, resolveCommitInfo, _resetScmForTests } = await import('../src/scm.js');

const realFetch = globalThis.fetch;
/** Route each GitHub URL to a canned response; unmatched URLs fail loudly. */
function routeFetch(routes: Array<[RegExp, { ok?: boolean; status?: number; body?: unknown; headers?: Record<string, string> }]>) {
  const spy = jest.fn(async (url: unknown) => {
    const u = String(url);
    for (const [re, r] of routes) {
      if (re.test(u)) {
        return {
          ok: r.ok ?? true,
          status: r.status ?? 200,
          headers: { get: (h: string) => r.headers?.[h.toLowerCase()] ?? null },
          json: async () => r.body ?? {},
        };
      }
    }
    throw new Error(`unrouted fetch: ${u}`);
  });
  (globalThis as { fetch: unknown }).fetch = spy;
  return spy;
}

const GH = { provider: 'github' as const, owner: 'acme', repo: 'app', sha: 'headsha' };
const commit = (date: string) => ({ commit: { committer: { date } } });

beforeEach(() => {
  _resetScmForTests();
  jest.clearAllMocks();
  // No token secret: resolution proceeds unauthenticated, which is the path a
  // deployment without `github-token` actually takes.
  mockSend.mockRejectedValue(Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' }));
  process.env.PLATFORM_BASE_URL = 'https://platform.test';
  // A usable key: `fetchLastDeployedSha` authenticates, and without a token it
  // fails closed — which silently collapses every range to a single commit and
  // would make the compare tests below pass for the wrong reason.
  process.env.PLATFORM_ACCESS_KEY = 'pb_sa_testkey';
});

afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
  delete process.env.PLATFORM_BASE_URL;
  delete process.env.PLATFORM_ACCESS_KEY;
});

describe('classifySource', () => {
  it.each([
    ['https://github.com/acme/app.git', 'github'],
    ['https://bitbucket.org/acme/app.git', 'bitbucket'],
  ])('recognises %s as %s', (url, provider) => {
    expect(classifySource(url).provider).toBe(provider);
  });

  it.each([
    ['not-a-url'],
    [''],
    [undefined],
  ])('falls back to unknown for %s rather than throwing', (url) => {
    // The `catch {}` around `new URL(...)`: a malformed CodePipeline source
    // configuration must degrade to "no commit info", not fail the batch.
    expect(classifySource(url as string | undefined).provider).toBe('unknown');
  });
});

describe('resolveCommitInfo — GitHub', () => {
  it('returns nothing for an unknown provider without calling out', async () => {
    const spy = routeFetch([]);
    await expect(resolveCommitInfo('p1', 'org-1', 'us-east-1', { provider: 'unknown', sha: 'x' })).resolves.toEqual({});
    expect(spy).not.toHaveBeenCalled();
  });

  it('uses the single-commit endpoint when there is no previous sha', async () => {
    // No prior deploy: the reporting lookup answers "none", so the range
    // collapses to the newest commit — which still counts as ONE commit
    // shipped, not as an absent count.
    routeFetch([
      [/token\/exchange/, { body: { data: { accessToken: 'tok', expiresIn: 300 } } }],
      [/last-deploy-commit/, { body: { data: {} } }],
      [/commits\/headsha/, { body: commit('2026-11-07T10:00:00Z') }],
    ]);
    await expect(resolveCommitInfo('p1', 'org-1', 'us-east-1', GH))
      .resolves.toEqual({ commitTimestamp: '2026-11-07T10:00:00.000Z', commitCount: 1 });
  });

  it('uses the COMPARE range when a previous sha is known, and counts it', async () => {
    // The lead-time path: oldest commit in the range, and how many shipped.
    routeFetch([
      [/token\/exchange/, { body: { data: { accessToken: 'tok', expiresIn: 300 } } }],
      [/last-deploy-commit/, { body: { data: { commitSha: 'prevsha' } } }],
      [/compare\/prevsha\.\.\.headsha/, {
        body: { commits: [commit('2026-11-05T08:00:00Z'), commit('2026-11-06T09:00:00Z')] },
      }],
    ]);
    await expect(resolveCommitInfo('p1', 'org-1', 'us-east-1', GH))
      .resolves.toEqual({ commitTimestamp: '2026-11-05T08:00:00.000Z', commitCount: 2 });
  });

  it('falls through to the single commit when the compare is non-2xx', async () => {
    // A deleted or force-pushed base sha makes compare 404. Falling back is
    // what keeps a timestamp on the event instead of dropping it.
    routeFetch([
      [/token\/exchange/, { body: { data: { accessToken: 'tok', expiresIn: 300 } } }],
      [/last-deploy-commit/, { body: { data: { commitSha: 'prevsha' } } }],
      [/compare\//, { ok: false, status: 404 }],
      [/commits\/headsha/, { body: commit('2026-11-07T11:00:00Z') }],
    ]);
    await expect(resolveCommitInfo('p1', 'org-1', 'us-east-1', GH))
      .resolves.toEqual({ commitTimestamp: '2026-11-07T11:00:00.000Z', commitCount: 1 });
  });

  it('falls through when the compare succeeds but lists no commits', async () => {
    // Same sha on both ends, or a range GitHub reports as empty.
    routeFetch([
      [/token\/exchange/, { body: { data: { accessToken: 'tok', expiresIn: 300 } } }],
      [/last-deploy-commit/, { body: { data: { commitSha: 'prevsha' } } }],
      [/compare\//, { body: { commits: [] } }],
      [/commits\/headsha/, { body: commit('2026-11-07T12:00:00Z') }],
    ]);
    await expect(resolveCommitInfo('p1', 'org-1', 'us-east-1', GH))
      .resolves.toEqual({ commitTimestamp: '2026-11-07T12:00:00.000Z', commitCount: 1 });
  });

  it('stops calling GitHub for a cooldown after a rate limit', async () => {
    // The protection that matters under a catalogue-sized burst: once GitHub
    // rate-limits, further resolutions must return empty WITHOUT calling out,
    // or every event in the batch spends another request earning a 403.
    const spy = routeFetch([
      [/token\/exchange/, { body: { data: { accessToken: 'tok', expiresIn: 300 } } }],
      [/last-deploy-commit/, { body: { data: {} } }],
      [/api\.github\.com/, { ok: false, status: 403, headers: { 'x-ratelimit-remaining': '0' } }],
    ]);
    await expect(resolveCommitInfo('p1', 'org-1', 'us-east-1', GH)).resolves.toEqual({});
    const callsAfterFirst = spy.mock.calls.length;

    // A DIFFERENT pipeline and sha, so neither result cache nor sha cache answers.
    await expect(resolveCommitInfo('p2', 'org-1', 'us-east-1', { ...GH, sha: 'othersha' })).resolves.toEqual({});
    const githubCalls = spy.mock.calls.filter((c) => String(c[0]).includes('api.github.com')).length;
    expect({ grew: spy.mock.calls.length > callsAfterFirst, githubCalls })
      .toEqual({ grew: true, githubCalls: 1 });
  });

  it('caches a resolved result per pipeline+sha', async () => {
    routeFetch([
      [/token\/exchange/, { body: { data: { accessToken: 'tok', expiresIn: 300 } } }],
      [/last-deploy-commit/, { body: { data: {} } }],
      [/commits\/headsha/, { body: commit('2026-11-07T13:00:00Z') }],
    ]);
    const first = await resolveCommitInfo('p1', 'org-1', 'us-east-1', GH);
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () => { throw new Error('must not refetch'); });
    await expect(resolveCommitInfo('p1', 'org-1', 'us-east-1', GH)).resolves.toEqual(first);
  });
});
