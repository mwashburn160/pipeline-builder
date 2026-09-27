// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The UNAUTHENTICATED half: a shared report, and a recipient confirming their own
 * address.
 *
 * This is the only surface in the service with no session behind it, so the tests
 * are about what it refuses to reveal and what it refuses to count:
 *
 *  - ONE indistinguishable 404 for unknown, revoked, expired and withdrawn links,
 *    so a dead link teaches nothing;
 *  - noindex / no-referrer / private-no-store on EVERY response, including the
 *    404s — the URL is the credential;
 *  - link unfurlers and mail scanners are served but NOT counted, so a view count
 *    means a person read it;
 *  - name redaction removes internal project names while keeping the shape of the
 *    data;
 *  - the confirmation is a POST, and a bad token gets the same answer as an
 *    expired one.
 */

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockSendSuccess = jest.fn((_res: any, code: number, data: any) => ({ code, data }));
const mockSendError = jest.fn((_res: any, code: number, msg: string, errorCode?: string) => ({ code, msg, errorCode }));

const store = {
  resolveShareLink: jest.fn<AnyFn>(),
  recordShareView: jest.fn<AnyFn>(),
  verifyRecipientByToken: jest.fn<AnyFn>(),
};

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), identity: {}, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: '', userId: '' });
  },
  rateLimitByOrg: (opts: any) => Object.assign((_req: any, _res: any, next: any) => next(), { limiterOpts: opts }),
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: mockSendSuccess,
  sendError: mockSendError,
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  stakeholderReportStore: store,
}));

const { createPublicReportRoutes, isPreviewFetch, redactNames } = await import('../src/routes/public-reports.js');

const NOW = new Date('2026-09-21T12:00:00.000Z');
const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';

const link = (over: Record<string, unknown> = {}) => ({
  id: 'link-1',
  orgId: 'acme',
  runId: 'run-1',
  expiresAt: new Date('2026-10-21T12:00:00.000Z'),
  revokedAt: null,
  redactNames: false,
  viewCount: 3,
  ...over,
});

const run = (over: Record<string, unknown> = {}) => ({
  id: 'run-1',
  periodLabel: '2026-W37',
  periodStart: new Date('2026-09-07T05:00:00.000Z'),
  periodEnd: new Date('2026-09-14T05:00:00.000Z'),
  version: 1,
  publishedAt: NOW,
  leadNotes: 'We paused deploys Tuesday for the migration.',
  snapshot: { sections: [{ id: 'success_rate', current: [{ project: 'atlas-migration', total: 12 }] }] },
  ...over,
});

describe('public report routes', () => {
  let router: any;
  const headers = new Map<string, string>();
  const res = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    setHeader: jest.fn((k: string, v: string) => { headers.set(k, v); }),
  });

  const layers = (path: string, method: string) =>
    router.stack.find((l: any) => l.route?.path === path && l.route?.methods[method])?.route?.stack ?? [];
  const handler = (path: string, method: string) => {
    const stack = layers(path, method);
    if (stack.length === 0) throw new Error(`No ${method.toUpperCase()} ${path}`);
    return stack[stack.length - 1].handle;
  };
  /** Run the router-level middleware (the header pass) then the handler. */
  const call = async (path: string, method: string, req: any = {}) => {
    const request = { params: {}, query: {}, body: {}, headers: {}, method: method.toUpperCase(), ip: '203.0.113.9', ...req };
    const response = res();
    for (const layer of router.stack.filter((l: any) => !l.route)) {
      await new Promise<void>((resolve) => { layer.handle(request, response, () => resolve()); });
    }
    await handler(path, method)(request, response);
    return response;
  };
  const payload = () => mockSendSuccess.mock.calls[0]?.[2] as any;

  beforeEach(() => {
    jest.clearAllMocks();
    headers.clear();
    store.recordShareView.mockResolvedValue(undefined);
    router = createPublicReportRoutes();
  });

  // ── Bot detection (pure) ──────────────────────────────────────────────────

  describe('isPreviewFetch', () => {
    const ua = (agent: string) => isPreviewFetch({ method: 'GET', headers: { 'user-agent': agent } } as any);

    it('treats an ordinary browser as a real read', () => {
      expect(ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0 Safari/537.36')).toBe(false);
      expect(ua('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1')).toBe(false);
    });

    it.each([
      ['Slack unfurling a pasted link', 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'],
      ['Microsoft 365 Safe Links detonation', 'Mozilla/5.0 (compatible; safelinks)'],
      ['an Outlook card prefetch', 'Microsoft Office Outlook 16.0'],
      ['a mail security gateway', 'Mimecast URL Protect'],
      ['a search crawler', 'Googlebot/2.1'],
      ['a script', 'curl/8.7.1'],
    ])('does not count %s', (_case, agent) => {
      expect(ua(agent)).toBe(true);
    });

    it('does not count a HEAD, which cannot render anything', () => {
      expect(isPreviewFetch({ method: 'HEAD', headers: { 'user-agent': 'Chrome' } } as any)).toBe(true);
    });

    it('does not count a request with no user agent at all', () => {
      expect(isPreviewFetch({ method: 'GET', headers: {} } as any)).toBe(true);
    });

    it('does not count a browser prefetch — the person has not opened it', () => {
      expect(isPreviewFetch({ method: 'GET', headers: { 'user-agent': 'Chrome', 'purpose': 'prefetch' } } as any)).toBe(true);
      expect(isPreviewFetch({ method: 'GET', headers: { 'user-agent': 'Chrome', 'sec-purpose': 'prefetch;prerender' } } as any)).toBe(true);
    });
  });

  // ── Redaction (pure) ──────────────────────────────────────────────────────

  describe('redactNames', () => {
    it('replaces internal names but keeps the numbers and the shape', () => {
      const redacted = redactNames({
        sections: [{ id: 'success_rate', rows: [{ project: 'atlas-migration', total: 12 }, { project: 'billing-rewrite', total: 3 }] }],
      }) as any;
      const rows = redacted.sections[0].rows;
      expect(rows).toEqual([
        { project: 'Pipeline 1', total: 12 },
        { project: 'Pipeline 2', total: 3 },
      ]);
      expect(redacted.sections[0].id).toBe('success_rate');
    });

    it('gives one name the SAME placeholder everywhere, so series stay comparable', () => {
      const redacted = redactNames({
        a: [{ pipeline: 'atlas' }, { pipeline: 'billing' }],
        b: [{ pipeline: 'atlas' }],
      }) as any;
      expect(redacted.a[0].pipeline).toBe(redacted.b[0].pipeline);
      expect(redacted.a[1].pipeline).not.toBe(redacted.a[0].pipeline);
    });

    it('leaves non-name values, nulls and primitives alone', () => {
      expect(redactNames({ total: 7, ok: true, missing: null, note: 'deploys paused' }))
        .toEqual({ total: 7, ok: true, missing: null, note: 'deploys paused' });
      expect(redactNames(null)).toBeNull();
      expect(redactNames(5)).toBe(5);
    });

    it('redacts through nested arrays and objects', () => {
      const redacted = redactNames({ envs: [{ name: 'prod-atlas', stages: [{ pipelineName: 'atlas-deploy' }] }] }) as any;
      expect(redacted.envs[0].name).toMatch(/^Pipeline \d+$/);
      expect(redacted.envs[0].stages[0].pipelineName).toMatch(/^Pipeline \d+$/);
    });
  });

  // ── The shared report ─────────────────────────────────────────────────────

  describe('GET /reports/:token', () => {
    it('serves the published snapshot and its expiry', async () => {
      store.resolveShareLink.mockResolvedValue({ link: link(), run: run() });
      await call('/reports/:token', 'get', { params: { token: TOKEN } });
      expect(payload().report).toMatchObject({ periodLabel: '2026-W37', version: 1, namesRedacted: false });
      expect(payload().report.leadNotes).toContain('paused deploys');
      expect(payload().expiresAt).toBe('2026-10-21T12:00:00.000Z');
    });

    /**
     * ONE 404 FOR EVERYTHING. Someone holding a dead link learns that it does not
     * work and nothing else — not that it once did, not that the org exists, not
     * that the report was withdrawn.
     */
    it('answers one indistinguishable 404 for anything that does not resolve', async () => {
      // The store already collapses unknown / revoked / expired / withdrawn into a
      // single null (its own suite pins each case), so the route has exactly one
      // failure answer and cannot accidentally grow a second.
      store.resolveShareLink.mockResolvedValue(null);
      await call('/reports/:token', 'get', { params: { token: TOKEN } });
      expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 404, expect.stringContaining('not available'), 'NOT_FOUND');
    });

    it('refuses a malformed token without touching the database', async () => {
      await call('/reports/:token', 'get', { params: { token: 'short' } });
      expect(store.resolveShareLink).not.toHaveBeenCalled();
      expect(mockSendError.mock.calls[0][1]).toBe(404);
    });

    it('refuses a token with characters outside the alphabet', async () => {
      await call('/reports/:token', 'get', { params: { token: `${TOKEN}/../../etc/passwd` } });
      expect(store.resolveShareLink).not.toHaveBeenCalled();
    });

    it('never puts the token in the 404 message', async () => {
      store.resolveShareLink.mockResolvedValue(null);
      await call('/reports/:token', 'get', { params: { token: TOKEN } });
      expect(JSON.stringify(mockSendError.mock.calls[0])).not.toContain(TOKEN);
    });

    /** The URL is the credential — these three headers keep it from spreading. */
    it('sets noindex, no-referrer and private-no-store on a success', async () => {
      store.resolveShareLink.mockResolvedValue({ link: link(), run: run() });
      await call('/reports/:token', 'get', { params: { token: TOKEN } });
      expect(headers.get('X-Robots-Tag')).toContain('noindex');
      expect(headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(headers.get('Cache-Control')).toContain('private');
      expect(headers.get('Cache-Control')).toContain('no-store');
      expect(headers.get('X-Frame-Options')).toBe('DENY');
      expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    });

    it('sets them on a 404 too — a refused URL is still a URL in a log', async () => {
      store.resolveShareLink.mockResolvedValue(null);
      await call('/reports/:token', 'get', { params: { token: TOKEN } });
      expect(headers.get('X-Robots-Tag')).toContain('noindex');
      expect(headers.get('Referrer-Policy')).toBe('no-referrer');
    });

    it('counts a real browser read', async () => {
      store.resolveShareLink.mockResolvedValue({ link: link(), run: run() });
      await call('/reports/:token', 'get', {
        params: { token: TOKEN },
        headers: { 'user-agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/141.0 Safari/537.36' },
      });
      expect(store.recordShareView).toHaveBeenCalled();
    });

    /**
     * A link pasted into Slack is fetched by Slack. Counting that tells the lead
     * their manager read the report when nobody has.
     */
    it('serves an unfurler the report but does not count it', async () => {
      store.resolveShareLink.mockResolvedValue({ link: link(), run: run() });
      await call('/reports/:token', 'get', {
        params: { token: TOKEN },
        headers: { 'user-agent': 'Slackbot-LinkExpanding 1.0' },
      });
      expect(mockSendSuccess).toHaveBeenCalled();
      expect(store.recordShareView).not.toHaveBeenCalled();
    });

    it('still serves the report when the view counter fails', async () => {
      store.resolveShareLink.mockResolvedValue({ link: link(), run: run() });
      store.recordShareView.mockRejectedValue(new Error('redis down'));
      await call('/reports/:token', 'get', {
        params: { token: TOKEN },
        headers: { 'user-agent': 'Mozilla/5.0 Chrome/141.0 Safari/537.36' },
      });
      expect(mockSendSuccess).toHaveBeenCalled();
    });

    it('redacts internal names when the link was minted that way', async () => {
      store.resolveShareLink.mockResolvedValue({ link: link({ redactNames: true }), run: run() });
      await call('/reports/:token', 'get', { params: { token: TOKEN } });
      const body = JSON.stringify(payload());
      expect(body).not.toContain('atlas-migration');
      expect(payload().report.namesRedacted).toBe(true);
      expect(payload().report.snapshot.sections[0].current[0].total).toBe(12);
    });

    /**
     * A link preview card in a chat channel is seen by everyone in the channel, so
     * it must not carry the org, the team or the numbers.
     */
    it('tolerates a run that was never published through a link (no publishedAt)', async () => {
      store.resolveShareLink.mockResolvedValue({ link: link(), run: run({ publishedAt: null, leadNotes: null }) });
      await call('/reports/:token', 'get', { params: { token: TOKEN } });
      expect(payload().report.publishedAt).toBeNull();
      expect(payload().report.leadNotes).toBeNull();
    });

    it('serves generic preview metadata with nothing org-specific in it', async () => {
      store.resolveShareLink.mockResolvedValue({ link: link(), run: run() });
      await call('/reports/:token', 'get', { params: { token: TOKEN } });
      const preview = JSON.stringify(payload().preview);
      expect(preview).not.toContain('acme');
      expect(preview).not.toContain('2026-W37');
      expect(payload().preview.title).toBe('Engineering delivery report');
    });

    it('rate-limits per client IP, not per org', () => {
      const limiter = layers('/reports/:token', 'get')
        .map((l: any) => (l.handle as any).limiterOpts)
        .find(Boolean);
      expect(limiter).toMatchObject({ name: 'public-report-read', keyBy: 'ip', max: 60 });
    });
  });

  // ── Recipient confirmation ────────────────────────────────────────────────

  describe('POST /report-recipients/verify', () => {
    it('confirms an address and echoes only that address', async () => {
      store.verifyRecipientByToken.mockResolvedValue({ id: 'rec-1', email: 'manager@acme.test' });
      await call('/report-recipients/verify', 'post', { body: { token: TOKEN } });
      expect(payload()).toEqual({ verified: true, email: 'manager@acme.test' });
    });

    /**
     * The same answer for expired, already-used and never-existed: the person's
     * next action is identical, and distinguishing them would make this an oracle
     * for which addresses are on an org's distribution list.
     */
    it('gives one answer for every kind of bad token', async () => {
      store.verifyRecipientByToken.mockResolvedValue(null);
      await call('/report-recipients/verify', 'post', { body: { token: TOKEN } });
      expect(mockSendError).toHaveBeenCalledWith(
        expect.anything(), 400, expect.stringContaining('no longer valid'), 'VALIDATION_ERROR',
      );
    });

    it('rejects a missing or malformed token before any lookup', async () => {
      await call('/report-recipients/verify', 'post', { body: {} });
      expect(store.verifyRecipientByToken).not.toHaveBeenCalled();
      await call('/report-recipients/verify', 'post', { body: { token: 'tiny' } });
      expect(store.verifyRecipientByToken).not.toHaveBeenCalled();
    });

    it('rejects a body carrying anything besides the token', async () => {
      await call('/report-recipients/verify', 'post', { body: { token: TOKEN, email: 'someone@else.test' } });
      expect(store.verifyRecipientByToken).not.toHaveBeenCalled();
    });

    /** A GET here would let a mail scanner consume the confirmation. */
    it('is not exposed as a GET', () => {
      expect(layers('/report-recipients/verify', 'get')).toHaveLength(0);
    });

    it('rate-limits confirmation attempts per client IP', () => {
      const limiter = layers('/report-recipients/verify', 'post')
        .map((l: any) => (l.handle as any).limiterOpts)
        .find(Boolean);
      expect(limiter).toMatchObject({ name: 'public-report-verify', keyBy: 'ip', max: 10 });
    });
  });

  it('mounts no permission gate at all — that is the design, not an omission', () => {
    const gated = router.stack
      .filter((l: any) => l.route)
      .flatMap((l: any) => l.route.stack)
      .filter((l: any) => typeof (l.handle as any).__permission === 'string');
    expect(gated).toEqual([]);
  });
});
