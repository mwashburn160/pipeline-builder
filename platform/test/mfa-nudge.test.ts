// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The PASSWORD-ONLY PROMPT's server half.
 *
 * The prompt exists because `MfaRequiredBanner` only fires on an org POLICY
 * deadline, so nobody outside an MFA-mandating org was ever asked to protect
 * their own account. What is deliberately NOT here is an "MFA enabled" flag:
 * protection is derived from the enrolled factors, and the only state this
 * feature owns is whether we are still asking.
 *
 * Worth pinning, in the order a reviewer would ask:
 *   - the snooze deadline is computed on the SERVER (a client-chosen date is a
 *     client-chosen "never");
 *   - "don't ask again" drops the snooze underneath it, so reversing the
 *     decline does not resurrect a stale deadline;
 *   - the profile reports the state ONLY for an account with no factor, and
 *     says nothing at all when the factors are unknown — never prompt on a
 *     guess;
 *   - an EXPIRED snooze reports as nothing, not as a past date;
 *   - all three routes are the caller's OWN account, and an anonymous caller
 *     gets 401 rather than a write against `undefined`.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (res: any, code: number, body: unknown) => res.status(code).json({ success: true, data: body }),
  sendError: (res: any, code: number, message: string, errorCode?: string) => res.status(code).json({ success: false, message, code: errorCode }),
}));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
const mockAudit = jest.fn();
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: mockAudit }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  User: { updateOne: (...a: unknown[]) => mockUpdateOne(...a) },
}));

const {
  SNOOZE_DAYS, clearMfaNudge, declineMfaNudge, mfaNudgeView, reportableMfaNudge, snoozeMfaNudge,
} = await import('../src/helpers/mfa-nudge.js');
const { declineMfaPrompt, resetMfaPrompt, snoozeMfaPrompt } = await import('../src/controllers/mfa-nudge.js');
// The enrolment side of it, which both enrolment controllers call.
const { clearMfaNudgeOnEnrolment } = await import('../src/services/mfa-enrolment.js');

function makeRes() {
  const r: any = { _status: 0, _body: undefined };
  r.status = (s: number) => { r._status = s; return r; };
  r.json = (b: unknown) => { r._body = b; return r; };
  return r;
}

const CALLER = { sub: 'u1', organizationId: 'org1' };
const req = (user: unknown = CALLER) => ({ user, params: {}, body: {} }) as any;

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
});

describe('mfaNudgeView — what the profile reports', () => {
  it('reports nothing for an account that was never prompted', () => {
    expect(mfaNudgeView(undefined)).toBeUndefined();
    expect(mfaNudgeView(null)).toBeUndefined();
    expect(mfaNudgeView({})).toBeUndefined();
  });

  it('reports a live snooze as an ISO deadline', () => {
    const until = new Date(Date.now() + 3 * DAY);
    expect(mfaNudgeView({ snoozedUntil: until })).toEqual({ snoozedUntil: until.toISOString() });
  });

  it('drops an EXPIRED snooze rather than reporting a past date', () => {
    // The client's only question is "is it suppressed right now"; a stale
    // deadline is one more thing for it to get wrong.
    expect(mfaNudgeView({ snoozedUntil: new Date(Date.now() - DAY) })).toBeUndefined();
  });

  it('reports a decline, which has no expiry', () => {
    const at = new Date('2026-01-02T03:04:05.000Z');
    expect(mfaNudgeView({ declinedAt: at })).toEqual({ declinedAt: at.toISOString() });
  });
});

describe('reportableMfaNudge — only for an account that needs the prompt', () => {
  const declined = { declinedAt: new Date('2026-01-02T03:04:05.000Z') };

  it('reports the state for a password-only account', () => {
    expect(reportableMfaNudge({ passkeyCount: 0, hasTotp: false }, declined))
      .toEqual({ declinedAt: declined.declinedAt.toISOString() });
  });

  it('says nothing once the account holds a passkey', () => {
    expect(reportableMfaNudge({ passkeyCount: 1, hasTotp: false }, declined)).toBeUndefined();
  });

  it('says nothing once the account holds an authenticator app', () => {
    expect(reportableMfaNudge({ passkeyCount: 0, hasTotp: true }, declined)).toBeUndefined();
  });

  it('says nothing when the factors are unknown — never prompt on a guess', () => {
    expect(reportableMfaNudge(undefined, declined)).toBeUndefined();
  });
});

describe('the writes', () => {
  it('computes the snooze deadline on the server, SNOOZE_DAYS out', async () => {
    const before = Date.now();
    const until = await snoozeMfaNudge('u1');
    expect(until.getTime()).toBeGreaterThanOrEqual(before + SNOOZE_DAYS * DAY);
    expect(mockUpdateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $set: { 'mfaNudge.snoozedUntil': until } });
  });

  it('a snooze never touches the decline', async () => {
    await snoozeMfaNudge('u1');
    expect(JSON.stringify(mockUpdateOne.mock.calls[0][1])).not.toContain('declinedAt');
  });

  it('a decline drops the snooze underneath it', async () => {
    // Otherwise reversing the decline would silently re-arm a stale deadline.
    await declineMfaNudge('u1');
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'u1' },
      { $set: { 'mfaNudge.declinedAt': expect.any(Date) }, $unset: { 'mfaNudge.snoozedUntil': '' } },
    );
  });

  it('clearing removes the whole subdocument — "never asked" and "cleared" look the same', async () => {
    await clearMfaNudge('u1');
    expect(mockUpdateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $unset: { mfaNudge: '' } });
  });

  it('enrolling a factor clears it, so removing that factor later prompts again', async () => {
    // The one call both enrolment controllers make (services/mfa-enrolment.ts,
    // "what enrolling a second factor ends"). Without it, a decline made while
    // password-only would outlive the factor it was traded for.
    await clearMfaNudgeOnEnrolment('u1');
    expect(mockUpdateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $unset: { mfaNudge: '' } });
  });
});

describe('the routes — own account, no permission, no step-up', () => {
  it('snoozes for the caller and reports the deadline it chose', async () => {
    const res = makeRes();
    await snoozeMfaPrompt(req(), res, jest.fn() as any);
    expect(res._status).toBe(200);
    expect(res._body.data.snoozeDays).toBe(SNOOZE_DAYS);
    expect(new Date(res._body.data.snoozedUntil).getTime()).toBeGreaterThan(Date.now());
    expect(mockUpdateOne.mock.calls[0][0]).toEqual({ _id: 'u1' });
    // A recurring UI preference: auditing it weekly would bury the decline.
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('records a decline, and audits it', async () => {
    const res = makeRes();
    await declineMfaPrompt(req(), res, jest.fn() as any);
    expect(res._status).toBe(200);
    expect(res._body.data.declinedAt).toEqual(expect.any(String));
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'user.mfa.prompt_declined', {
      targetType: 'user', targetId: 'u1',
    });
  });

  it('restores the prompt, and audits that too — "declined" must not read as permanent', async () => {
    const res = makeRes();
    await resetMfaPrompt(req(), res, jest.fn() as any);
    expect(res._status).toBe(200);
    expect(res._body.data).toEqual({ cleared: true });
    expect(mockUpdateOne).toHaveBeenCalledWith({ _id: 'u1' }, { $unset: { mfaNudge: '' } });
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'user.mfa.prompt_restored', {
      targetType: 'user', targetId: 'u1',
    });
  });

  it.each([
    ['snooze', snoozeMfaPrompt],
    ['decline', declineMfaPrompt],
    ['restore', resetMfaPrompt],
  ])('refuses an anonymous caller (%s) with 401 and writes nothing', async (_name, handler) => {
    const res = makeRes();
    await (handler as any)(req(null), res, jest.fn() as any);
    expect(res._status).toBe(401);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });
});
