// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for sending an impersonation CHALLENGE.
 *
 * Delivery is in-app only, with no email fallback, so the property that matters
 * most is that a challenge nobody received is REPORTED — not left pending to
 * expire an hour later looking exactly like a refusal.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockSendConfirmed = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const mockUOFind = jest.fn<(...a: unknown[]) => unknown>();
const mockUserFindById = jest.fn<(...a: unknown[]) => unknown>();

jest.unstable_mockModule('../src/helpers/in-app-notify.js', () => ({
  sendInAppNotificationConfirmed: (...a: unknown[]) => mockSendConfirmed(...a),
}));
jest.unstable_mockModule('../src/models/index.js', () => ({
  UserOrganization: { find: (...a: unknown[]) => mockUOFind(...a) },
  User: { findById: (...a: unknown[]) => mockUserFindById(...a) },
}));

const {
  resolveChallengeRoute,
  sendImpersonationChallenge,
  CHALLENGE_SELF_APPROVAL_FORBIDDEN,
} = await import('../src/helpers/impersonation-challenge.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
const selectLean = (doc: unknown) => ({ select: () => ({ lean: () => Promise.resolve(doc) }) });
const base = { orgId: 'org-a', targetUserId: 'target', requesterId: 'sysadmin', reason: 'ticket #42' };

beforeEach(() => {
  jest.clearAllMocks();
  mockUserFindById.mockReturnValue(selectLean({ username: 'op-jane' }));
  mockSendConfirmed.mockResolvedValue(true);
});

describe('resolveChallengeRoute', () => {
  it('defaults to asking the impersonated user', () => {
    expect(resolveChallengeRoute(undefined, true)).toEqual({ ok: true, mode: 'user' });
  });

  it('REFUSES the user route when the org forbids self-approval — no silent reroute', () => {
    // Quietly widening to all admins would send an access request to people who
    // never expected it, and hide from the requester that their choice was
    // overridden.
    expect(resolveChallengeRoute('user', false)).toEqual({ ok: false, code: CHALLENGE_SELF_APPROVAL_FORBIDDEN });
    expect(resolveChallengeRoute(undefined, false)).toEqual({ ok: false, code: CHALLENGE_SELF_APPROVAL_FORBIDDEN });
  });

  it('allows the org_admin route regardless of self-approval', () => {
    expect(resolveChallengeRoute('org_admin', false)).toEqual({ ok: true, mode: 'org_admin' });
  });
});

describe('sendImpersonationChallenge', () => {
  it('under `user`, asks only the impersonated user', async () => {
    const out = await sendImpersonationChallenge({ ...base, mode: 'user' });

    expect(out).toEqual({ attempted: 1, delivered: 1 });
    expect(mockSendConfirmed).toHaveBeenCalledWith(expect.objectContaining({ recipientUserId: 'target' }));
    expect(mockUOFind).not.toHaveBeenCalled();
  });

  it('under `org_admin`, asks every active admin and owner of the pinned org', async () => {
    mockUOFind.mockReturnValue(selectLean([{ userId: 'admin-1' }, { userId: 'owner-1' }]));

    const out = await sendImpersonationChallenge({ ...base, mode: 'org_admin' });

    expect(out).toEqual({ attempted: 2, delivered: 2 });
    const query = mockUOFind.mock.calls[0]![0] as any;
    expect(query).toMatchObject({ organizationId: 'org-a', isActive: true });
    expect(query.role.$in).toEqual(expect.arrayContaining(['owner', 'admin']));
  });

  it('reports ZERO delivered when every notification fails', async () => {
    mockSendConfirmed.mockResolvedValue(false);

    // The caller must mark this undeliverable rather than leave it pending.
    await expect(sendImpersonationChallenge({ ...base, mode: 'user' })).resolves.toEqual({
      attempted: 1, delivered: 0,
    });
  });

  it('counts a partial delivery as delivered — one admin who saw it can answer', async () => {
    mockUOFind.mockReturnValue(selectLean([{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }]));
    mockSendConfirmed
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(sendImpersonationChallenge({ ...base, mode: 'org_admin' })).resolves.toEqual({
      attempted: 3, delivered: 1,
    });
  });

  it('reports zero attempted when the org has no admins to ask', async () => {
    mockUOFind.mockReturnValue(selectLean([]));

    await expect(sendImpersonationChallenge({ ...base, mode: 'org_admin' })).resolves.toEqual({
      attempted: 0, delivered: 0,
    });
    expect(mockSendConfirmed).not.toHaveBeenCalled();
  });

  it('tells the reader everything needed to decide — not a bare "click yes"', async () => {
    await sendImpersonationChallenge({ ...base, mode: 'user' });

    const { content } = mockSendConfirmed.mock.calls[0]![0] as { content: string };
    expect(content).toContain('op-jane'); // who is asking
    expect(content).toContain('ticket #42'); // why
    expect(content).toContain('15 minutes'); // for how long
    expect(content).toMatch(/view-only/i); // what they cannot do
    expect(content).toMatch(/end the session/i); // that it can be stopped
  });
});
