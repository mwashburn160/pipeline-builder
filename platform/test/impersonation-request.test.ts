// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the impersonation request lifecycle.
 *
 * The invariant under test is that a token is only ever issued by REDEEMING an
 * approved request, and that an approval is single-use. Today every request
 * auto-approves (no consent policy exists), so these also pin the promise that
 * introducing the record changed no user-visible behaviour.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockCreate = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockUpdateMany = jest.fn();
const mockUpdateOne = jest.fn();
const mockFindById = jest.fn();
const mockCountDocuments = jest.fn();
const mockFind = jest.fn();
const mockUserFind = jest.fn();

jest.unstable_mockModule('../src/models/index.js', () => ({
  ImpersonationRequest: {
    create: (...a: unknown[]) => mockCreate(...a),
    findOneAndUpdate: (...a: unknown[]) => mockFindOneAndUpdate(...a),
    updateMany: (...a: unknown[]) => mockUpdateMany(...a),
    updateOne: (...a: unknown[]) => mockUpdateOne(...a),
    findById: (...a: unknown[]) => mockFindById(...a),
    countDocuments: (...a: unknown[]) => mockCountDocuments(...a),
    find: (...a: unknown[]) => mockFind(...a),
  },
  User: { find: (...a: unknown[]) => mockUserFind(...a) },
  IMPERSONATION_REQUEST_TTL_MS: 60 * 60 * 1000,
  IMPERSONATION_REASON_MAX: 500,
}));

const { impersonationService, decideInitialApproval, IMP_NOT_APPROVED, IMP_EXPIRED, IMP_ALREADY_DECIDED, IMP_NOT_LIVE, BREAKGLASS_CAP } = await import(
  '../src/services/impersonation-service.js'
);

/* eslint-disable @typescript-eslint/no-explicit-any */
const leanChain = (doc: unknown) => ({ lean: () => Promise.resolve(doc) });

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateMany.mockResolvedValue({});
  mockUpdateOne.mockResolvedValue({});
  mockCreate.mockImplementation(async (doc: any) => ({ ...doc, id: 'req-1' }));
  mockCountDocuments.mockResolvedValue(0);
});

describe('createRequest', () => {
  it('persists an approved decision with its reason', async () => {
    const doc = await impersonationService.createRequest({
      requesterId: 'sysadmin',
      targetUserId: 'target',
      orgId: 'org-a',
      decision: { kind: 'approved', reason: 'policy_open' },
    });

    expect(doc.status).toBe('approved');
    expect(doc.approvalReason).toBe('policy_open');
  });

  it('persists a pending decision with NO approval reason — nobody has said yes', async () => {
    const doc = await impersonationService.createRequest({
      requesterId: 'sysadmin',
      targetUserId: 'target',
      orgId: 'org-a',
      decision: { kind: 'pending' },
      approverMode: 'user',
      approverUserId: 'target',
    });

    expect(doc.status).toBe('pending');
    expect(doc.approvalReason).toBeUndefined();
    expect(doc.approverMode).toBe('user');
  });

  it('retires any superseded pending request instead of stacking a second one', async () => {
    await impersonationService.createRequest({ requesterId: 'sysadmin', targetUserId: 'target', decision: { kind: 'approved', reason: 'policy_open' } });

    // Consent fatigue is the cheapest attack on a consent gate: a requester must
    // not be able to accumulate live challenges against one person.
    expect(mockUpdateMany).toHaveBeenCalledWith(
      { requesterId: 'sysadmin', targetUserId: 'target', status: 'pending' },
      { $set: { status: 'expired' } },
    );
  });

  it('retires the old request BEFORE creating the new one', async () => {
    const order: string[] = [];
    mockUpdateMany.mockImplementation(async () => { order.push('supersede'); return {}; });
    mockCreate.mockImplementation(async (doc: any) => { order.push('create'); return { ...doc, id: 'req-1' }; });

    await impersonationService.createRequest({ requesterId: 'sysadmin', targetUserId: 'target', decision: { kind: 'approved', reason: 'policy_open' } });

    // Reversed, the new row would collide with the old one on the partial
    // unique index whenever a request is genuinely pending.
    expect(order).toEqual(['supersede', 'create']);
  });

  it('truncates an over-long operator reason', async () => {
    await impersonationService.createRequest({
      requesterId: 'sysadmin',
      targetUserId: 'target',
      reason: 'x'.repeat(900),
      decision: { kind: 'approved', reason: 'policy_open' },
    });
    expect((mockCreate.mock.calls[0]![0] as any).reason).toHaveLength(500);
  });

  it('sets an expiry an hour out', async () => {
    const before = Date.now();
    await impersonationService.createRequest({ requesterId: 'sysadmin', targetUserId: 'target', decision: { kind: 'approved', reason: 'policy_open' } });
    const expiresAt = (mockCreate.mock.calls[0]![0] as any).expiresAt as Date;

    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
  });
});

describe('consume', () => {
  it('redeems an approved request', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ _id: 'req-1', status: 'consumed' });

    await expect(impersonationService.consume('req-1', 'jti-1')).resolves.toEqual({ ok: true });
  });

  it('guards on status AND expiry in the same query', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ _id: 'req-1' });
    await impersonationService.consume('req-1', 'jti-1');

    // Both conditions must live in the filter. Read-then-write would let a
    // request lapse — or be redeemed elsewhere — between check and update.
    const filter = mockFindOneAndUpdate.mock.calls[0]![0] as any;
    expect(filter.status).toBe('approved');
    expect(filter.expiresAt).toHaveProperty('$gt');
  });

  it('refuses a second redemption of the same approval', async () => {
    // Already consumed → the status guard matches nothing.
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockFindById.mockReturnValue(leanChain({ status: 'consumed', expiresAt: new Date(Date.now() + 1000) }));

    await expect(impersonationService.consume('req-1', 'jti-1')).resolves.toEqual({
      ok: false, code: IMP_NOT_APPROVED,
    });
  });

  it('reports expiry distinctly and flips the row to expired', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockFindById.mockReturnValue(leanChain({ status: 'approved', expiresAt: new Date(Date.now() - 1000) }));

    await expect(impersonationService.consume('req-1', 'jti-1')).resolves.toEqual({
      ok: false, code: IMP_EXPIRED,
    });
    // "Too late" and "already used" are different operator-facing problems.
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'req-1', status: 'approved' },
      { $set: { status: 'expired' } },
    );
  });

  it('refuses a request that was denied', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockFindById.mockReturnValue(leanChain({ status: 'denied', expiresAt: new Date(Date.now() + 1000) }));

    await expect(impersonationService.consume('req-1', 'jti-1')).resolves.toEqual({
      ok: false, code: IMP_NOT_APPROVED,
    });
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });
});

describe('decide', () => {
  it('approves a pending request with reason "consent"', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ _id: 'req-1', status: 'approved' });

    const out = await impersonationService.decide('req-1', 'approver', true);
    expect(out).toEqual({ ok: true, request: { _id: 'req-1', status: 'approved' } });

    const update = mockFindOneAndUpdate.mock.calls[0]![1] as any;
    // The reason is what separates "someone said yes" from "nobody was asked".
    expect(update.$set.approvalReason).toBe('consent');
    expect(update.$set.decidedBy).toBe('approver');
  });

  it('denies without stamping an approval reason', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ _id: 'req-1', status: 'denied' });

    await impersonationService.decide('req-1', 'approver', false);

    const update = mockFindOneAndUpdate.mock.calls[0]![1] as any;
    expect(update.$set.status).toBe('denied');
    expect(update.$set).not.toHaveProperty('approvalReason');
  });

  it('refuses a second decision instead of overwriting the first', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockFindById.mockReturnValue(leanChain({ status: 'approved', expiresAt: new Date(Date.now() + 1000) }));

    // Under org_admin fan-out the challenge reaches every admin; the losers are
    // holding a live-looking prompt for a settled request.
    await expect(impersonationService.decide('req-1', 'second-admin', false)).resolves.toEqual({
      ok: false, code: IMP_ALREADY_DECIDED,
    });
  });

  it('reports an elapsed challenge window distinctly', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockFindById.mockReturnValue(leanChain({ status: 'pending', expiresAt: new Date(Date.now() - 1000) }));

    await expect(impersonationService.decide('req-1', 'approver', true)).resolves.toEqual({
      ok: false, code: IMP_EXPIRED,
    });
  });
});

describe('revoke', () => {
  it('ends a live session', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ _id: 'req-1', status: 'revoked' });

    await expect(impersonationService.revoke('req-1', 'the-user')).resolves.toEqual({
      ok: true, request: { _id: 'req-1', status: 'revoked' },
    });
    // Only a redeemed session can be ended — nothing else is running.
    expect((mockFindOneAndUpdate.mock.calls[0]![0] as any).status).toBe('consumed');
  });

  it('refuses to revoke a request that was never redeemed', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockFindById.mockReturnValue(leanChain({ status: 'approved' }));

    await expect(impersonationService.revoke('req-1', 'the-user')).resolves.toEqual({
      ok: false, code: IMP_NOT_LIVE,
    });
  });

  it('is idempotent-safe: a second revoke reports no live session', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockFindById.mockReturnValue(leanChain({ status: 'revoked' }));

    await expect(impersonationService.revoke('req-1', 'the-user')).resolves.toEqual({
      ok: false, code: IMP_NOT_LIVE,
    });
  });
});


describe('createBreakglassRequest', () => {
  const base = { requesterId: 'sysadmin', targetUserId: 'target', orgId: 'org-a', justification: 'INC-123 outage' };

  it('approves immediately under consent, recorded as breakglass', async () => {
    const out = await impersonationService.createBreakglassRequest({
      ...base, policy: { policy: 'consent', resolved: true },
    });

    expect(out.fourEyes).toBeNull();
    const created = mockCreate.mock.calls[0]![0] as any;
    expect(created).toMatchObject({ status: 'approved', approvalReason: 'breakglass', breakglass: true });
  });

  it('requires a SECOND sysadmin when the org has chosen denied', async () => {
    const out = await impersonationService.createBreakglassRequest({
      ...base, policy: { policy: 'denied', resolved: true },
    });

    expect(out.fourEyes).toBe('policy_denied');
    const created = mockCreate.mock.calls[0]![0] as any;
    expect(created.status).toBe('pending');
    // No reason yet — nobody has approved it.
    expect(created.approvalReason).toBeUndefined();
  });

  it('does NOT escalate on an UNRESOLVED denied — a DB blip must not become a lockout', async () => {
    // An unreadable parent resolves to strictest (`denied`) with resolved:false.
    // Four-eyes is justified by an org CHOOSING denied, not by our failing to read.
    const out = await impersonationService.createBreakglassRequest({
      ...base, policy: { policy: 'denied', resolved: false },
    });

    expect(out.fourEyes).toBeNull();
    expect((mockCreate.mock.calls[0]![0] as any).status).toBe('approved');
  });

  it('ESCALATES rather than refuses once the operator is over the cap', async () => {
    mockCountDocuments.mockResolvedValue(BREAKGLASS_CAP);

    const out = await impersonationService.createBreakglassRequest({
      ...base, policy: { policy: 'open', resolved: true },
    });

    // A hard stop would bite during exactly the incident break-glass exists for.
    expect(out.fourEyes).toBe('rate_limit');
    expect((mockCreate.mock.calls[0]![0] as any).status).toBe('pending');
  });

  it('stays immediate just under the cap', async () => {
    mockCountDocuments.mockResolvedValue(BREAKGLASS_CAP - 1);

    const out = await impersonationService.createBreakglassRequest({
      ...base, policy: { policy: 'consent', resolved: true },
    });
    expect(out.fourEyes).toBeNull();
    expect(out.recentCount).toBe(BREAKGLASS_CAP - 1);
  });

  it('counts only THIS operator\'s recent break-glass requests', async () => {
    await impersonationService.createBreakglassRequest({ ...base, policy: { policy: 'consent', resolved: true } });

    const filter = mockCountDocuments.mock.calls[0]![0] as any;
    expect(filter).toMatchObject({ requesterId: 'sysadmin', breakglass: true });
    expect(filter.createdAt).toHaveProperty('$gte');
  });
});

describe('decide — break-glass', () => {
  it('records a second sysadmin\'s approval as breakglass, not consent', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ _id: 'req-1', status: 'approved' });

    await impersonationService.decide('req-1', 'sysadmin-b', true, true);

    const update = mockFindOneAndUpdate.mock.calls[0]![1] as any;
    expect(update.$set.approvalReason).toBe('breakglass');
  });
});


describe('listForCaller — visibility mirrors decide/revoke authorization', () => {
  /** find(filter).sort().limit().select().lean() → rows; records select arg. */
  let selected: unknown;
  const rows = (docs: unknown[]) => mockFind.mockReturnValue({
    sort: () => ({ limit: () => ({ select: (sel: unknown) => { selected = sel; return { lean: () => Promise.resolve(docs) }; } }) }),
  });
  const filterOf = () => mockFind.mock.calls[0]![0] as any;
  const caller = (over: Partial<{ userId: string; isSysadmin: boolean; adminOrgIds: string[] }> = {}) =>
    ({ userId: 'me', isSysadmin: false, adminOrgIds: [], ...over });

  beforeEach(() => {
    selected = undefined;
    rows([]);
    mockUserFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
  });

  it('to-decide: a SYSADMIN gets NO view of consent requests — only break-glass', async () => {
    await impersonationService.listForCaller(caller({ isSysadmin: true }), 'to-decide');

    const branches = filterOf().$or as any[];
    // The only branch sysadmin status adds is break-glass. Consent visibility
    // comes solely from being the named approver or a tenant admin — the same
    // line that closed the self-approval bypass.
    const sysadminOnly = branches.filter((b) => b.breakglass === true);
    expect(sysadminOnly).toHaveLength(1);
    expect(branches.some((b) => b.breakglass?.$ne === true && !('approverUserId' in b) && !('orgId' in b))).toBe(false);
  });

  it('to-decide: never shows the caller their OWN request', async () => {
    await impersonationService.listForCaller(caller({ isSysadmin: true }), 'to-decide');
    expect(filterOf().requesterId).toEqual({ $ne: 'me' });
  });

  it('to-decide: an ordinary user sees only requests naming them', async () => {
    await impersonationService.listForCaller(caller(), 'to-decide');

    expect(filterOf().$or).toEqual([{ breakglass: { $ne: true }, approverUserId: 'me' }]);
    expect(filterOf().status).toBe('pending');
  });

  it('to-decide: a tenant admin also sees consent requests for their org subtree', async () => {
    await impersonationService.listForCaller(caller({ adminOrgIds: ['org-a', 'team-1'] }), 'to-decide');

    expect(filterOf().$or).toContainEqual({ breakglass: { $ne: true }, orgId: { $in: ['org-a', 'team-1'] } });
  });

  it('to-decide: hides requests whose window has already closed', async () => {
    await impersonationService.listForCaller(caller(), 'to-decide');
    expect(filterOf().expiresAt).toHaveProperty('$gt');
  });

  it('sessions: bounds "live" by the session TTL — no revoke button on a dead session', async () => {
    const before = Date.now();
    await impersonationService.listForCaller(caller(), 'sessions');

    const since = filterOf().consumedAt.$gte as Date;
    expect(filterOf().status).toBe('consumed');
    expect(since.getTime()).toBeGreaterThanOrEqual(before - 15 * 60 * 1000 - 50);
    expect(since.getTime()).toBeLessThanOrEqual(Date.now() - 15 * 60 * 1000 + 50);
  });

  it('sessions: an ordinary user sees only their own account and sessions they opened', async () => {
    await impersonationService.listForCaller(caller(), 'sessions');
    expect(filterOf().$or).toEqual([{ targetUserId: 'me' }, { requesterId: 'me' }]);
  });

  it('sessions: a sysadmin sees every live session, matching revoke authority', async () => {
    await impersonationService.listForCaller(caller({ isSysadmin: true }), 'sessions');
    expect(filterOf()).not.toHaveProperty('$or');
  });

  it('mine: only requests the caller opened', async () => {
    await impersonationService.listForCaller(caller(), 'mine');
    expect(filterOf()).toEqual({ requesterId: 'me' });
  });

  it('never returns the session token id', async () => {
    await impersonationService.listForCaller(caller(), 'mine');
    expect(selected).toBe('-jti');
  });

  it('resolves display names in one batch', async () => {
    rows([{ _id: 'r1', status: 'pending', requesterId: 'op', targetUserId: 'u', createdAt: new Date(), expiresAt: new Date() }]);
    mockUserFind.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve([
          { _id: 'op', username: 'op-jane' }, { _id: 'u', email: 'u@x.com' },
        ]),
      }),
    });

    const [row] = await impersonationService.listForCaller(caller(), 'mine');

    expect(row!.requester.name).toBe('op-jane');
    expect(row!.target.name).toBe('u@x.com'); // falls back to email
    expect(mockUserFind).toHaveBeenCalledTimes(1);
  });
});


describe('decideInitialApproval — the consent decision', () => {
  const p = (policy: 'open' | 'consent' | 'denied') => ({ policy });

  it('open → approved, recording that nobody was asked', () => {
    expect(decideInitialApproval({ ancestorAuthority: false, policy: p('open') }))
      .toEqual({ kind: 'approved', reason: 'policy_open' });
  });

  it('consent → pending', () => {
    expect(decideInitialApproval({ ancestorAuthority: false, policy: p('consent') })).toEqual({ kind: 'pending' });
  });

  it('denied → refused; only emergency access remains', () => {
    expect(decideInitialApproval({ ancestorAuthority: false, policy: p('denied') })).toEqual({ kind: 'refused' });
  });

  it('an ancestor-org admin is approved regardless of policy — informed, not asked', () => {
    for (const policy of ['open', 'consent', 'denied'] as const) {
      expect(decideInitialApproval({ ancestorAuthority: true, policy: p(policy) }))
        .toEqual({ kind: 'approved', reason: 'ancestor_authority' });
    }
  });

  it('a missing policy fails toward ASKING, never toward open access', () => {
    expect(decideInitialApproval({ ancestorAuthority: false, policy: undefined })).toEqual({ kind: 'pending' });
  });

  it('an unrecognised policy fails toward asking', () => {
    expect(decideInitialApproval({ ancestorAuthority: false, policy: { policy: 'wide-open' as never } })).toEqual({ kind: 'pending' });
  });
});
