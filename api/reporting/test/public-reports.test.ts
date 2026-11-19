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

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockSendSuccess = jest.fn((_res: any, code: number, data: any) => ({ code, data }));
const mockSendError = jest.fn((_res: any, code: number, msg: string, errorCode?: string) => ({ code, msg, errorCode }));

const store = {
  resolveShareLink: jest.fn<AnyFn>(),
  recordShareView: jest.fn<AnyFn>(),
  verifyRecipientByToken: jest.fn<AnyFn>(),
  unsubscribeByToken: jest.fn<AnyFn>(),
};
const mockRecordAudit = jest.fn<(e: unknown) => void>();

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
  recordAudit: (e: unknown) => mockRecordAudit(e),
}));

// The renderer is REAL (a pure snapshot -> string function), so the shared-PDF tests can
// assert what the document does and does not contain — which is the whole security
// property of this route. Only the browser is faked.
const actualHtml = jest.requireActual('@pipeline-builder/pipeline-data') as {
  renderReportHtml: (i: any) => string;
  reportFileName: (t: string, p: string, v: number) => string;
};

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  stakeholderReportStore: store,
  renderReportHtml: (input: any) => { renderedWith.push(input); return actualHtml.renderReportHtml(input); },
  reportFileName: actualHtml.reportFileName,
}));

const mockRenderPdf = jest.fn<AnyFn>();
const mockPdfAvailable = jest.fn<AnyFn>();
/** Every `renderReportHtml` input this route built, so the tests can inspect it. */
const renderedWith: any[] = [];

jest.unstable_mockModule('../src/services/report-pdf.js', () => ({
  __esModule: true,
  renderPdf: (...a: unknown[]) => mockRenderPdf(...a),
  pdfAvailable: (...a: unknown[]) => mockPdfAvailable(...a),
}));

const { createPublicReportRoutes, isPreviewFetch, redactNames } = await import('../src/routes/public-reports.js');

/** What a redacted share link shows in place of an error message. */
const REDACTED_ERROR = 'Error (redacted)';

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
    // The PDF route writes bytes rather than JSON, so the fake needs `end` too.
    end: jest.fn(),
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
    renderedWith.length = 0;
    store.recordShareView.mockResolvedValue(undefined);
    mockPdfAvailable.mockResolvedValue(true);
    mockRenderPdf.mockResolvedValue({ ok: true, pdf: Buffer.from('%PDF-1.4'), ms: 120 });
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
      const redacted = redactNames({ envs: [{ environment: 'production', stages: [{ pipelineName: 'atlas-deploy' }] }] }) as any;
      expect(redacted.envs[0].stages[0].pipelineName).toMatch(/^Pipeline \d+$/);
    });

    it('leaves environment and plugin names readable: a generic `name` is not a pipeline name', () => {
      const input = {
        environments: ['production', 'staging'],
        dora: { environments: [{ environment: 'production' }] },
        plugins: [{ name: 'nodejs-build', version_count: 3 }],
        builds: [{ plugin_name: 'nodejs-build', builds: 2 }],
      };
      expect(redactNames(input)).toEqual(input);
    });

    it('pseudonymizes the organization as "Organization N", not as a pipeline', () => {
      const redacted = redactNames({
        rows: [
          { id: '7f1c0e2a-0000-4000-8000-000000000001', organization: 'acme-corp', pipeline_name: 'atlas', total: 3 },
          { id: '7f1c0e2a-0000-4000-8000-000000000002', organization: 'acme-corp', pipeline_name: 'billing', total: 1 },
        ],
      }) as any;
      expect(redacted.rows[0].organization).toBe('Organization 1');
      expect(redacted.rows[1].organization).toBe('Organization 1');
      expect(redacted.rows.map((r: any) => r.pipeline_name)).toEqual(['Pipeline 1', 'Pipeline 2']);
      // Opaque UUIDs name nothing, and the snapshot joins rows on them.
      expect(redacted.rows[0].id).toBe('7f1c0e2a-0000-4000-8000-000000000001');
      expect(JSON.stringify(redacted)).not.toContain('acme-corp');
    });

    it('redacts the snake_case names raw-SQL sections carry (stage_bottlenecks rows)', () => {
      // getStageBottlenecks answers `{ id, pipeline_name, stage_name, avg_ms, max_ms }`
      // straight from SQL, so the camelCase keys alone left the pipeline name in a
      // "names redacted" shared link.
      const redacted = redactNames({
        sections: [{ id: 'stage_bottlenecks', current: [{ pipeline_name: 'atlas-migration', pipeline_id: 'p-1', avg_ms: 10 }] }],
      }) as any;
      const row = redacted.sections[0].current[0];
      expect(row.pipeline_name).toMatch(/^Pipeline \d+$/);
      expect(row.pipeline_id).toMatch(/^Pipeline \d+$/);
      expect(row.avg_ms).toBe(10);
      expect(JSON.stringify(redacted)).not.toContain('atlas-migration');
    });

    it('hides error text (errors[].error_pattern) but keeps the counts', () => {
      // `error_pattern` is the first 200 characters of a raw error message: it carries
      // hostnames, repo paths and internal names that the name keys never see.
      const redacted = redactNames({
        sections: [{
          id: 'errors',
          current: [{ error_pattern: 'connect ECONNREFUSED atlas-db.internal:5432', occurrences: 4, affected_pipelines: 2, last_seen: '2026-09-10' }],
        }],
      }) as any;
      const row = redacted.sections[0].current[0];
      expect(row.error_pattern).toBe(REDACTED_ERROR);
      expect(row).toMatchObject({ occurrences: 4, affected_pipelines: 2, last_seen: '2026-09-10' });
      expect(JSON.stringify(redacted)).not.toContain('atlas-db');
    });

    it('hides error text in EVERY spelling, at any depth', () => {
      const leak = 'npm ERR! 404 @acme/secret-sdk not found';
      const spellings = [
        'error', 'errorMessage', 'error_message', 'errorPattern', 'error_pattern',
        'errorText', 'error_text', 'errorDetail', 'error_detail',
        'failureMessage', 'failure_message', 'failureReason', 'failure_reason', 'failure',
      ];
      const row = Object.fromEntries(spellings.map((k) => [k, leak]));
      const redacted = redactNames({ a: [row], b: { nested: [{ ...row, count: 3 }] }, c: { failure: { message: leak, code: 'E404' } } }) as any;
      expect(JSON.stringify(redacted)).not.toContain('secret-sdk');
      for (const k of spellings) expect(redacted.a[0][k]).toBe(REDACTED_ERROR);
      expect(redacted.b.nested[0].count).toBe(3);
      // A null error stays null: "no error" must not read as a hidden one.
      expect(redactNames({ error_message: null })).toEqual({ error_message: null });
    });

    it('keeps stage and action names, and the failure category', () => {
      const input = {
        stage: [{ stage_name: 'Build', failures: 3, total: 9, failure_pct: 33 }],
        action: [{ action_name: 'UnitTests', failures: 2, total: 9, failure_pct: 22 }],
        perf: { stages: [{ stageName: 'Deploy', runs: 4, failed: 1 }] },
        categories: [{ category: 'test_failure', label: 'Tests failed', count: 5, sharePct: 50, teamActionable: true, change: 1, topPipelines: [] }],
      };
      expect(redactNames(input)).toEqual(input);
    });

    /**
     * The robust version: compose a REAL snapshot over every registered section, fed
     * by a source whose rows carry error text in the shape each query really answers,
     * and assert none survives. A new section whose data method is not faked here
     * fails the `state: 'ok'` check, so it cannot be added without being covered.
     */
    it('leaves no error text in ANY report section type', async () => {
      const { sectionIds, getReportSection } = await import('@pipeline-builder/pipeline-data/lib/api/reporting/stakeholder/sections.js') as any;
      const { composeSnapshot } = await import('@pipeline-builder/pipeline-data/lib/api/reporting/stakeholder/compose.js') as any;
      const LEAK = 'Error: getaddrinfo ENOTFOUND atlas-vault.corp.internal';
      const pipelineRow = { pipelineId: 'p-atlas', pipelineName: 'atlas-migration', project: 'atlas', runs: 9, succeeded: 6, failed: 3, successPct: 66, deploys: 1, lastFailureAt: '2026-09-10', lastFailureStage: 'Build', buildSeconds: 600 };
      const fixtures: Record<string, unknown> = {
        getExecutionCount: [{ id: 'p-atlas', project: 'atlas', organization: 'acme', pipeline_name: 'atlas-migration', total: 9, succeeded: 6, failed: 3, canceled: 0 }],
        getSuccessRate: [{ period: '2026-W37', succeeded: 6, failed: 3, canceled: 0, success_pct: 66 }],
        getAverageDuration: [{ id: 'p-atlas', project: 'atlas', pipeline_name: 'atlas-migration', avg_ms: 1, min_ms: 1, max_ms: 1, p95_ms: 1, executions: 9 }],
        getStageFailures: [{ stage_name: 'Build', failures: 3, total: 9, failure_pct: 33 }],
        getStageBottlenecks: [{ id: 'p-atlas', pipeline_name: 'atlas-migration', stage_name: 'Build', avg_ms: 1, max_ms: 1 }],
        getActionFailures: [{ action_name: 'UnitTests', failures: 3, total: 9, failure_pct: 33 }],
        getErrors: [{ error_pattern: LEAK, occurrences: 3, affected_pipelines: 1, last_seen: '2026-09-10' }],
        getPluginSummary: { total: 3, active: 3, inactive: 0 },
        getPluginDistribution: [{ plugin_type: 'nodejs', compute_type: 'SMALL', count: 3 }],
        getPluginVersions: [{ name: 'nodejs-build', version_count: 3, latest_version: '2.1.0', has_default: true, managed: false }],
        getBuildSuccessRate: [{ period: '2026-W37', succeeded: 1, failed: 1, canceled: 0, success_pct: 50 }],
        getBuildDuration: [{ plugin_name: 'nodejs-build', avg_ms: 1, max_ms: 1, builds: 2 }],
        getBuildFailures: [{ plugin_name: 'nodejs', error_message: LEAK, occurrences: 1, last_seen: '2026-09-10' }],
        getDoraMetrics: { environments: [{ environment: 'production', deploymentFrequency: { deployments: 1 } }] },
        getDoraTrend: [{ period: '2026-W37', deployments: 1 }],
        getReportEnvironments: ['production', 'staging'],
        getPipelineBreakdown: [pipelineRow],
        getFailureAnalysis: [{ category: 'network', label: 'Network', count: 3, sharePct: 100, teamActionable: false, change: null, topPipelines: [{ pipelineId: 'p-atlas', pipelineName: 'atlas-migration', count: 3 }] }],
        getStagePerformance: [{ stageName: 'Build', runs: 9, failed: 3 }],
        getResourceConsumption: { pipelines: [{ project: 'atlas', pipelineId: 'p-atlas', pipelineName: 'atlas-migration', buildSeconds: 600, runs: 9, sharePct: 100 }], totalBuildSeconds: 600 },
        getPromotionView: [{ commitSha: 'abc123', stops: [{ environment: 'staging', deployedAt: '2026-09-10', hoursFromPrevious: null }], stuck: true, furthest: 'staging' }],
        getOutdatedPlugins: { rows: [], behindPipelines: 0, majorBehind: 0 },
        getPluginVulnerabilities: { rows: [], exposedPipelines: 0, criticalPipelines: 0 },
        getAdoption: { activePipelines: 1, totalPipelines: 1 },
        getCompliancePosture: { compliance: null, access: null, unavailable: [] },
        getNeedsAttention: { items: [{ pipelineId: 'p-atlas', pipelineName: 'atlas-migration', severity: 'high', findings: [{ rule: 'consecutive_failures', evidence: '3 consecutive failures', severity: 'high' }] }] },
      };
      const source = new Proxy({}, {
        get: (_t, method: string) => (method in fixtures
          ? async () => fixtures[method]
          : async () => { throw new Error(`fixture missing for ${method}`); }),
        has: (_t, method: string) => method in fixtures,
      });
      const ids: string[] = sectionIds();
      const features = [...new Set(ids.map((id) => getReportSection(id)?.requiresFeature).filter(Boolean))];
      const snapshot = await composeSnapshot(ids, {
        source,
        period: { start: new Date('2026-09-07'), end: new Date('2026-09-14'), prevStart: new Date('2026-08-31'), prevEnd: new Date('2026-09-07'), label: '2026-W37' },
        timezone: 'UTC',
        weekStart: 'monday',
        orgId: 'acme',
        features,
      });
      expect(snapshot.sections.map((s: any) => [s.id, s.state])).toEqual(ids.map((id) => [id, 'ok']));
      // Proves the fixture really carried the text into the snapshot before redaction.
      expect(JSON.stringify(snapshot)).toContain('atlas-vault');

      const redacted = redactNames(snapshot) as any;
      const text = JSON.stringify(redacted);
      expect(text).not.toContain('atlas-vault');
      expect(text).not.toContain('ENOTFOUND');
      expect(text).not.toContain('atlas-migration');
      // Stage and action names, and the numbers, are what the reader came for.
      expect(text).toContain('"stage_name":"Build"');
      expect(text).toContain('"action_name":"UnitTests"');
      // Each pseudonym is the RIGHT KIND: pipelines and projects read "Pipeline N", the
      // organization "Organization N", and environment and plugin names stay readable.
      const section = (id: string) => redacted.sections.find((x: any) => x.id === id);
      const execRow = section('execution_count').current[0];
      expect(execRow.pipeline_name).toMatch(/^Pipeline \d+$/);
      expect(execRow.project).toMatch(/^Pipeline \d+$/);
      expect(execRow.organization).toMatch(/^Organization \d+$/);
      expect(text).not.toContain('"acme"');
      // An opaque id is left as it is: it names nothing, and rows join on it.
      expect(execRow.id).toBe('p-atlas');
      expect(section('pipeline_breakdown').current[0].pipelineName).toMatch(/^Pipeline \d+$/);
      expect(section('environments').current).toEqual(['production', 'staging']);
      expect(section('dora').current.environments[0].environment).toBe('production');
      expect(section('plugin_versions').current[0].name).toBe('nodejs-build');
      expect(section('build_failures').current[0].plugin_name).toBe('nodejs');
      expect(section('plugin_distribution').current[0].plugin_type).toBe('nodejs');
      expect(text).not.toMatch(/"(environment|name|plugin_name|plugin_type)":"Pipeline \d+"/);

      const errors = redacted.sections.find((s: any) => s.id === 'errors');
      expect(errors.current[0]).toMatchObject({ error_pattern: REDACTED_ERROR, occurrences: 3 });
      expect(errors.headline).toEqual(snapshot.sections.find((s: any) => s.id === 'errors').headline);
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

    it('hides error text on a redacted link, and shows it on an unredacted one', async () => {
      const errorRun = () => run({ snapshot: { sections: [{ id: 'errors', current: [{ error_pattern: 'git clone git@github.com:acme/atlas-secret.git failed', occurrences: 2 }] }] } });
      store.resolveShareLink.mockResolvedValue({ link: link({ redactNames: true }), run: errorRun() });
      await call('/reports/:token', 'get', { params: { token: TOKEN } });
      expect(JSON.stringify(payload())).not.toContain('atlas-secret');
      expect(payload().report.snapshot.sections[0].current[0]).toEqual({ error_pattern: REDACTED_ERROR, occurrences: 2 });

      jest.clearAllMocks();
      store.resolveShareLink.mockResolvedValue({ link: link({ redactNames: false }), run: errorRun() });
      await call('/reports/:token', 'get', { params: { token: TOKEN } });
      expect(JSON.stringify(payload())).toContain('atlas-secret');
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

  describe('POST /report-recipients/unsubscribe (audit)', () => {
    it('records ONLY the click that actually stopped delivery', async () => {
      store.unsubscribeByToken.mockResolvedValueOnce({
        matched: true, recipient: { id: 'rec-1', orgId: 'acme', email: 'm@acme.test' }, newlyUnsubscribed: true,
      });
      await call('/report-recipients/unsubscribe', 'post', { body: { token: TOKEN } });
      expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'reporting.report.recipient.unsubscribed', actorId: 'anonymous', orgId: 'acme', targetId: 'rec-1',
      }));

      mockRecordAudit.mockClear();
      store.unsubscribeByToken.mockResolvedValueOnce({
        matched: true, recipient: { id: 'rec-1', orgId: 'acme', email: 'm@acme.test' }, newlyUnsubscribed: false,
      });
      await call('/report-recipients/unsubscribe', 'post', { body: { token: TOKEN } });
      store.unsubscribeByToken.mockResolvedValueOnce({ matched: false });
      await call('/report-recipients/unsubscribe', 'post', { body: { token: TOKEN } });
      expect(mockRecordAudit).not.toHaveBeenCalled();
    });
  });

  describe('POST /report-recipients/verify', () => {
    it('confirms an address and echoes only that address', async () => {
      store.verifyRecipientByToken.mockResolvedValue({ id: 'rec-1', orgId: 'acme', email: 'manager@acme.test' });
      await call('/report-recipients/verify', 'post', { body: { token: TOKEN } });
      expect(payload()).toEqual({ verified: true, email: 'manager@acme.test' });
    });

    it('audits the confirmation as anonymous, with a HASHED address only', async () => {
      store.verifyRecipientByToken.mockResolvedValue({ id: 'rec-1', orgId: 'acme', email: 'manager@acme.test' });
      await call('/report-recipients/verify', 'post', { body: { token: TOKEN } });
      const event = mockRecordAudit.mock.calls[0]?.[0] as any;
      expect(event).toMatchObject({
        action: 'reporting.report.recipient.verified', actorId: 'anonymous', orgId: 'acme', targetId: 'rec-1',
      });
      expect(event.details.recipientHash).toMatch(/^[0-9a-f]{16}$/);
      expect(JSON.stringify(event)).not.toContain('manager@acme.test');
    });

    it('audits nothing for a refused token', async () => {
      store.verifyRecipientByToken.mockResolvedValue(null);
      await call('/report-recipients/verify', 'post', { body: { token: TOKEN } });
      expect(mockRecordAudit).not.toHaveBeenCalled();
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

  // ── The shared PDF ────────────────────────────────────────────────────────

  describe('GET /reports/:token/pdf', () => {
    const pdf = (req: any = {}) => call('/reports/:token/pdf', 'get', {
      params: { token: TOKEN },
      headers: { 'user-agent': 'Mozilla/5.0 Chrome/141.0' },
      ...req,
    });

    it('serves the file with a pdf content type and an attachment name', async () => {
      store.resolveShareLink.mockResolvedValue({ link: link(), run: run() });
      const response = await pdf();
      expect(headers.get('Content-Type')).toBe('application/pdf');
      expect(headers.get('Content-Disposition')).toContain('attachment;');
      expect(headers.get('Content-Disposition')).toContain('2026-W37');
      expect(response.status).toHaveBeenCalledWith(200);
    });

    it('never lets the file be cached or sniffed', async () => {
      store.resolveShareLink.mockResolvedValue({ link: link(), run: run() });
      await pdf();
      // A proxy holding this would serve one org's numbers to the next reader.
      expect(headers.get('Cache-Control')).toContain('no-store');
      expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    });

    it('answers the same indistinguishable 404 as the page for a dead link', async () => {
      store.resolveShareLink.mockResolvedValue(null);
      await pdf();
      expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 404, expect.any(String), 'NOT_FOUND');
      // Nothing was rendered, so a dead token cannot be used to spend a browser launch.
      expect(mockRenderPdf).not.toHaveBeenCalled();
    });

    it('refuses a malformed token without touching the store', async () => {
      await pdf({ params: { token: 'short' } });
      expect(store.resolveShareLink).not.toHaveBeenCalled();
      expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 404, expect.any(String), 'NOT_FOUND');
    });

    it('carries the redaction through to the FILE, not just the page', async () => {
      store.resolveShareLink.mockResolvedValue({ link: link({ redactNames: true }), run: run() });
      await pdf();
      const html = (mockRenderPdf.mock.calls[0]?.[0] ?? '') as string;
      // The internal project name is in the snapshot fixture; the file must not have it.
      expect(html).not.toContain('atlas-migration');
      expect(html).toMatch(/names have been replaced/i);
    });

    it('hides error text in the FILE of a redacted link too', async () => {
      store.resolveShareLink.mockResolvedValue({
        link: link({ redactNames: true }),
        run: run({ snapshot: { sections: [{ id: 'build_failures', title: 'Plugin build failures', state: 'ok', current: [{ plugin_name: 'nodejs', error_message: 'npm ERR! 404 @acme/secret-sdk', occurrences: 1 }] }] } }),
      });
      await pdf();
      expect(JSON.stringify(renderedWith[0]?.snapshot)).not.toContain('secret-sdk');
      expect((mockRenderPdf.mock.calls[0]?.[0] as string)).not.toContain('secret-sdk');
    });

    it('does NOT carry the executive summary, which the shared page withholds', async () => {
      store.resolveShareLink.mockResolvedValue({
        link: link(),
        run: run({ aiDraft: 'A summary only members should see.' }),
      });
      await pdf();
      // The invariant: the PDF never carries more than the view it came from. The obvious
      // shortcut — render straight from the run row — would leak exactly this.
      expect(renderedWith[0]?.executiveSummary).toBeUndefined();
      expect((mockRenderPdf.mock.calls[0]?.[0] as string)).not.toContain('only members should see');
    });

    it('tells the link expiry to the reader, so a bookmark dying later is not a surprise', async () => {
      store.resolveShareLink.mockResolvedValue({ link: link(), run: run() });
      await pdf();
      expect((mockRenderPdf.mock.calls[0]?.[0] as string)).toContain('expires on 2026-10-21');
    });

    it('answers 503, not 404, when the instance cannot render — the link is fine', async () => {
      mockPdfAvailable.mockResolvedValue(false);
      store.resolveShareLink.mockResolvedValue({ link: link(), run: run() });
      await pdf();
      expect(mockSendError).toHaveBeenCalledWith(
        expect.anything(), 503, expect.stringMatching(/not available/i), 'SERVICE_UNAVAILABLE',
      );
    });

    it('answers 429 when the renderer is busy, so a client knows to retry', async () => {
      mockRenderPdf.mockResolvedValue({ ok: false, reason: 'busy', message: 'Too many reports…' });
      store.resolveShareLink.mockResolvedValue({ link: link(), run: run() });
      await pdf();
      expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 429, expect.any(String), 'SERVICE_UNAVAILABLE');
    });

    it('answers 500 for a render failure, which is ours and not the caller\'s', async () => {
      mockRenderPdf.mockResolvedValue({ ok: false, reason: 'render_failed', message: 'nope' });
      store.resolveShareLink.mockResolvedValue({ link: link(), run: run() });
      await pdf();
      expect(mockSendError).toHaveBeenCalledWith(expect.anything(), 500, expect.any(String), 'INTERNAL_ERROR');
    });

    it('counts a person saving the file as a view', async () => {
      store.resolveShareLink.mockResolvedValue({ link: link(), run: run() });
      await pdf();
      expect(store.recordShareView).toHaveBeenCalled();
    });

    it('does not count a mail scanner fetching it', async () => {
      store.resolveShareLink.mockResolvedValue({ link: link(), run: run() });
      await pdf({ headers: { 'user-agent': 'Mozilla/5.0 (compatible; safelinks)' } });
      expect(store.recordShareView).not.toHaveBeenCalled();
    });

    it('rate-limits renders far more tightly than page reads', async () => {
      const limiter = layers('/reports/:token/pdf', 'get')
        .map((l: any) => (l.handle as any).limiterOpts)
        .find(Boolean);
      // A render costs a browser launch; the read limiter's 60/min would be 60 launches.
      expect(limiter).toMatchObject({ name: 'public-report-pdf', keyBy: 'ip', max: 6 });
      const readLimiter = layers('/reports/:token', 'get')
        .map((l: any) => (l.handle as any).limiterOpts)
        .find(Boolean);
      expect(limiter.max).toBeLessThan(readLimiter.max);
    });

    it('still carries the no-index / no-referrer headers the page does', async () => {
      store.resolveShareLink.mockResolvedValue({ link: link(), run: run() });
      await pdf();
      expect(headers.get('X-Robots-Tag')).toContain('noindex');
      expect(headers.get('Referrer-Policy')).toBe('no-referrer');
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
