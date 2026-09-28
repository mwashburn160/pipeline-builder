// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The stakeholder-report authoring API.
 *
 * The store's own suite covers persistence invariants; what is tested here is the
 * decisions the ROUTES make, each of which is a way the feature could leak or lie:
 *
 *  - the CREATOR owns a definition — an `ownerId` in the body is never honoured,
 *    because a scheduled run is authorized as the owner;
 *  - a rollup scope needs `reports:rollup`, refused at SAVE time so a definition
 *    cannot be stored whose every run would be silently narrowed;
 *  - a share link needs BOTH the lead's permission and the admin's org policy;
 *  - a transfer target is verified against platform and FAILS CLOSED;
 *  - a recipient outside the allowed domains is refused, and a member skips
 *    verification;
 *  - a republish is audited as a republish, and a double publish audits once;
 *  - the publish response says a delivered copy cannot be recalled.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockRecordAudit = jest.fn<(event: any) => void>();
const mockSendSuccess = jest.fn((_res: any, code: number, data: any) => ({ code, data }));
const mockSendBadRequest = jest.fn((_res: any, msg: string, code?: string) => ({ msg, code }));

/** The store, stubbed method by method so each test states only what it needs. */
const store = {
  listDefinitions: jest.fn<AnyFn>(),
  createDefinition: jest.fn<AnyFn>(),
  getDefinition: jest.fn<AnyFn>(),
  requireDefinition: jest.fn<AnyFn>(),
  updateDefinition: jest.fn<AnyFn>(),
  deleteDefinition: jest.fn<AnyFn>(),
  transferOwner: jest.fn<AnyFn>(),
  listRuns: jest.fn<AnyFn>(),
  createRun: jest.fn<AnyFn>(),
  nextVersion: jest.fn<AnyFn>(),
  completeRun: jest.fn<AnyFn>(),
  failRun: jest.fn<AnyFn>(),
  supersede: jest.fn<AnyFn>(),
  getRun: jest.fn<AnyFn>(),
  requireRun: jest.fn<AnyFn>(),
  setRunNotes: jest.fn<AnyFn>(),
  publishRun: jest.fn<AnyFn>(),
  createShareLink: jest.fn<AnyFn>(),
  listShareLinks: jest.fn<AnyFn>(),
  revokeShareLink: jest.fn<AnyFn>(),
  listRecipients: jest.fn<AnyFn>(),
  getRecipients: jest.fn<AnyFn>(),
  upsertRecipient: jest.fn<AnyFn>(),
  resendVerification: jest.fn<AnyFn>(),
  deleteRecipient: jest.fn<AnyFn>(),
  getReportPolicy: jest.fn<AnyFn>(),
  setReportPolicy: jest.fn<AnyFn>(),
  deliverability: jest.fn<AnyFn>(),
  admitRecipient: jest.fn<AnyFn>(),
  setNextRun: jest.fn<AnyFn>(),
};

const mockComposeSnapshot = jest.fn<AnyFn>();
const mockAuthority = jest.fn<AnyFn>();
const mockRecipientCheck = jest.fn<AnyFn>();
const mockRetentionWindow = jest.fn<AnyFn>();

const NOW = new Date('2026-09-21T12:00:00.000Z');
const PERIOD = {
  start: new Date('2026-09-07T05:00:00.000Z'),
  end: new Date('2026-09-14T05:00:00.000Z'),
  prevStart: new Date('2026-08-31T05:00:00.000Z'),
  prevEnd: new Date('2026-09-07T05:00:00.000Z'),
  label: '2026-W37',
};

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), identity: { orgId: 'acme', userId: 'user-lead' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: 'acme', userId: req.userId ?? 'user-lead' });
  },
  // The limiter is a pass-through here; its configuration is asserted separately
  // by reading the mounted chain.
  rateLimitByOrg: (opts: any) => Object.assign((_req: any, _res: any, next: any) => next(), { limiterOpts: opts }),
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: mockSendSuccess,
  sendBadRequest: mockSendBadRequest,
  recordAudit: (event: any) => mockRecordAudit(event),
}));

const actualHtml = jest.requireActual('@pipeline-builder/pipeline-data') as {
  renderReportHtml: (i: any) => string;
  reportFileName: (t: string, p: string, v: number) => string;
};
const mockRenderPdf = jest.fn<AnyFn>();
const mockPdfAvailable = jest.fn<AnyFn>();
/** Every `renderReportHtml` input the routes built, so a test can inspect it. */
const renderedWith: any[] = [];

jest.unstable_mockModule('../src/services/report-pdf.js', () => ({
  __esModule: true,
  renderPdf: (...a: unknown[]) => mockRenderPdf(...a),
  pdfAvailable: (...a: unknown[]) => mockPdfAvailable(...a),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  reportingService: {},
  stakeholderReportStore: store,
  // REAL, so the PDF tests assert the document's content rather than a stub's return.
  renderReportHtml: (input: any) => { renderedWith.push(input); return actualHtml.renderReportHtml(input); },
  reportFileName: actualHtml.reportFileName,
  composeSnapshot: (...a: unknown[]) => mockComposeSnapshot(...a),
  getSection: (id: string) => (['success_rate', 'dora', 'build_success'].includes(id) ? { id } : undefined),
  getTemplate: (t: string) => (t === 'weekly_delivery' ? { sections: ['success_rate'] } : undefined),
  resolvePeriod: () => PERIOD,
  resolvePeriodByLabel: (label: string) => (label === '2026-W37' ? PERIOD : null),
  rejectUnreportablePeriod: () => null,
  // The SCHEDULE, not the period a report covers: the create and update routes derive
  // `next_run_at` from it, and a definition with none never becomes due.
  nextPeriodBoundary: () => new Date('2026-09-28T05:00:00.000Z'),
  REPORT_CADENCES: ['weekly', 'monthly', 'quarterly'],
  REPORT_TEMPLATES: ['weekly_delivery', 'monthly_health', 'quarterly_review'],
  MAX_SHARE_LINK_TTL_DAYS: 180,
  DEFAULT_SHARE_LINK_TTL_DAYS: 30,
}));

jest.unstable_mockModule('../src/helpers/retention-cap.js', () => ({
  resolveOrgRetentionWindow: (...a: unknown[]) => mockRetentionWindow(...a),
  retentionOrgIdFor: () => 'acme',
}));

// Delivery is NOT exercised here — nothing in this file sends anything, and the route
// tests assert the API surface. `emailAvailable` is the one delivery export the routes
// read, for the schedule form's warning.
jest.unstable_mockModule('../src/services/report-delivery.js', () => ({
  emailAvailable: () => Promise.resolve(true),
}));

jest.unstable_mockModule('../src/services/report-identity.js', () => ({
  reportIdentity: () => ({
    authority: (...a: unknown[]) => mockAuthority(...a),
    recipientCheck: (...a: unknown[]) => mockRecipientCheck(...a),
  }),
}));

const { createStakeholderReportRoutes } = await import('../src/routes/stakeholder-reports.js');

const definition = (over: Record<string, unknown> = {}) => ({
  id: 'def-1',
  // The run executor takes the org from the DEFINITION ROW, not from the request: the
  // definition was already read under the caller's tenant, so the row is the authority and
  // the scheduler — which has no request — uses the same field.
  orgId: 'acme',
  name: 'Weekly delivery',
  template: 'weekly_delivery',
  sections: ['success_rate'],
  cadence: 'weekly',
  timezone: 'America/Chicago',
  weekStart: 'monday',
  scope: { kind: 'org' },
  recipients: [],
  autoSend: false,
  isActive: true,
  pausedReason: null,
  ownerId: 'user-lead',
  nextRunAt: null,
  lastRunAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const run = (over: Record<string, unknown> = {}) => ({
  id: 'run-1',
  definitionId: 'def-1',
  periodStart: PERIOD.start,
  periodEnd: PERIOD.end,
  periodLabel: '2026-W37',
  version: 1,
  status: 'ready_for_review',
  snapshot: { sections: [] },
  aiDraft: null,
  leadNotes: null,
  failureReason: null,
  publishedBy: null,
  publishedAt: null,
  supersededBy: null,
  createdAt: NOW,
  ...over,
});

const shareLink = (over: Record<string, unknown> = {}) => ({
  id: 'link-1',
  runId: 'run-1',
  expiresAt: new Date('2026-10-21T12:00:00.000Z'),
  revokedAt: null,
  redactNames: false,
  viewCount: 0,
  lastViewedAt: null,
  createdAt: NOW,
  ...over,
});

const recipient = (over: Record<string, unknown> = {}) => ({
  id: 'rec-1',
  email: 'manager@acme.test',
  displayName: null,
  verifiedAt: NOW,
  unsubscribedAt: null,
  bounceCount: 0,
  approvedBy: null,
  createdAt: NOW,
  ...over,
});

describe('stakeholder report routes', () => {
  let router: any;
  const headers = new Map<string, string>();
  /**
   * The most recent fake response. `call` builds one per invocation and returns the
   * HANDLER's promise, which is what the JSON tests want (they read `payload()`); the PDF
   * route writes bytes instead, so its tests need the response object itself.
   */
  let lastRes: any;
  const res = () => {
    lastRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      end: jest.fn(),
      setHeader: jest.fn((k: string, v: string) => { headers.set(k, v); }),
    };
    return lastRes;
  };

  /** The LAST layer of a route is its handler; the ones before it are the gates. */
  const layers = (path: string, method: string) =>
    router.stack.find((l: any) => l.route?.path === path && l.route?.methods[method])?.route?.stack ?? [];
  const handler = (path: string, method: string) => {
    const stack = layers(path, method);
    if (stack.length === 0) throw new Error(`No ${method.toUpperCase()} ${path}`);
    return stack[stack.length - 1].handle;
  };
  const call = (path: string, method: string, req: any = {}) =>
    handler(path, method)({ params: {}, query: {}, body: {}, headers: {}, user: { permissions: [] }, ...req }, res());
  const payload = () => mockSendSuccess.mock.calls[0]?.[2] as any;
  const audit = () => mockRecordAudit.mock.calls[0]?.[0] as any;

  beforeEach(() => {
    jest.clearAllMocks();
    headers.clear();
    renderedWith.length = 0;
    mockPdfAvailable.mockResolvedValue(true);
    mockRenderPdf.mockResolvedValue({ ok: true, pdf: Buffer.from('%PDF-1.4'), ms: 90 });
    store.getReportPolicy.mockResolvedValue({ externalSharing: true, recipientDomains: null, requireApproval: true });
    store.deliverability.mockReturnValue({ deliverable: true });
    store.getRecipients.mockResolvedValue([]);
    mockRetentionWindow.mockResolvedValue({ minFromMs: 0, maxRangeMs: 0 });
    router = createStakeholderReportRoutes();
  });

  // ── Definitions ───────────────────────────────────────────────────────────

  describe('definitions', () => {
    const body = {
      name: 'Weekly delivery',
      template: 'weekly_delivery',
      cadence: 'weekly',
      scope: { kind: 'org' },
    };

    it('lists definitions', async () => {
      store.listDefinitions.mockResolvedValue([definition()]);
      await call('/definitions', 'get');
      expect(payload().definitions).toHaveLength(1);
      expect(payload().definitions[0]).toMatchObject({ id: 'def-1', cadence: 'weekly' });
    });

    it('falls back to the template’s own section list', async () => {
      store.createDefinition.mockResolvedValue(definition());
      await call('/definitions', 'post', { body });
      expect(store.createDefinition.mock.calls[0][0].sections).toEqual(['success_rate']);
    });

    /**
     * A scheduled run is authorized AS THE OWNER, so accepting an ownerId here
     * would let anyone with `reports:author` schedule a report that runs with
     * someone else's access. The body schema is `.strict()`, so it is refused
     * outright rather than quietly dropped.
     */
    it('refuses an ownerId in the body — the creator owns it', async () => {
      await call('/definitions', 'post', { body: { ...body, ownerId: 'someone-else' } });
      expect(mockSendBadRequest).toHaveBeenCalled();
      expect(store.createDefinition).not.toHaveBeenCalled();
    });

    it('owns the definition as the caller', async () => {
      store.createDefinition.mockResolvedValue(definition());
      await call('/definitions', 'post', { body, userId: 'user-lead' });
      expect(store.createDefinition.mock.calls[0][0]).toMatchObject({ ownerId: 'user-lead', createdBy: 'user-lead' });
    });

    it('records the definition create with counts, not the recipient addresses', async () => {
      store.createDefinition.mockResolvedValue(definition({ recipients: ['rec-1', 'rec-2'] }));
      store.getRecipients.mockResolvedValue([recipient(), recipient({ id: 'rec-2' })]);
      await call('/definitions', 'post', { body: { ...body, recipients: ['rec-1', 'rec-2'] } });
      expect(audit().action).toBe('reporting.report.definition.create');
      expect(audit().details.recipients).toBe(2);
      expect(JSON.stringify(audit().details)).not.toContain('@');
    });

    /**
     * A template in the catalog whose spec cannot be resolved: the enum admits it,
     * so the only thing standing between that and a report with no sections is
     * this check. It fails the save rather than storing an empty report.
     */
    it('refuses a template whose section list cannot be resolved', async () => {
      await call('/definitions', 'post', { body: { ...body, template: 'quarterly_review' } });
      expect(mockSendBadRequest.mock.calls[0][1]).toContain('Unknown report template');
      expect(store.createDefinition).not.toHaveBeenCalled();
    });

    it('rejects an unknown section id', async () => {
      await call('/definitions', 'post', { body: { ...body, sections: ['top_committers'] } });
      expect(mockSendBadRequest).toHaveBeenCalled();
      expect(store.createDefinition).not.toHaveBeenCalled();
    });

    it('rejects an invalid timezone', async () => {
      await call('/definitions', 'post', { body: { ...body, timezone: 'Mars/Olympus' } });
      expect(mockSendBadRequest).toHaveBeenCalled();
      expect(store.createDefinition).not.toHaveBeenCalled();
    });

    it('rejects a bare UTC offset as a timezone', async () => {
      await call('/definitions', 'post', { body: { ...body, timezone: '+05:00' } });
      expect(mockSendBadRequest).toHaveBeenCalled();
    });

    it('rejects a projects scope with no projects', async () => {
      await call('/definitions', 'post', { body: { ...body, scope: { kind: 'projects' } } });
      expect(mockSendBadRequest).toHaveBeenCalled();
    });

    /**
     * Rolling a report up over descendant teams is downward visibility across the
     * org tree — a separate grant. Refused at SAVE time, not at run time: a
     * definition that quietly stopped including the teams it says it covers is a
     * wrong report, not a degraded one.
     */
    it('refuses a rollup scope without reports:rollup', async () => {
      await call('/definitions', 'post', { body: { ...body, scope: { kind: 'rollup' } }, user: { permissions: ['reports:author'] } });
      expect(mockSendBadRequest.mock.calls[0][1]).toContain('Roll up team reports');
      expect(store.createDefinition).not.toHaveBeenCalled();
    });

    it('allows a rollup scope for a holder of reports:rollup', async () => {
      store.createDefinition.mockResolvedValue(definition({ scope: { kind: 'rollup' } }));
      await call('/definitions', 'post', {
        body: { ...body, scope: { kind: 'rollup' } },
        user: { permissions: ['reports:author', 'reports:rollup'] },
      });
      expect(store.createDefinition).toHaveBeenCalled();
    });

    it('refuses a recipient id that is not a row in this org', async () => {
      store.getRecipients.mockResolvedValue([]);
      await call('/definitions', 'post', { body: { ...body, recipients: ['rec-missing'] } });
      expect(mockSendBadRequest.mock.calls[0][1]).toContain('Unknown recipient');
      expect(store.createDefinition).not.toHaveBeenCalled();
    });

    it('reads one definition', async () => {
      store.requireDefinition.mockResolvedValue(definition());
      await call('/definitions/:id', 'get', { params: { id: 'def-1' } });
      expect(payload().definition.id).toBe('def-1');
    });

    /** A "monthly health" report carrying the weekly sections would be a lie. */
    it('changing the template resets the section list', async () => {
      store.requireDefinition.mockResolvedValue(definition());
      store.updateDefinition.mockResolvedValue(definition({ template: 'weekly_delivery' }));
      await call('/definitions/:id', 'put', { params: { id: 'def-1' }, body: { template: 'weekly_delivery' } });
      expect(store.updateDefinition.mock.calls[0][2]).toMatchObject({ sections: ['success_rate'] });
    });

    it('an explicit section list survives a template change', async () => {
      store.requireDefinition.mockResolvedValue(definition());
      store.updateDefinition.mockResolvedValue(definition());
      await call('/definitions/:id', 'put', {
        params: { id: 'def-1' },
        body: { template: 'weekly_delivery', sections: ['dora'] },
      });
      expect(store.updateDefinition.mock.calls[0][2]).toMatchObject({ sections: ['dora'] });
    });

    it('resuming a definition clears its pause reason', async () => {
      store.requireDefinition.mockResolvedValue(definition({ isActive: false, pausedReason: 'entitlement' }));
      store.updateDefinition.mockResolvedValue(definition());
      await call('/definitions/:id', 'put', { params: { id: 'def-1' }, body: { isActive: true } });
      expect(store.updateDefinition.mock.calls[0][2]).toMatchObject({ isActive: true, pausedReason: null });
    });

    it('pausing a definition leaves the reason alone', async () => {
      store.requireDefinition.mockResolvedValue(definition());
      store.updateDefinition.mockResolvedValue(definition({ isActive: false }));
      await call('/definitions/:id', 'put', { params: { id: 'def-1' }, body: { isActive: false } });
      expect('pausedReason' in store.updateDefinition.mock.calls[0][2]).toBe(false);
    });

    /**
     * Every editable field, through the ONE route. Each carries its own guard —
     * the rollup grant, the recipient check, the timezone and week-start
     * validation — and an update that let a caller past any of them would be a way
     * around the checks the create route makes.
     */
    it('applies every editable field, each through its own guard', async () => {
      store.requireDefinition.mockResolvedValue(definition());
      store.updateDefinition.mockResolvedValue(definition());
      store.getRecipients.mockResolvedValue([recipient()]);
      await call('/definitions/:id', 'put', {
        params: { id: 'def-1' },
        body: {
          name: 'Renamed',
          cadence: 'monthly',
          autoSend: true,
          scope: { kind: 'projects', projects: ['atlas'] },
          recipients: ['rec-1'],
          timezone: 'Europe/Berlin',
          weekStart: 'sunday',
          sections: ['dora'],
        },
        user: { permissions: ['reports:author'] },
      });
      expect(store.updateDefinition.mock.calls[0][2]).toMatchObject({
        name: 'Renamed',
        cadence: 'monthly',
        autoSend: true,
        scope: { kind: 'projects', projects: ['atlas'] },
        recipients: ['rec-1'],
        timezone: 'Europe/Berlin',
        weekStart: 'sunday',
        sections: ['dora'],
      });
    });

    it('refuses an update that switches the scope to a rollup without the grant', async () => {
      store.requireDefinition.mockResolvedValue(definition());
      await call('/definitions/:id', 'put', {
        params: { id: 'def-1' },
        body: { scope: { kind: 'rollup' } },
        user: { permissions: ['reports:author'] },
      });
      expect(store.updateDefinition).not.toHaveBeenCalled();
      expect(mockSendBadRequest.mock.calls[0][1]).toContain('Roll up team reports');
    });

    it('refuses an update naming a recipient that is not a row in this org', async () => {
      store.requireDefinition.mockResolvedValue(definition());
      store.getRecipients.mockResolvedValue([]);
      await call('/definitions/:id', 'put', { params: { id: 'def-1' }, body: { recipients: ['rec-gone'] } });
      expect(store.updateDefinition).not.toHaveBeenCalled();
      expect(mockSendBadRequest.mock.calls[0][1]).toContain('Unknown recipient');
    });

    it.each([
      ['an invalid timezone', { timezone: 'Mars/Olympus' }],
      ['a bare UTC offset', { timezone: '-07:00' }],
    ])('refuses an update with %s', async (_case, patch) => {
      store.requireDefinition.mockResolvedValue(definition());
      await call('/definitions/:id', 'put', { params: { id: 'def-1' }, body: patch });
      expect(store.updateDefinition).not.toHaveBeenCalled();
    });

    it('records which fields an update touched', async () => {
      store.requireDefinition.mockResolvedValue(definition());
      store.updateDefinition.mockResolvedValue(definition({ name: 'Renamed' }));
      await call('/definitions/:id', 'put', { params: { id: 'def-1' }, body: { name: 'Renamed' } });
      expect(audit().action).toBe('reporting.report.definition.update');
      expect(audit().details.fields).toEqual(['name']);
    });

    /**
     * The list view is what a lead reads to answer "is this running, and when
     * next" — so the scheduled timestamps and the pause reason have to survive the
     * shaping, not just the ids.
     */
    it('carries the schedule timestamps and the pause reason into the view', async () => {
      store.listDefinitions.mockResolvedValue([definition({
        isActive: false,
        pausedReason: 'entitlement',
        nextRunAt: NOW,
        lastRunAt: NOW,
      })]);
      await call('/definitions', 'get');
      expect(payload().definitions[0]).toMatchObject({
        isActive: false,
        pausedReason: 'entitlement',
        nextRunAt: NOW.toISOString(),
        lastRunAt: NOW.toISOString(),
      });
    });

    it('deleting says in the audit trail that the share links went too', async () => {
      store.requireDefinition.mockResolvedValue(definition());
      store.deleteDefinition.mockResolvedValue(undefined);
      await call('/definitions/:id', 'delete', { params: { id: 'def-1' } });
      expect(audit().action).toBe('reporting.report.definition.delete');
      expect(audit().details.shareLinksRevoked).toBe(true);
    });
  });

  // ── Ownership transfer ────────────────────────────────────────────────────

  describe('ownership transfer', () => {
    beforeEach(() => {
      store.requireDefinition.mockResolvedValue(definition({ ownerId: 'user-lead' }));
      store.transferOwner.mockResolvedValue(definition({ ownerId: 'user-new' }));
    });

    it('moves a definition to a member who can author reports', async () => {
      mockAuthority.mockResolvedValue({ active: true, permissions: ['reports:author'], features: [] });
      await call('/definitions/:id/transfer', 'post', { params: { id: 'def-1' }, body: { ownerId: 'user-new' } });
      expect(store.transferOwner).toHaveBeenCalledWith('acme', 'def-1', 'user-new', 'user-lead');
      expect(audit()).toMatchObject({
        action: 'reporting.report.ownership.transfer',
        details: { previousOwnerId: 'user-lead', newOwnerId: 'user-new' },
      });
    });

    it('refuses a target who cannot author reports', async () => {
      mockAuthority.mockResolvedValue({ active: true, permissions: ['reports:read'], features: [] });
      await call('/definitions/:id/transfer', 'post', { params: { id: 'def-1' }, body: { ownerId: 'user-new' } });
      expect(store.transferOwner).not.toHaveBeenCalled();
      expect(mockSendBadRequest.mock.calls[0][1]).toContain('active member');
    });

    it('refuses a target who is no longer active', async () => {
      mockAuthority.mockResolvedValue({ active: false, permissions: [], features: [] });
      await call('/definitions/:id/transfer', 'post', { params: { id: 'def-1' }, body: { ownerId: 'gone' } });
      expect(store.transferOwner).not.toHaveBeenCalled();
    });

    /**
     * FAILS CLOSED. An unreachable platform must not become a way to park a
     * definition on an owner nobody verified — the scheduler would then re-check,
     * refuse, and pause it, so the transfer would have achieved nothing but
     * confusion.
     */
    it('refuses the transfer when platform cannot answer', async () => {
      mockAuthority.mockResolvedValue(null);
      await call('/definitions/:id/transfer', 'post', { params: { id: 'def-1' }, body: { ownerId: 'user-new' } });
      expect(store.transferOwner).not.toHaveBeenCalled();
    });
  });

  // ── Runs ──────────────────────────────────────────────────────────────────

  describe('runs', () => {
    beforeEach(() => {
      store.requireDefinition.mockResolvedValue(definition());
      store.createRun.mockResolvedValue({ run: run({ snapshot: null, status: 'drafting' }), created: true });
      store.completeRun.mockResolvedValue(run());
      mockComposeSnapshot.mockResolvedValue({ sections: [{ id: 'success_rate' }] });
    });

    it('lists a definition’s runs', async () => {
      store.listRuns.mockResolvedValue([run()]);
      await call('/definitions/:id/runs', 'get', { params: { id: 'def-1' } });
      expect(payload().runs).toHaveLength(1);
    });

    it('composes the last complete period by default', async () => {
      await call('/definitions/:id/runs', 'post', { params: { id: 'def-1' } });
      expect(store.createRun.mock.calls[0][0]).toMatchObject({ periodLabel: '2026-W37', version: 1 });
      expect(mockComposeSnapshot.mock.calls[0][0]).toEqual(['success_rate']);
      // The COMPOSED snapshot is what gets frozen onto the run.
      expect(store.completeRun).toHaveBeenCalledWith('acme', 'run-1', { sections: [{ id: 'success_rate' }] });
      expect(payload().run.snapshot).toBeDefined();
    });

    it('passes the definition’s timezone and week start to the composer', async () => {
      await call('/definitions/:id/runs', 'post', { params: { id: 'def-1' } });
      expect(mockComposeSnapshot.mock.calls[0][1]).toMatchObject({
        timezone: 'America/Chicago',
        weekStart: 'monday',
        orgId: 'acme',
      });
    });

    it('passes the org’s entitlements through, so a gated section renders locked', async () => {
      await call('/definitions/:id/runs', 'post', {
        params: { id: 'def-1' },
        user: { permissions: [], features: ['advanced_reporting'] },
      });
      expect(mockComposeSnapshot.mock.calls[0][1].features).toEqual(['advanced_reporting']);
    });

    it('rejects a label that is not a period of this cadence, and names the formats', async () => {
      await call('/definitions/:id/runs', 'post', { params: { id: 'def-1' }, body: { period: '2026-08' } });
      expect(mockSendBadRequest.mock.calls[0][1]).toContain('2026-W38');
      expect(store.createRun).not.toHaveBeenCalled();
    });

    /**
     * The route consults the ORG'S retention horizon before composing, and
     * `rejectUnreportablePeriod` refuses a window the data cannot support. That
     * refusal matters because the alternative is silent truncation: a report
     * labelled 2026-Q1 that quietly covers its last 30 days is worse than no
     * report, since a manager cannot tell.
     */
    /**
     * The grant could have been withdrawn since the definition was saved. A
     * narrowed report is the WRONG answer here — it would still be labelled as
     * covering the descendant teams — so the run is refused with the reason.
     */
    it('refuses to compose a rollup definition when the caller lost reports:rollup', async () => {
      store.requireDefinition.mockResolvedValue(definition({ scope: { kind: 'rollup' } }));
      await call('/definitions/:id/runs', 'post', {
        params: { id: 'def-1' },
        user: { permissions: ['reports:author'] },
      });
      expect(mockComposeSnapshot).not.toHaveBeenCalled();
      expect(store.createRun).not.toHaveBeenCalled();
      expect(mockSendBadRequest.mock.calls[0][1]).toContain('Roll up team reports');
    });

    it('measures the period against the org’s retention horizon', async () => {
      await call('/definitions/:id/runs', 'post', { params: { id: 'def-1' } });
      expect(mockRetentionWindow).toHaveBeenCalledWith('acme', 'event', 'acme');
    });

    it('reuses an existing run for a period rather than recomputing it', async () => {
      store.createRun.mockResolvedValue({ run: run(), created: false });
      await call('/definitions/:id/runs', 'post', { params: { id: 'def-1' } });
      expect(payload().reused).toBe(true);
      expect(mockComposeSnapshot).not.toHaveBeenCalled();
    });

    it('regenerating asks for the next version and supersedes the previous one', async () => {
      store.nextVersion.mockResolvedValue(2);
      store.createRun.mockResolvedValue({ run: run({ id: 'run-2', version: 2, snapshot: null }), created: true });
      store.completeRun.mockResolvedValue(run({ id: 'run-2', version: 2 }));
      store.listRuns.mockResolvedValue([run({ id: 'run-2', version: 2 }), run({ id: 'run-1', version: 1 })]);
      await call('/definitions/:id/runs', 'post', { params: { id: 'def-1' }, body: { regenerate: true } });
      expect(store.createRun.mock.calls[0][0].version).toBe(2);
      expect(store.supersede).toHaveBeenCalledWith('acme', 'run-1', 'run-2');
    });

    /** The run row STAYS, marked failed, so the lead sees why a report is missing. */
    it('marks the run failed when the composer throws, and answers 500 not 400', async () => {
      mockComposeSnapshot.mockRejectedValue(new Error('db down'));
      // A compose failure is OURS: the database was unreachable or a query broke, and
      // nothing the caller changes will help. So it is rethrown for the shared handler
      // (500 with the request id) rather than returned as a 400, which would tell the
      // caller and the dashboards that the request was at fault. The upstream message is
      // deliberately NOT passed through — it is logged with the cause by the executor.
      await expect(call('/definitions/:id/runs', 'post', { params: { id: 'def-1' } }))
        .rejects.toThrow('could not be computed');
      expect(mockSendBadRequest).not.toHaveBeenCalled();
      // The row stays, marked failed, so the lead sees WHY a report is missing.
      expect(store.failRun).toHaveBeenCalledWith('acme', 'run-1', expect.stringContaining('could not be computed'));
    });

    it('rate-limits composing per org', () => {
      const limiter = layers('/definitions/:id/runs', 'post')
        .map((l: any) => (l.handle as any).limiterOpts)
        .find(Boolean);
      expect(limiter).toMatchObject({ name: 'report-compose', max: 20, windowMs: 60_000 });
    });

    /** The list shape omits the snapshot — a history page must not ship N of them. */
    it('lists runs without their snapshots, and carries the publish state', async () => {
      store.listRuns.mockResolvedValue([run({
        status: 'published',
        publishedAt: NOW,
        publishedBy: 'lead',
        supersededBy: 'run-2',
        version: 2,
        leadNotes: 'context',
      })]);
      await call('/definitions/:id/runs', 'get', { params: { id: 'def-1' } });
      expect(payload().runs[0]).toMatchObject({
        status: 'published',
        publishedAt: NOW.toISOString(),
        publishedBy: 'lead',
        supersededBy: 'run-2',
        version: 2,
      });
      expect(payload().runs[0]).not.toHaveProperty('snapshot');
    });

    it('returns a run with its snapshot', async () => {
      store.requireRun.mockResolvedValue(run());
      await call('/runs/:id', 'get', { params: { id: 'run-1' } });
      expect(payload().run.snapshot).toEqual({ sections: [] });
    });

    it('saves the lead’s notes on a draft', async () => {
      store.setRunNotes.mockResolvedValue(run({ leadNotes: 'We paused deploys Tuesday.' }));
      await call('/runs/:id/notes', 'put', { params: { id: 'run-1' }, body: { leadNotes: 'We paused deploys Tuesday.' } });
      expect(store.setRunNotes).toHaveBeenCalledWith('acme', 'run-1', { leadNotes: 'We paused deploys Tuesday.' });
    });

    it('rejects a notes body with anything else in it', async () => {
      await call('/runs/:id/notes', 'put', { params: { id: 'run-1' }, body: { leadNotes: 'x', status: 'published' } });
      expect(mockSendBadRequest).toHaveBeenCalled();
      expect(store.setRunNotes).not.toHaveBeenCalled();
    });
  });

  // ── Publishing ────────────────────────────────────────────────────────────

  describe('publishing', () => {
    it('audits a first publish and reports the deliverable count', async () => {
      store.publishRun.mockResolvedValue({ run: run({ status: 'published', publishedAt: NOW }), alreadyPublished: false });
      store.getDefinition.mockResolvedValue(definition({ recipients: ['rec-1', 'rec-2'] }));
      store.getRecipients.mockResolvedValue([recipient(), recipient({ id: 'rec-2', verifiedAt: null })]);
      store.deliverability.mockImplementation((r: any) => ({ deliverable: r.verifiedAt !== null }));
      await call('/runs/:id/publish', 'post', { params: { id: 'run-1' } });
      expect(audit()).toMatchObject({
        action: 'reporting.report.published',
        details: { period: '2026-W37', version: 1, recipients: 1, pendingRecipients: 1 },
      });
      expect(payload().recipients).toEqual({ deliverable: 1, blocked: 1 });
    });

    /**
     * A second version of an already-published period is a CORRECTION, and reads
     * differently in an audit trail: someone reviewing the history needs to see
     * that the numbers a manager acted on were superseded.
     */
    it('audits a later version as a REPUBLISH', async () => {
      store.publishRun.mockResolvedValue({ run: run({ version: 2, status: 'published' }), alreadyPublished: false });
      store.getDefinition.mockResolvedValue(definition());
      await call('/runs/:id/publish', 'post', { params: { id: 'run-1' } });
      expect(audit().action).toBe('reporting.report.republished');
    });

    /** Two clicks, one audit event — and one set of deliveries. */
    it('audits nothing when the run was already published', async () => {
      store.publishRun.mockResolvedValue({ run: run({ status: 'published', publishedAt: NOW }), alreadyPublished: true });
      store.getDefinition.mockResolvedValue(definition());
      await call('/runs/:id/publish', 'post', { params: { id: 'run-1' } });
      expect(mockRecordAudit).not.toHaveBeenCalled();
      expect(payload().alreadyPublished).toBe(true);
    });

    /** A lead who learns this after publishing learns it too late. */
    it('says plainly that a delivered copy cannot be recalled', async () => {
      store.publishRun.mockResolvedValue({ run: run({ status: 'published' }), alreadyPublished: false });
      store.getDefinition.mockResolvedValue(definition());
      await call('/runs/:id/publish', 'post', { params: { id: 'run-1' } });
      expect(payload().notice).toMatch(/cannot be recalled/);
      expect(payload().notice).toMatch(/does not pull back an email/);
    });
  });

  // ── Share links ───────────────────────────────────────────────────────────

  describe('share links', () => {
    beforeEach(() => {
      store.requireRun.mockResolvedValue(run({ status: 'published' }));
      store.createShareLink.mockResolvedValue({ link: shareLink(), token: 'the-secret-token' });
    });

    it('lists a run’s links without any token', async () => {
      store.listShareLinks.mockResolvedValue([shareLink()]);
      await call('/runs/:id/links', 'get', { params: { id: 'run-1' } });
      expect(JSON.stringify(payload())).not.toContain('token');
    });

    /** A revoked or expiring link still has to read correctly in the manager list. */
    it('shapes a revoked link with its view history', async () => {
      store.listShareLinks.mockResolvedValue([shareLink({
        revokedAt: NOW,
        redactNames: true,
        viewCount: 4,
        lastViewedAt: NOW,
      })]);
      await call('/runs/:id/links', 'get', { params: { id: 'run-1' } });
      expect(payload().links[0]).toMatchObject({
        revokedAt: NOW.toISOString(),
        redactNames: true,
        viewCount: 4,
        lastViewedAt: NOW.toISOString(),
      });
    });

    it('mints a link, returning the token exactly once', async () => {
      await call('/runs/:id/links', 'post', { params: { id: 'run-1' }, body: {} });
      expect(payload().token).toBe('the-secret-token');
      expect(payload().notice).toMatch(/shown once/);
    });

    /**
     * BOTH gates are load-bearing: the lead's `reports:share`, and the ADMIN's
     * decision that public links are allowed in this org at all. The policy
     * defaults off, so an org that never considered them cannot have one minted by
     * someone who assumed their permission was the whole answer.
     */
    it('refuses to mint a link when the org has sharing turned off', async () => {
      store.getReportPolicy.mockResolvedValue({ externalSharing: false, recipientDomains: null, requireApproval: true });
      await call('/runs/:id/links', 'post', { params: { id: 'run-1' }, body: {} });
      expect(store.createShareLink).not.toHaveBeenCalled();
      expect(mockSendBadRequest.mock.calls[0][1]).toContain('turned off');
    });

    it('keeps the token out of the audit event', async () => {
      await call('/runs/:id/links', 'post', { params: { id: 'run-1' }, body: {} });
      expect(audit().action).toBe('reporting.report.link.created');
      expect(JSON.stringify(audit())).not.toContain('the-secret-token');
      expect(audit().details.expiresAt).toBeDefined();
    });

    it('rejects a window longer than the maximum', async () => {
      await call('/runs/:id/links', 'post', { params: { id: 'run-1' }, body: { ttlDays: 3650 } });
      expect(mockSendBadRequest).toHaveBeenCalled();
      expect(store.createShareLink).not.toHaveBeenCalled();
    });

    it('passes redactNames through when asked', async () => {
      await call('/runs/:id/links', 'post', { params: { id: 'run-1' }, body: { redactNames: true } });
      expect(store.createShareLink.mock.calls[0][0].redactNames).toBe(true);
    });

    it('revokes a link and records the views it had served', async () => {
      store.revokeShareLink.mockResolvedValue(shareLink({ revokedAt: NOW, viewCount: 7 }));
      await call('/links/:id', 'delete', { params: { id: 'link-1' } });
      expect(audit()).toMatchObject({ action: 'reporting.report.link.revoked', details: { viewCount: 7 } });
    });
  });

  // ── Recipients ────────────────────────────────────────────────────────────

  describe('recipients', () => {
    beforeEach(() => {
      store.upsertRecipient.mockResolvedValue({ recipient: recipient(), verificationToken: 'verify-me' });
      store.admitRecipient.mockReturnValue({ admitted: true, member: false, needsApproval: false });
      mockRecipientCheck.mockResolvedValue({ member: false });
    });

    it('lists recipients with their delivery state', async () => {
      store.listRecipients.mockResolvedValue([recipient({ verifiedAt: null })]);
      store.deliverability.mockReturnValue({ deliverable: false, reason: 'pending_verification' });
      await call('/recipients', 'get');
      expect(payload().recipients[0]).toMatchObject({ verified: false, deliverable: false, blockedReason: 'pending_verification' });
    });

    it('shapes a recipient with a display name and an approver', async () => {
      store.listRecipients.mockResolvedValue([recipient({ displayName: 'Dana Ng', approvedBy: 'admin-1' })]);
      await call('/recipients', 'get');
      expect(payload().recipients[0]).toMatchObject({
        displayName: 'Dana Ng',
        approvedBy: 'admin-1',
        verified: true,
        unsubscribed: false,
        deliverable: true,
      });
      expect(payload().recipients[0]).not.toHaveProperty('blockedReason');
    });

    it('refuses an address the org policy does not admit', async () => {
      store.admitRecipient.mockReturnValue({ admitted: false, reason: 'members only' });
      await call('/recipients', 'post', { body: { email: 'outsider@other.test' } });
      expect(store.upsertRecipient).not.toHaveBeenCalled();
      expect(mockSendBadRequest.mock.calls[0][1]).toBe('members only');
    });

    it('pre-verifies a member and asks for no confirmation', async () => {
      mockRecipientCheck.mockResolvedValue({ member: true });
      store.admitRecipient.mockReturnValue({ admitted: true, member: true, needsApproval: false });
      store.upsertRecipient.mockResolvedValue({ recipient: recipient() });
      await call('/recipients', 'post', { body: { email: 'member@acme.test' } });
      expect(store.upsertRecipient.mock.calls[0][0].preVerified).toBe(true);
      expect(payload().verificationToken).toBeUndefined();
    });

    /**
     * Platform unreachable ⇒ treated as NOT a member, so the address falls through
     * to the domain policy and still has to confirm by email. The other way round
     * would let an outage skip verification.
     */
    it('treats an unanswerable member check as not-a-member', async () => {
      mockRecipientCheck.mockResolvedValue(null);
      await call('/recipients', 'post', { body: { email: 'manager@acme.test' } });
      const members = store.admitRecipient.mock.calls[0][2] as Set<string>;
      expect(members.size).toBe(0);
    });

    it('holds an external address for approval when the org requires it', async () => {
      store.admitRecipient.mockReturnValue({ admitted: true, member: false, needsApproval: true });
      await call('/recipients', 'post', { body: { email: 'vp@partner.test' }, user: { permissions: ['reports:author'] } });
      expect(store.upsertRecipient.mock.calls[0][0].approvedBy).toBeNull();
      expect(payload().pendingApproval).toBe(true);
      expect(audit().details.pendingApproval).toBe(true);
    });

    /** Requiring an admin to approve the address they just typed is ceremony. */
    it('an admin adding the address approves it in the same step', async () => {
      store.admitRecipient.mockReturnValue({ admitted: true, member: false, needsApproval: true });
      await call('/recipients', 'post', {
        body: { email: 'vp@partner.test' },
        user: { permissions: ['reports:author', 'org:settings'] },
      });
      expect(store.upsertRecipient.mock.calls[0][0].approvedBy).toBe('user-lead');
      expect(payload().pendingApproval).toBe(false);
    });

    it('records the address in the audit event but never the token', async () => {
      await call('/recipients', 'post', { body: { email: 'manager@acme.test' } });
      expect(audit()).toMatchObject({ action: 'reporting.report.recipient.added', details: { email: 'manager@acme.test' } });
      expect(JSON.stringify(audit())).not.toContain('verify-me');
    });

    it('rejects a malformed address before any policy work', async () => {
      await call('/recipients', 'post', { body: { email: 'not-an-email' } });
      expect(store.getReportPolicy).not.toHaveBeenCalled();
      expect(store.upsertRecipient).not.toHaveBeenCalled();
    });

    it('resends a pending confirmation', async () => {
      store.resendVerification.mockResolvedValue({ recipient: recipient({ verifiedAt: null }), token: 'fresh' });
      await call('/recipients/:id/resend', 'post', { params: { id: 'rec-1' } });
      expect(payload().verificationToken).toBe('fresh');
    });

    it('rate-limits recipient additions and resends per org', () => {
      const add = layers('/recipients', 'post').map((l: any) => (l.handle as any).limiterOpts).find(Boolean);
      const resend = layers('/recipients/:id/resend', 'post').map((l: any) => (l.handle as any).limiterOpts).find(Boolean);
      expect(add).toMatchObject({ name: 'report-recipient-add', max: 30 });
      expect(resend).toMatchObject({ name: 'report-recipient-resend', max: 10 });
    });

    it('removes a recipient and records which address it was', async () => {
      store.getRecipients.mockResolvedValue([recipient()]);
      store.deleteRecipient.mockResolvedValue(undefined);
      await call('/recipients/:id', 'delete', { params: { id: 'rec-1' } });
      expect(audit()).toMatchObject({
        action: 'reporting.report.recipient.removed',
        details: { email: 'manager@acme.test' },
      });
    });
  });

  // ── Policy ────────────────────────────────────────────────────────────────

  describe('policy', () => {
    it('reads the org policy', async () => {
      await call('/policy', 'get');
      expect(payload().policy.externalSharing).toBe(true);
    });

    it('normalizes the configured domains', async () => {
      await call('/policy', 'put', { body: { recipientDomains: [' @Partner.TEST ', 'partner.test'] } });
      expect(store.setReportPolicy.mock.calls[0][1].recipientDomains).toEqual(['partner.test']);
    });

    it('can close the list back to members only', async () => {
      await call('/policy', 'put', { body: { recipientDomains: null } });
      expect(store.setReportPolicy.mock.calls[0][1].recipientDomains).toBeNull();
    });

    it('rejects an unknown policy field', async () => {
      await call('/policy', 'put', { body: { allowEverything: true } });
      expect(mockSendBadRequest).toHaveBeenCalled();
      expect(store.setReportPolicy).not.toHaveBeenCalled();
    });

    it('audits the resulting policy', async () => {
      await call('/policy', 'put', { body: { externalSharing: true } });
      expect(audit()).toMatchObject({ action: 'reporting.report.policy.update', targetType: 'report-policy' });
    });

  });

  // ── The permission split, asserted on the MOUNTED chain ───────────────────

  /**
   * A permission gate that is merely documented is not a gate. This reads the
   * mounted middleware of every route and pins which permission it carries — the
   * three-way split is the feature's authorization model, so a route silently
   * mounted on the wrong one (or on none) has to fail here.
   *
   * `/policy` is `org:settings` on purpose: a lead must not be able to widen their
   * own audience.
   */
  describe('permission wiring', () => {
    const mounted = (path: string, method: string): string[] =>
      layers(path, method)
        .map((l: any) => (l.handle as any).__permission)
        .filter((p: unknown): p is string => typeof p === 'string');

    it.each([
      ['/definitions', 'get', 'reports:read'],
      ['/definitions', 'post', 'reports:author'],
      ['/definitions/:id', 'get', 'reports:read'],
      ['/definitions/:id', 'put', 'reports:author'],
      ['/definitions/:id', 'delete', 'reports:author'],
      ['/definitions/:id/transfer', 'post', 'reports:author'],
      ['/definitions/:id/runs', 'get', 'reports:read'],
      ['/definitions/:id/runs', 'post', 'reports:author'],
      ['/runs/:id', 'get', 'reports:read'],
      ['/runs/:id/notes', 'put', 'reports:author'],
      ['/runs/:id/publish', 'post', 'reports:share'],
      ['/runs/:id/links', 'get', 'reports:read'],
      ['/runs/:id/links', 'post', 'reports:share'],
      ['/links/:id', 'delete', 'reports:share'],
      ['/recipients', 'get', 'reports:read'],
      ['/recipients', 'post', 'reports:author'],
      ['/recipients/:id/resend', 'post', 'reports:author'],
      ['/recipients/:id', 'delete', 'reports:author'],
      ['/policy', 'get', 'reports:read'],
      ['/policy', 'put', 'org:settings'],
    ])('%s %s is gated on %s', (path, method, permission) => {
      expect(mounted(path, method)).toEqual([permission]);
    });

    /**
     * Publishing and link-minting are the only routes that put numbers OUTSIDE the
     * platform, and they are the only ones on `reports:share`. A lead can be
     * allowed to build reports without being allowed to send them out, which is
     * only true while this list stays exactly these three.
     */
    it('only the outward-facing routes carry reports:share', () => {
      const shareRoutes = router.stack
        .filter((l: any) => l.route)
        .flatMap((l: any) => Object.keys(l.route.methods).map((m) => [l.route.path, m] as const))
        .filter(([path, method]: readonly [string, string]) => mounted(path, method).includes('reports:share'))
        .map(([path, method]: readonly [string, string]) => `${method.toUpperCase()} ${path}`)
        .sort();
      expect(shareRoutes).toEqual([
        'DELETE /links/:id',
        'POST /runs/:id/links',
        'POST /runs/:id/publish',
      ]);
    });

    it('every route carries exactly one permission gate', () => {
      const ungated = router.stack
        .filter((l: any) => l.route)
        .flatMap((l: any) => Object.keys(l.route.methods).map((m) => [l.route.path, m] as const))
        .filter(([path, method]: readonly [string, string]) => mounted(path, method).length !== 1)
        .map(([path, method]: readonly [string, string]) => `${method.toUpperCase()} ${path}`);
      expect(ungated).toEqual([]);
    });
  });

  // ── The member's PDF ──────────────────────────────────────────────────────

  describe('GET /runs/:id/pdf', () => {
    const pdf = (req: any = {}) => call('/runs/:id/pdf', 'get', { params: { id: 'run-1' }, ...req });

    beforeEach(() => {
      store.requireRun.mockResolvedValue(run({ snapshot: { sections: [], notes: [], methodology: 'm', generatedAt: NOW.toISOString() } }));
      store.getDefinition.mockResolvedValue(definition());
    });

    it('serves the file, named after the report and its period', async () => {
      await pdf();
      expect(headers.get('Content-Type')).toBe('application/pdf');
      // Filed next to last month's, so the name has to be readable rather than a uuid.
      expect(headers.get('Content-Disposition')).toContain('Weekly_delivery_2026-W37.pdf');
      expect(lastRes.status).toHaveBeenCalledWith(200);
      expect(lastRes.end).toHaveBeenCalled();
    });

    it('sanitizes a report name that would otherwise break the header', async () => {
      store.getDefinition.mockResolvedValue(definition({ name: 'Q3 "review"\r\nSet-Cookie: x=1' }));
      await pdf();
      const disposition = headers.get('Content-Disposition') ?? '';
      // What matters is that nothing can ESCAPE the quoted file name: a CRLF would split
      // the response into a second header, and a bare quote would end the parameter early.
      // The words that remain are inert text inside the quotes — `Set-Cookie` surviving as
      // part of a file name is not a header.
      expect(disposition).not.toMatch(/[\r\n]/);
      expect(disposition).toBe('attachment; filename="Q3__review___Set-Cookie__x_1_2026-W37.pdf"');
      // One opening and one closing quote, and none in between.
      expect((disposition.match(/"/g) ?? [])).toHaveLength(2);
    });

    it('INCLUDES the executive summary — a member already sees it on the review page', async () => {
      store.requireRun.mockResolvedValue(run({
        aiDraft: 'Success rate held at 91% across the period.',
        snapshot: { sections: [], notes: [], methodology: 'm', generatedAt: NOW.toISOString() },
      }));
      await pdf();
      expect(renderedWith[0]?.executiveSummary).toBe('Success rate held at 91% across the period.');
      expect(mockRenderPdf.mock.calls[0]?.[0] as string).toContain('Success rate held at 91%');
    });

    it('does not mark an internal copy as redacted, because nothing was', async () => {
      await pdf();
      expect(renderedWith[0]?.namesRedacted).toBeUndefined();
      expect(mockRenderPdf.mock.calls[0]?.[0] as string).not.toMatch(/names have been replaced/i);
    });

    it('states no link expiry, because an internal download came from no link', async () => {
      await pdf();
      expect(renderedWith[0]?.expiresAt).toBeUndefined();
    });

    it('renders an UNPUBLISHED run too — a lead previews before publishing', async () => {
      store.requireRun.mockResolvedValue(run({ status: 'ready_for_review', publishedAt: null }));
      await pdf();
      expect(lastRes.status).toHaveBeenCalledWith(200);
    });

    it('answers 503 when the instance has no renderer, without asking it to render', async () => {
      mockPdfAvailable.mockResolvedValue(false);
      await pdf();
      expect(mockRenderPdf).not.toHaveBeenCalled();
    });

    it('answers 429 when the renderer is busy', async () => {
      mockRenderPdf.mockResolvedValue({ ok: false, reason: 'busy', message: 'busy' });
      await pdf();
      expect(lastRes.end).not.toHaveBeenCalled();
    });

    it('falls back to a generic title when the definition is gone', async () => {
      // A run outlives a deleted definition, and a download of it must not 500.
      store.getDefinition.mockResolvedValue(null);
      await pdf();
      expect(lastRes.status).toHaveBeenCalledWith(200);
      expect(renderedWith[0]?.title).toBe('Delivery report');
    });

    it('reads the run through the tenant-scoped store, so another org cannot fetch it', async () => {
      await pdf();
      expect(store.requireRun).toHaveBeenCalledWith('acme', 'run-1');
    });
  });
});
