// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The support-case WORKFLOW routes: status, severity, and the two owners.
 *
 * These four routes decide who may move a case's relationship to the response
 * time it was sold, so the governance split is the whole point and each half is
 * asserted from both sides:
 *
 *  - STATUS is both-sided, because a tenant resolving its own case is the point
 *    of having a status at all. But the tenant may set only a SUBSET: a customer
 *    saying "this is sorted" is `closed`, while `resolved` is us claiming we
 *    fixed it and `awaiting_support` is us accepting the ball. Letting a tenant
 *    set either would let them assert our side of the record.
 *
 *  - SEVERITY RE-RANKING IS STAFF ONLY, and that is a pricing rule rather than a
 *    permission detail. The tenant picks severity at open; if they could also
 *    change it afterwards they would choose the response target they are owed
 *    after the fact, which at $99.99 a contact is the premium SKU.
 *
 *  - ASSIGN is staff only (`assigned_to` is a system-org actor) and TRANSFER is
 *    tenant only (handing to another designated contact of the SAME org).
 *
 *  - The transfer target is validated against the case's OWN ORG, never the
 *    account subtree. The contact ALLOWANCE pools subtree-wide; ownership does
 *    not, so accepting a sibling team's contact is precisely the cross-team case
 *    leak that rule exists to prevent. That assertion is the most important one
 *    in this file.
 *
 * `loadCase` is the other recurring subject: a tenant acting on another org's
 * case gets a 404 rather than a 403, because an authorization error would
 * confirm the case exists.
 */

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockFindCaseByThread = jest.fn<AnyFn>();
const mockSetCaseStatus = jest.fn<AnyFn>();
const mockSetCaseSeverity = jest.fn<AnyFn>();
const mockAssignCase = jest.fn<AnyFn>();
const mockTransferCaseToContact = jest.fn<AnyFn>();
const mockIsSupportContact = jest.fn<AnyFn>();
const mockRateCase = jest.fn<AnyFn>();
const mockListCanned = jest.fn<AnyFn>();
const mockCreateCanned = jest.fn<AnyFn>();
const mockUpdateCanned = jest.fn<AnyFn>();
const mockDeleteCanned = jest.fn<AnyFn>();
const mockAssignCases = jest.fn<AnyFn>();
const mockCloseCases = jest.fn<AnyFn>();
const mockAddNote = jest.fn<AnyFn>();
const mockListNotes = jest.fn<AnyFn>();
const mockDeleteNote = jest.fn<AnyFn>();
const mockRecordAudit = jest.fn<AnyFn>();

/** Mutable so a test can act as a tenant or as the desk. */
let identity = { orgId: 'org-1', userId: 'user-1' };
/** What the mocked `isSystemAdmin` reports for the request under test. */
let staff = false;

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  SYSTEM_ORG_ID: 'system',
  isSystemAdmin: () => staff,
  // Middleware, bypassed by `getHandler` (which takes the terminal handler) —
  // its PRESENCE on the route is asserted separately below, which is the actual
  // contract: the gate has to be visible in the route table, not buried in a
  // handler branch where route-coverage cannot see it.
  requireSystemAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  recordAudit: mockRecordAudit,
  actorId: ({ userId }: { userId: string }) => `user:${userId}`,
  audited: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  sendSuccess: (res: any, status: number, data: any) => res.status(status).json({ success: true, data }),
  sendBadRequest: (res: any, message: string, code?: string) => res.status(400).json({ success: false, message, code }),
  sendError: (res: any, status: number, message: string, code?: string) => res.status(status).json({ success: false, message, code }),
  getParam: (p: any, k: string) => p?.[k],
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  createAuthenticatedWithOrgRoute: () => [],
  // `stubModule` makes every non-overridden export THROW on call, which is the
  // point of it — but it means a new metric emission in the route turns into a
  // 500 here rather than a missing-export error. The CSAT route observes
  // `support_satisfaction`, so this has to be listed.
  observe: () => undefined,
  withRoute: (handler: Function) => async (req: any, res: any) => {
    try {
      await handler({ req, res, ctx: { log: jest.fn<AnyFn>() }, orgId: identity.orgId, userId: identity.userId });
    } catch (err: any) {
      res.status(500).json({ message: err instanceof Error ? err.message : String(err) });
    }
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  SUPPORT_CASE_STATUSES: ['open', 'awaiting_support', 'awaiting_customer', 'resolved', 'closed'],
  findCaseByThread: mockFindCaseByThread,
  setCaseStatus: mockSetCaseStatus,
  setCaseSeverity: mockSetCaseSeverity,
  assignCase: mockAssignCase,
  transferCaseToContact: mockTransferCaseToContact,
  isSupportContact: mockIsSupportContact,
  rateCase: (...a: unknown[]) => mockRateCase(...a),
  listCannedResponses: (...a: unknown[]) => mockListCanned(...a),
  createCannedResponse: (...a: unknown[]) => mockCreateCanned(...a),
  updateCannedResponse: (...a: unknown[]) => mockUpdateCanned(...a),
  deleteCannedResponse: (...a: unknown[]) => mockDeleteCanned(...a),
  assignCases: (...a: unknown[]) => mockAssignCases(...a),
  closeCases: (...a: unknown[]) => mockCloseCases(...a),
  addCaseNote: (...a: unknown[]) => mockAddNote(...a),
  listCaseNotes: (...a: unknown[]) => mockListNotes(...a),
  deleteCaseNote: (...a: unknown[]) => mockDeleteNote(...a),
}));

const { createSupportCaseRoutes } = await import('../src/routes/support-case-routes.js');

const router: any = createSupportCaseRoutes();

function layerOf(method: string, path: string) {
  const layer = router.stack.find((l: any) => l.route?.path === path && l.route?.methods[method]);
  if (!layer) throw new Error(`No route for ${method} ${path}`);
  return layer;
}
const getHandler = (method: string, path: string) => {
  const stack = layerOf(method, path).route.stack;
  return stack[stack.length - 1].handle;
};
/** The names of every middleware mounted on a route, for the gate assertions. */
const middlewareOf = (method: string, path: string): string[] =>
  layerOf(method, path).route.stack.map((s: any) => s.name as string);

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn<AnyFn>().mockReturnValue(res);
  res.json = jest.fn<AnyFn>().mockReturnValue(res);
  return res;
}
/** The (status, body) a handler answered with. */
const answered = (res: any) => ({
  status: res.status.mock.calls[0]?.[0] as number | undefined,
  body: res.json.mock.calls[0]?.[0] as any,
});

const CASE = {
  id: 'case-uuid-1',
  orgId: 'org-1',
  displayNumber: 1042,
  status: 'open',
  severity: 'normal',
  tenantContact: 'user-1',
  assignedTo: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  identity = { orgId: 'org-1', userId: 'user-1' };
  staff = false;
  mockFindCaseByThread.mockResolvedValue(CASE);
  mockListNotes.mockResolvedValue([]);
  mockRateCase.mockResolvedValue(true);
  mockListCanned.mockResolvedValue([]);
  mockCreateCanned.mockResolvedValue({ id: 'tpl-1', title: 'T', body: 'B' });
  mockUpdateCanned.mockResolvedValue(true);
  mockDeleteCanned.mockResolvedValue(true);
  mockAssignCases.mockImplementation(async (ids: string[]) => ids);
  mockCloseCases.mockImplementation(async (ids: string[]) => ids);
  mockAddNote.mockResolvedValue({ id: 'note-1', caseId: CASE.id, content: 'x', createdBy: 'staff-1', createdAt: new Date() });
  mockDeleteNote.mockResolvedValue(true);
});

describe('the permission gates are on the ROUTES, where the table can see them', () => {
  it('puts a system-admin gate on severity and assign', () => {
    // Not an in-handler `isSystemAdmin` check: route-coverage reads the route
    // table, so a gate expressed as a handler branch is invisible to it.
    for (const path of ['/support/:id/severity', '/support/:id/assign']) {
      expect(middlewareOf('patch', path)).toContain('requireSystemAdmin');
    }
  });

  it('does NOT put one on status or transfer, which are both-sided or tenant-only', () => {
    for (const path of ['/support/:id/status', '/support/:id/transfer']) {
      expect(middlewareOf('patch', path)).not.toContain('requireSystemAdmin');
    }
  });
});

describe('PATCH /support/:id/status', () => {
  const handler = getHandler('patch', '/support/:id/status');
  const call = async (body: unknown, id = 'thread-1') => {
    const res = mockRes();
    await handler({ params: { id }, body }, res);
    return answered(res);
  };

  it('lets a tenant close its own case, and folds the paused time into the answer', async () => {
    mockSetCaseStatus.mockResolvedValue({ status: 'closed', awaitingTotalSeconds: 3600 });
    const { status, body } = await call({ status: 'closed' });
    expect(status).toBe(200);
    expect(body.data).toEqual({ status: 'closed', awaitingTotalSeconds: 3600 });
    expect(mockSetCaseStatus).toHaveBeenCalledWith(CASE.id, 'closed', 'user-1');
  });

  it('refuses the two statuses that are OURS to declare, and names the allowed set', async () => {
    // The distinction is not obvious, so the refusal teaches it rather than just
    // denying — a caller should not have to guess that `resolved` is ours.
    for (const status of ['resolved', 'awaiting_support']) {
      const out = await call({ status });
      expect(out.status).toBe(403);
      expect(out.body.message).toMatch(/open, awaiting_customer, closed/);
      expect(out.body.message).toMatch(/support team/);
    }
    expect(mockSetCaseStatus).not.toHaveBeenCalled();
  });

  it('lets STAFF set exactly those two', async () => {
    staff = true;
    mockSetCaseStatus.mockResolvedValue({ status: 'resolved', awaitingTotalSeconds: 0 });
    expect((await call({ status: 'resolved' })).status).toBe(200);
  });

  it('treats the system org as staff even without the admin flag', async () => {
    // The desk acts as the system org; `orgId === SYSTEM_ORG_ID` is the second
    // route in, and without it the desk's own org could not resolve a case.
    identity = { orgId: 'system', userId: 'staff-1' };
    mockFindCaseByThread.mockResolvedValue({ ...CASE, orgId: 'tenant-9' });
    mockSetCaseStatus.mockResolvedValue({ status: 'resolved', awaitingTotalSeconds: 0 });
    expect((await call({ status: 'resolved' })).status).toBe(200);
  });

  it('rejects an unknown status before touching the store', async () => {
    const out = await call({ status: 'wishful' });
    expect(out.status).toBe(400);
    expect(mockFindCaseByThread).not.toHaveBeenCalled();
  });

  it('rejects a non-string status and a missing body', async () => {
    expect((await call({ status: 7 })).status).toBe(400);
    expect((await call(undefined)).status).toBe(400);
  });

  it('requires a case id', async () => {
    const res = mockRes();
    await handler({ params: {}, body: { status: 'open' } }, res);
    expect(answered(res).status).toBe(400);
  });

  it('404s a thread with no case', async () => {
    mockFindCaseByThread.mockResolvedValue(null);
    expect((await call({ status: 'open' })).status).toBe(404);
  });

  it('404s — not 403s — a tenant reaching for ANOTHER org case', async () => {
    // A 403 would confirm the case exists. RLS would hide the row anyway, so
    // this turns an invisible row into an honest answer rather than a
    // disclosure.
    mockFindCaseByThread.mockResolvedValue({ ...CASE, orgId: 'org-999' });
    const out = await call({ status: 'closed' });
    expect(out.status).toBe(404);
    expect(mockSetCaseStatus).not.toHaveBeenCalled();
  });

  it('matches the owning org case-insensitively', async () => {
    mockFindCaseByThread.mockResolvedValue({ ...CASE, orgId: 'ORG-1' });
    mockSetCaseStatus.mockResolvedValue({ status: 'closed', awaitingTotalSeconds: 0 });
    expect((await call({ status: 'closed' })).status).toBe(200);
  });

  it('404s when the update matched nothing — a soft-deleted case', async () => {
    mockSetCaseStatus.mockResolvedValue(null);
    expect((await call({ status: 'closed' })).status).toBe(404);
  });

  it('REFUSES a tenant reopening a CLOSED case, and says who can', async () => {
    // Two reasons at once. Product: `closed` is terminal, and a case that can
    // come back from it has no end, so nothing downstream can treat it as
    // finished. Commercial: it is the loophole that would let a tenant recycle
    // ONE case indefinitely rather than open new ones, which under a
    // per-contact case allowance is a direct way to avoid the allowance.
    mockFindCaseByThread.mockResolvedValue({ ...CASE, status: 'closed' });
    const out = await call({ status: 'open' });
    expect(out.status).toBe(403);
    expect(out.body.message).toMatch(/closed/i);
    expect(out.body.message).toMatch(/support team|new case/i);
    expect(mockSetCaseStatus).not.toHaveBeenCalled();
  });

  it('lets STAFF reopen it', async () => {
    staff = true;
    mockFindCaseByThread.mockResolvedValue({ ...CASE, status: 'closed' });
    mockSetCaseStatus.mockResolvedValue({ status: 'open', awaitingTotalSeconds: 0 });
    expect((await call({ status: 'open' })).status).toBe(200);
  });

  it('still lets a tenant CLOSE — the asymmetry is reopening, not closing', async () => {
    mockSetCaseStatus.mockResolvedValue({ status: 'closed', awaitingTotalSeconds: 0 });
    expect((await call({ status: 'closed' })).status).toBe(200);
  });

  it('treats closed → closed as a harmless no-op, not a reopen', async () => {
    // The guard is on the TRANSITION out of a terminal state, not on any
    // particular target, so an idempotent retry must not 403.
    mockFindCaseByThread.mockResolvedValue({ ...CASE, status: 'closed' });
    mockSetCaseStatus.mockResolvedValue({ status: 'closed', awaitingTotalSeconds: 0 });
    expect((await call({ status: 'closed' })).status).toBe(200);
  });

  it('lets a tenant reopen a RESOLVED case, because that is the feedback loop', async () => {
    // `resolved` is us claiming a fix. Moving it back to `open` is the customer
    // saying "that did not work", which is the whole reason `resolved` is a
    // separate state from `closed` — and it is not the same loophole, since
    // every bounce is a rejected fix rather than a recycled case.
    mockFindCaseByThread.mockResolvedValue({ ...CASE, status: 'resolved' });
    mockSetCaseStatus.mockResolvedValue({ status: 'open', awaitingTotalSeconds: 0 });
    expect((await call({ status: 'open' })).status).toBe(200);
  });

  it('audits the TRANSITION, not just the end state', async () => {
    // A case bouncing between awaiting states is the thing an auditor reads, and
    // `to` alone cannot show it.
    mockSetCaseStatus.mockResolvedValue({ status: 'closed', awaitingTotalSeconds: 0 });
    await call({ status: 'closed' });
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'support.case.status',
      actorId: 'user:user-1',
      affectedOrgId: 'org-1',
      targetType: 'support_case',
      targetId: 'thread-1',
      details: expect.objectContaining({ caseNumber: 1042, from: 'open', to: 'closed', byStaff: false }),
    }));
  });

  it('records WHO moved it, so a staff action is distinguishable in the trail', async () => {
    staff = true;
    mockSetCaseStatus.mockResolvedValue({ status: 'resolved', awaitingTotalSeconds: 0 });
    await call({ status: 'resolved' });
    expect(mockRecordAudit.mock.calls[0]![0]).toMatchObject({ details: { byStaff: true } });
  });
});

describe('PATCH /support/:id/severity — the pricing gate', () => {
  const handler = getHandler('patch', '/support/:id/severity');
  const call = async (body: unknown, id = 'thread-1') => {
    const res = mockRes();
    await handler({ params: { id }, body }, res);
    return answered(res);
  };

  it('re-ranks and returns the stored severity', async () => {
    mockSetCaseSeverity.mockResolvedValue('urgent');
    const out = await call({ severity: 'urgent' });
    expect(out.status).toBe(200);
    expect(out.body.data).toEqual({ severity: 'urgent' });
  });

  it('accepts only the three real severities', async () => {
    for (const severity of ['critical', 'low', '', 9, null]) {
      expect((await call({ severity })).status).toBe(400);
    }
    expect(mockSetCaseSeverity).not.toHaveBeenCalled();
  });

  it('resolves a case belonging to ANY org, because the caller is the desk', async () => {
    // `loadCase(..., staff: true)` unconditionally here: the route is already
    // behind `requireSystemAdmin`, so an org match would only break the desk.
    identity = { orgId: 'system', userId: 'staff-1' };
    mockFindCaseByThread.mockResolvedValue({ ...CASE, orgId: 'tenant-9' });
    mockSetCaseSeverity.mockResolvedValue('high');
    expect((await call({ severity: 'high' })).status).toBe(200);
  });

  it('audits from AND to, which is the reason this action exists', async () => {
    // A severity change moves which target applies, so a downgrade just before
    // a breach has to be visible. `to` alone would hide it.
    mockSetCaseSeverity.mockResolvedValue('normal');
    await call({ severity: 'normal' });
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'support.case.severity',
      details: expect.objectContaining({ from: 'normal', to: 'normal', caseNumber: 1042 }),
    }));
  });

  it('404s a missing case and a no-op update', async () => {
    mockFindCaseByThread.mockResolvedValue(null);
    expect((await call({ severity: 'high' })).status).toBe(404);
    mockFindCaseByThread.mockResolvedValue(CASE);
    mockSetCaseSeverity.mockResolvedValue(null);
    expect((await call({ severity: 'high' })).status).toBe(404);
  });

  it('requires a case id', async () => {
    const res = mockRes();
    await handler({ params: {}, body: { severity: 'high' } }, res);
    expect(answered(res).status).toBe(400);
  });
});

describe('PATCH /support/:id/assign — the staff owner', () => {
  const handler = getHandler('patch', '/support/:id/assign');
  const call = async (body: unknown, id = 'thread-1') => {
    const res = mockRes();
    await handler({ params: { id }, body }, res);
    return answered(res);
  };

  it('takes a case', async () => {
    mockAssignCase.mockResolvedValue({ assignedTo: 'staff-2' });
    const out = await call({ assignedTo: 'staff-2' });
    expect(out.status).toBe(200);
    expect(out.body.data).toEqual({ assignedTo: 'staff-2' });
  });

  it('treats null as a VALUE — releasing to the unowned pool', async () => {
    // "I cannot take this" has to be sayable without inventing a pseudo-
    // assignee, and a case stuck on whoever grabbed it first is how the unowned
    // pool stops working. So `null` succeeds and `undefined` is the error.
    mockAssignCase.mockResolvedValue({ assignedTo: null });
    const out = await call({ assignedTo: null });
    expect(out.status).toBe(200);
    expect(mockAssignCase).toHaveBeenCalledWith(CASE.id, null, 'user-1');
  });

  it('rejects a MISSING assignedTo, and says null is how to release', async () => {
    const out = await call({});
    expect(out.status).toBe(400);
    expect(out.body.message).toMatch(/null to release/);
  });

  it('rejects a non-string, non-null assignedTo', async () => {
    expect((await call({ assignedTo: 7 })).status).toBe(400);
    expect((await call({ assignedTo: { id: 'x' } })).status).toBe(400);
  });

  it('tolerates a completely absent body', async () => {
    const res = mockRes();
    await handler({ params: { id: 'thread-1' } }, res);
    expect(answered(res).status).toBe(400);
  });

  it('audits the ownership move, from and to', async () => {
    mockAssignCase.mockResolvedValue({ assignedTo: 'staff-2' });
    await call({ assignedTo: 'staff-2' });
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'support.case.assign',
      details: expect.objectContaining({ from: null, to: 'staff-2' }),
    }));
  });

  it('404s a missing case and a no-op update', async () => {
    mockFindCaseByThread.mockResolvedValue(null);
    expect((await call({ assignedTo: 'x' })).status).toBe(404);
    mockFindCaseByThread.mockResolvedValue(CASE);
    mockAssignCase.mockResolvedValue(null);
    expect((await call({ assignedTo: 'x' })).status).toBe(404);
  });

  it('requires a case id', async () => {
    const res = mockRes();
    await handler({ params: {}, body: { assignedTo: null } }, res);
    expect(answered(res).status).toBe(400);
  });
});

describe('PATCH /support/:id/transfer — the tenant owner', () => {
  const handler = getHandler('patch', '/support/:id/transfer');
  const call = async (body: unknown, id = 'thread-1') => {
    const res = mockRes();
    await handler({ params: { id }, body }, res);
    return answered(res);
  };

  it('hands the case to another designated contact', async () => {
    mockIsSupportContact.mockResolvedValue(true);
    mockTransferCaseToContact.mockResolvedValue({ tenantContact: 'user-2' });
    const out = await call({ tenantContact: 'user-2' });
    expect(out.status).toBe(200);
    expect(out.body.data).toEqual({ tenantContact: 'user-2' });
  });

  it('THE LEAK GUARD: validates the target against the case OWN ORG, never the subtree', async () => {
    // The contact ALLOWANCE pools subtree-wide; ownership does not. Passing the
    // expanded subtree here would accept a sibling team's contact and make one
    // team's support cases readable by another — the exact failure the own-org
    // ownership rule exists to prevent. A single-element scope is the assertion.
    mockIsSupportContact.mockResolvedValue(true);
    mockTransferCaseToContact.mockResolvedValue({ tenantContact: 'user-2' });
    await call({ tenantContact: 'user-2' });
    expect(mockIsSupportContact).toHaveBeenCalledWith(['org-1'], 'user-2');
    const [scope] = mockIsSupportContact.mock.calls[0] as [string[]];
    expect(scope).toHaveLength(1);
  });

  it('uses the CASE org for that check, not the caller org', async () => {
    // They are the same for a tenant, but if the two ever diverge the case's own
    // org is the right one: it is where the case lives and whose contacts may
    // own it.
    mockFindCaseByThread.mockResolvedValue({ ...CASE, orgId: 'org-1' });
    identity = { orgId: 'org-1', userId: 'user-9' };
    mockIsSupportContact.mockResolvedValue(true);
    mockTransferCaseToContact.mockResolvedValue({ tenantContact: 'user-2' });
    await call({ tenantContact: 'user-2' });
    expect(mockIsSupportContact).toHaveBeenCalledWith(['org-1'], 'user-2');
  });

  it('refuses a target who is not a live designated contact', async () => {
    mockIsSupportContact.mockResolvedValue(false);
    const out = await call({ tenantContact: 'stranger' });
    expect(out.status).toBe(400);
    expect(out.body.message).toMatch(/not a designated support contact/);
    expect(mockTransferCaseToContact).not.toHaveBeenCalled();
  });

  it('rejects a missing or non-string target', async () => {
    for (const tenantContact of [undefined, '', 7, null]) {
      expect((await call({ tenantContact })).status).toBe(400);
    }
    expect(mockIsSupportContact).not.toHaveBeenCalled();
  });

  it('is TENANT-scoped: a staff caller gets the same org check as anyone', async () => {
    // `loadCase(..., staff: false)` unconditionally. Transfer moves the TENANT
    // owner, so there is no desk-wide variant of it — staff reassign on their
    // own side with /assign.
    staff = true;
    identity = { orgId: 'system', userId: 'staff-1' };
    mockFindCaseByThread.mockResolvedValue({ ...CASE, orgId: 'tenant-9' });
    expect((await call({ tenantContact: 'user-2' })).status).toBe(404);
  });

  it('audits the handover WITHOUT touching createdBy', async () => {
    // Who RAISED the case never changes. Recording it as part of a handover
    // would blur the one fact the trail must keep stable.
    mockIsSupportContact.mockResolvedValue(true);
    mockTransferCaseToContact.mockResolvedValue({ tenantContact: 'user-2' });
    await call({ tenantContact: 'user-2' });
    const audit = mockRecordAudit.mock.calls[0]![0] as { action: string; details: Record<string, unknown> };
    expect(audit.action).toBe('support.case.transfer');
    expect(audit.details).toMatchObject({ from: 'user-1', to: 'user-2', caseNumber: 1042 });
    expect(audit.details).not.toHaveProperty('createdBy');
  });

  it('404s a missing case and a no-op update', async () => {
    mockFindCaseByThread.mockResolvedValue(null);
    expect((await call({ tenantContact: 'user-2' })).status).toBe(404);
    mockFindCaseByThread.mockResolvedValue(CASE);
    mockIsSupportContact.mockResolvedValue(true);
    mockTransferCaseToContact.mockResolvedValue(null);
    expect((await call({ tenantContact: 'user-2' })).status).toBe(404);
  });

  it('requires a case id', async () => {
    const res = mockRes();
    await handler({ params: {}, body: { tenantContact: 'user-2' } }, res);
    expect(answered(res).status).toBe(400);
  });
});

describe('staff notes — the one surface the tenant must never see', () => {
  // Notes live in their OWN TABLE rather than as a flag on `messages`, and that
  // is a safety property rather than a schema preference: `messages` is read
  // through one shared visibility predicate, so a flag there would leak a note
  // from any read path that forgot the extra condition, while a separate table
  // has to be joined deliberately. The route gates below are the second layer.
  const list = () => {
    const h = getHandler('get', '/support/:id/notes');
    const res = mockRes();
    return (async () => { await h({ params: { id: 'thread-1' } }, res); return answered(res); })();
  };
  const addNote = async (body: unknown, id = 'thread-1') => {
    const res = mockRes();
    await getHandler('post', '/support/:id/notes')({ params: { id }, body }, res);
    return answered(res);
  };
  const delNote = async (noteId = 'note-1') => {
    const res = mockRes();
    await getHandler('delete', '/support/:id/notes/:noteId')({ params: { id: 'thread-1', noteId } }, res);
    return answered(res);
  };

  it('gates ALL THREE routes on system admin, read included', () => {
    // The read is gated as hard as the writes, which is the exception to "gate
    // writes only" and the whole point: a note is the vendor's internal
    // assessment of a customer, so reading one is the sensitive act.
    for (const [method, path] of [
      ['get', '/support/:id/notes'],
      ['post', '/support/:id/notes'],
      ['delete', '/support/:id/notes/:noteId'],
    ] as const) {
      expect(middlewareOf(method, path)).toContain('requireSystemAdmin');
    }
  });

  it('lists notes for the case', async () => {
    mockListNotes.mockResolvedValue([{ id: 'n1', content: 'checked their logs' }]);
    const out = await list();
    expect(out.status).toBe(200);
    expect(out.body.data.notes).toHaveLength(1);
    expect(mockListNotes).toHaveBeenCalledWith(CASE.id);
  });

  it('adds a note scoped to the CASE org, never the staff author org', async () => {
    // The staff author's own org is the SYSTEM org. Sourcing the note's tenant
    // scope from it would put every note outside the scope meant to contain it.
    identity = { orgId: 'system', userId: 'staff-1' };
    mockFindCaseByThread.mockResolvedValue({ ...CASE, orgId: 'tenant-9' });
    const out = await addNote({ content: '  looks like a DNS issue  ' });
    expect(out.status).toBe(201);
    expect(mockAddNote).toHaveBeenCalledWith(CASE.id, 'tenant-9', 'looks like a DNS issue', 'staff-1');
  });

  it('audits METADATA ONLY — never the note body', async () => {
    // The central trail is read far more widely than the support queue is, so
    // putting internal commentary about a customer into it would defeat the
    // point of the notes being separate in the first place.
    await addNote({ content: 'customer is being unreasonable' });
    const entry = mockRecordAudit.mock.calls[0]![0] as { action: string; details: Record<string, unknown> };
    expect(entry.action).toBe('support.case.note');
    expect(entry.details).toMatchObject({ noteId: 'note-1', length: 'customer is being unreasonable'.length });
    expect(JSON.stringify(entry)).not.toMatch(/unreasonable/);
  });

  it('rejects an empty, whitespace-only, non-string or over-long note', async () => {
    for (const content of ['', '   ', 7, null, undefined, 'x'.repeat(5001)]) {
      expect((await addNote({ content })).status).toBe(400);
    }
    expect(mockAddNote).not.toHaveBeenCalled();
  });

  it('accepts a note at exactly the limit', async () => {
    expect((await addNote({ content: 'x'.repeat(5000) })).status).toBe(201);
  });

  it('requires a case id on the write', async () => {
    const res = mockRes();
    await getHandler('post', '/support/:id/notes')({ params: {}, body: { content: 'x' } }, res);
    expect(answered(res).status).toBe(400);
  });

  it('404s a thread with no case, on every verb', async () => {
    mockFindCaseByThread.mockResolvedValue(null);
    expect((await list()).status).toBe(404);
    expect((await addNote({ content: 'x' })).status).toBe(404);
    expect((await delNote()).status).toBe(404);
  });

  it('deletes a note and records it', async () => {
    const out = await delNote();
    expect(out.status).toBe(200);
    expect(mockDeleteNote).toHaveBeenCalledWith('note-1', 'user-1');
    expect(mockRecordAudit.mock.calls[0]![0]).toMatchObject({ details: { noteId: 'note-1', deleted: true } });
  });

  it('404s a second delete rather than reporting success', async () => {
    // Soft delete is guarded on `is_active`, so a repeat matches nothing. Worth
    // reporting: a note is a record of what the desk believed, and "already
    // gone" is different from "removed".
    mockDeleteNote.mockResolvedValue(false);
    const out = await delNote();
    expect(out.status).toBe(404);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it('requires a note id on the delete', async () => {
    const res = mockRes();
    await getHandler('delete', '/support/:id/notes/:noteId')({ params: { id: 'thread-1' } }, res);
    expect(answered(res).status).toBe(400);
  });
});

describe('PATCH /support/bulk — the queue is unusable at scale without it', () => {
  const handler = getHandler('patch', '/support/bulk');
  const bulk = async (body: unknown) => {
    const res = mockRes();
    await handler({ params: {}, body }, res);
    return answered(res);
  };
  const threeCases = () => {
    const cases = ['t1', 't2', 't3'].map((t, i) => ({ ...CASE, id: `case-${i}`, threadId: t, displayNumber: 100 + i }));
    mockFindCaseByThread.mockImplementation(async (t: string) => cases.find((c) => c.threadId === t) ?? null);
    return cases;
  };

  it('cannot be swallowed by a parameterised route', () => {
    // `/support/bulk` is TWO segments and every `:id` route here is three, so
    // nothing can capture the literal and declaration order is irrelevant to
    // it. This asserts the PROPERTY that makes that true rather than the
    // ordering: the day somebody adds a 2-segment `PATCH /support/:id`, the
    // literal starts needing to come first, and the failure would otherwise be
    // silent — `/support/bulk` resolving with id="bulk" and 404-ing on a case
    // that does not exist.
    const twoSegmentParam = router.stack
      .filter((l: any) => l.route?.methods?.patch)
      .map((l: any) => l.route.path as string)
      .filter((p: string) => /^\/support\/:[^/]+$/.test(p));
    expect(twoSegmentParam).toEqual([]);
  });

  it('is system-admin gated at the ROUTE layer', () => {
    expect(middlewareOf('patch', '/support/bulk')).toContain('requireSystemAdmin');
  });

  it('takes a batch, releases a batch, and closes a batch', async () => {
    threeCases();
    expect((await bulk({ threadIds: ['t1', 't2', 't3'], action: 'assign', assignedTo: 'me' })).status).toBe(200);
    expect(mockAssignCases).toHaveBeenCalledWith(['case-0', 'case-1', 'case-2'], 'me', 'user-1');

    jest.clearAllMocks();
    mockAssignCases.mockImplementation(async (ids: string[]) => ids);
    threeCases();
    await bulk({ threadIds: ['t1'], action: 'assign', assignedTo: null });
    expect(mockAssignCases).toHaveBeenCalledWith(['case-0'], null, 'user-1');

    jest.clearAllMocks();
    mockCloseCases.mockImplementation(async (ids: string[]) => ids);
    threeCases();
    await bulk({ threadIds: ['t1', 't2'], action: 'close' });
    expect(mockCloseCases).toHaveBeenCalledWith(['case-0', 'case-1'], 'user-1');
  });

  it('reports MOVED against REQUESTED, so a stale selection is visible', async () => {
    // The normal case on a shared queue: somebody else took or closed one
    // between the render and the click. A bare success would hide it.
    threeCases();
    mockAssignCases.mockResolvedValue(['case-0', 'case-2']);
    const out = await bulk({ threadIds: ['t1', 't2', 't3'], action: 'assign', assignedTo: 'me' });
    expect(out.body.data).toEqual({ moved: ['t1', 't3'], requested: 3 });
  });

  it('audits ONE ROW PER CASE, not one for the batch', async () => {
    // A bulk action is a convenience for the operator, never a reason for the
    // trail to be coarser: a dispute is about one case, and "it was part of a
    // batch of thirty" is not an answer.
    threeCases();
    await bulk({ threadIds: ['t1', 't2', 't3'], action: 'close' });
    expect(mockRecordAudit).toHaveBeenCalledTimes(3);
    const rows = mockRecordAudit.mock.calls.map((c) => c[0] as { targetId: string; details: Record<string, unknown> });
    expect(rows.map((r) => r.targetId)).toEqual(['t1', 't2', 't3']);
    for (const r of rows) expect(r.details).toMatchObject({ to: 'closed', bulk: true, byStaff: true });
  });

  it('audits only the cases that MOVED', async () => {
    threeCases();
    mockAssignCases.mockResolvedValue(['case-1']);
    await bulk({ threadIds: ['t1', 't2', 't3'], action: 'assign', assignedTo: 'me' });
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    expect((mockRecordAudit.mock.calls[0]![0] as { targetId: string }).targetId).toBe('t2');
  });

  it('REFUSES an over-large batch rather than silently acting on a prefix', async () => {
    // Bounded so one click cannot rewrite the queue, and refused rather than
    // clamped so the caller is told.
    const out = await bulk({ threadIds: Array.from({ length: 101 }, (_, i) => `t${i}`), action: 'close' });
    expect(out.status).toBe(400);
    expect(out.body.message).toMatch(/At most 100/);
    expect(mockCloseCases).not.toHaveBeenCalled();
  });

  it('accepts a batch at exactly the limit', async () => {
    mockFindCaseByThread.mockResolvedValue(CASE);
    expect((await bulk({ threadIds: Array.from({ length: 100 }, (_, i) => `t${i}`), action: 'close' })).status).toBe(200);
  });

  it('rejects an empty selection, a non-array, and a bad action', async () => {
    for (const body of [
      { threadIds: [], action: 'close' },
      { threadIds: 't1', action: 'close' },
      { threadIds: [1, 2], action: 'close' },
      { threadIds: ['t1'], action: 'delete' },
      { threadIds: ['t1'] },
      {},
    ]) {
      expect((await bulk(body)).status).toBe(400);
    }
  });

  it('rejects a missing assignedTo on an assign, but accepts null', async () => {
    threeCases();
    expect((await bulk({ threadIds: ['t1'], action: 'assign' })).status).toBe(400);
    expect((await bulk({ threadIds: ['t1'], action: 'assign', assignedTo: null })).status).toBe(200);
  });

  it('404s when none of the threads has a case', async () => {
    mockFindCaseByThread.mockResolvedValue(null);
    const out = await bulk({ threadIds: ['t1', 't2'], action: 'close' });
    expect(out.status).toBe(404);
    expect(mockCloseCases).not.toHaveBeenCalled();
  });

  it('acts on the threads that DO have cases, ignoring the ones that do not', async () => {
    mockFindCaseByThread.mockImplementation(async (t: string) => (t === 't2' ? { ...CASE, id: 'case-1' } : null));
    const out = await bulk({ threadIds: ['t1', 't2', 't3'], action: 'close' });
    expect(out.status).toBe(200);
    expect(mockCloseCases).toHaveBeenCalledWith(['case-1'], 'user-1');
    expect(out.body.data.requested).toBe(3);
  });
});

describe('PATCH /support/:id/satisfaction — the one write staff may NOT make', () => {
  const handler = getHandler('patch', '/support/:id/satisfaction');
  const rate = async (body: unknown, id = 'thread-1') => {
    const res = mockRes();
    await handler({ params: { id }, body }, res);
    return answered(res);
  };

  it('is NOT system-admin gated — a vendor-settable score is not a score', () => {
    // The asymmetry is the whole point of the route. Every other case write is
    // either staff-only or both-sided; this one is the customer's alone.
    expect(middlewareOf('patch', '/support/:id/satisfaction')).not.toContain('requireSystemAdmin');
  });

  it('records a rating with a comment', async () => {
    mockFindCaseByThread.mockResolvedValue({ ...CASE, status: 'closed' });
    const out = await rate({ satisfaction: 4, comment: '  sorted it, thanks  ' });
    expect(out.status).toBe(200);
    expect(mockRateCase).toHaveBeenCalledWith(CASE.id, 4, 'sorted it, thanks');
  });

  it('accepts a rating with no comment at all', async () => {
    mockFindCaseByThread.mockResolvedValue({ ...CASE, status: 'closed' });
    expect((await rate({ satisfaction: 5 })).status).toBe(200);
    expect(mockRateCase).toHaveBeenCalledWith(CASE.id, 5, null);
  });

  it('treats a whitespace-only comment as none', async () => {
    mockFindCaseByThread.mockResolvedValue({ ...CASE, status: 'closed' });
    await rate({ satisfaction: 3, comment: '   ' });
    expect(mockRateCase).toHaveBeenCalledWith(CASE.id, 3, null);
  });

  it('truncates an over-long comment rather than refusing the RATING', async () => {
    // The score is the thing worth keeping. Rejecting a 1-to-5 answer because
    // the prose attached to it ran long would lose the signal to protect a
    // column bound.
    mockFindCaseByThread.mockResolvedValue({ ...CASE, status: 'closed' });
    await rate({ satisfaction: 2, comment: 'x'.repeat(3000) });
    const [, , comment] = mockRateCase.mock.calls[0] as [string, number, string];
    expect(comment).toHaveLength(2000);
  });

  it('accepts only an integer 1 to 5', async () => {
    mockFindCaseByThread.mockResolvedValue({ ...CASE, status: 'closed' });
    for (const satisfaction of [0, 6, -1, 2.5, '4', null, undefined, NaN]) {
      expect((await rate({ satisfaction })).status).toBe(400);
    }
    expect(mockRateCase).not.toHaveBeenCalled();
  });

  it('rejects a non-string comment', async () => {
    mockFindCaseByThread.mockResolvedValue({ ...CASE, status: 'closed' });
    expect((await rate({ satisfaction: 4, comment: 7 })).status).toBe(400);
  });

  it('409s an OPEN case, naming the reason', async () => {
    // "Not closed yet" is the usual reason and is entirely the customer's to
    // fix by waiting, so it has to be said rather than returned as a 400.
    mockRateCase.mockResolvedValue(false);
    const out = await rate({ satisfaction: 4 });
    expect(out.status).toBe(409);
    expect(out.body.message).toMatch(/resolved or closed/i);
  });

  it('is OWN-ORG even for a staff caller — there is no staff variant', async () => {
    staff = true;
    identity = { orgId: 'system', userId: 'staff-1' };
    mockFindCaseByThread.mockResolvedValue({ ...CASE, orgId: 'tenant-9', status: 'closed' });
    expect((await rate({ satisfaction: 5 })).status).toBe(404);
    expect(mockRateCase).not.toHaveBeenCalled();
  });

  it('is NOT audited', async () => {
    // A 1-to-5 opinion on the customer's own case changes no entitlement, no
    // ownership and no clock. Putting it in the central trail would add noise
    // to a log read for authorization questions.
    mockFindCaseByThread.mockResolvedValue({ ...CASE, status: 'closed' });
    await rate({ satisfaction: 5 });
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it('requires a case id', async () => {
    const res = mockRes();
    await handler({ params: {}, body: { satisfaction: 4 } }, res);
    expect(answered(res).status).toBe(400);
  });
});

describe('the canned-reply library', () => {
  // SYSTEM-WIDE, not per-tenant: the vendor's own wording for recurring
  // questions, authored once and reused across every customer. The table
  // therefore has no `org_id` and RLS does not apply to it — which is precisely
  // why the READ is gated as hard as the writes. There is no tenancy boundary
  // underneath to fall back on.
  const call = async (method: 'get' | 'post' | 'patch' | 'delete', path: string, req: Record<string, unknown>) => {
    const res = mockRes();
    await getHandler(method, path)(req, res);
    return answered(res);
  };
  const create = (body: unknown) => call('post', '/support/canned', { params: {}, body });
  const edit = (id: string | undefined, body: unknown) =>
    call('patch', '/support/canned/:id', { params: id === undefined ? {} : { id }, body });

  it('gates ALL FOUR routes on system admin, the read included', () => {
    for (const [method, path] of [
      ['get', '/support/canned'],
      ['post', '/support/canned'],
      ['patch', '/support/canned/:id'],
      ['delete', '/support/canned/:id'],
    ] as const) {
      expect(middlewareOf(method, path)).toContain('requireSystemAdmin');
    }
  });

  it('lists templates', async () => {
    mockListCanned.mockResolvedValue([{ id: 't1', title: 'Key rotation', body: '…' }]);
    const out = await call('get', '/support/canned', { params: {} });
    expect(out.status).toBe(200);
    expect(out.body.data.responses).toHaveLength(1);
  });

  it('creates one, trimming both fields', async () => {
    const out = await create({ title: '  Key rotation  ', body: '  Rotate it like so  ' });
    expect(out.status).toBe(201);
    expect(mockCreateCanned).toHaveBeenCalledWith('Key rotation', 'Rotate it like so', 'user-1');
  });

  it('audits the TITLE but not the BODY', async () => {
    // The title identifies which template moved; the body is the thing a
    // reviewer reads in the template itself rather than in a trail.
    await create({ title: 'Key rotation', body: 'secret internal phrasing' });
    const entry = mockRecordAudit.mock.calls[0]![0] as { action: string; details: Record<string, unknown> };
    expect(entry.action).toBe('support.canned.write');
    expect(entry.details).toMatchObject({ title: 'Key rotation', created: true });
    expect(JSON.stringify(entry)).not.toMatch(/internal phrasing/);
  });

  it('rejects an empty or over-long title or body', async () => {
    for (const body of [
      { title: '', body: 'B' },
      { title: '   ', body: 'B' },
      { title: 'T', body: '' },
      { title: 'x'.repeat(201), body: 'B' },
      { title: 'T', body: 'x'.repeat(5001) },
      { title: 7, body: 'B' },
      {},
    ]) {
      expect((await create(body)).status).toBe(400);
    }
    expect(mockCreateCanned).not.toHaveBeenCalled();
  });

  it('edits only the fields given', async () => {
    const out = await edit('t1', { title: 'New title' });
    expect(out.status).toBe(200);
    expect(mockUpdateCanned).toHaveBeenCalledWith('t1', { title: 'New title' }, 'user-1');
    expect(mockRecordAudit.mock.calls[0]![0]).toMatchObject({ details: { fields: ['title'] } });
  });

  it('refuses an edit with nothing to change', async () => {
    const out = await edit('t1', {});
    expect(out.status).toBe(400);
    expect(out.body.message).toMatch(/Nothing to change/);
    expect(mockUpdateCanned).not.toHaveBeenCalled();
  });

  it('validates each field on an edit', async () => {
    for (const body of [{ title: '' }, { title: 'x'.repeat(201) }, { body: '  ' }, { body: 7 }]) {
      expect((await edit('t1', body)).status).toBe(400);
    }
  });

  it('404s a RETIRED template rather than resurrecting it', async () => {
    // From the caller's side it is simply not there to edit, and bringing one
    // back should be a deliberate new row rather than a side effect of fixing a
    // typo.
    mockUpdateCanned.mockResolvedValue(false);
    expect((await edit('t1', { body: 'x' })).status).toBe(404);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it('retires one SOFTLY and 404s a second attempt', async () => {
    const out = await call('delete', '/support/canned/:id', { params: { id: 't1' } });
    expect(out.status).toBe(200);
    expect(mockDeleteCanned).toHaveBeenCalledWith('t1', 'user-1');
    expect(mockRecordAudit.mock.calls[0]![0]).toMatchObject({ details: { retired: true } });

    jest.clearAllMocks();
    mockDeleteCanned.mockResolvedValue(false);
    expect((await call('delete', '/support/canned/:id', { params: { id: 't1' } })).status).toBe(404);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it('requires an id on edit and delete', async () => {
    expect((await edit(undefined, { title: 'T' })).status).toBe(400);
    expect((await call('delete', '/support/canned/:id', { params: {} })).status).toBe(400);
  });

  it('cannot be swallowed by a parameterised route', () => {
    // `/support/canned` is two segments, like `/support/bulk`. Same property,
    // same reason to assert it rather than the declaration order.
    const twoSegmentParam = router.stack
      .filter((l: any) => l.route?.methods?.get)
      .map((l: any) => l.route.path as string)
      .filter((p: string) => /^\/support\/:[^/]+$/.test(p));
    expect(twoSegmentParam).toEqual([]);
  });
});
