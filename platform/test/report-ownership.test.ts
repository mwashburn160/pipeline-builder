// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pausing a departing member's stakeholder reports, and telling the org's admins.
 *
 * The behaviour worth pinning is what happens when things go wrong, because this
 * runs off the side of a member-deactivation request:
 *
 *  - it NEVER throws, so an unreachable reporting service cannot fail the
 *    deactivation the admin asked for;
 *  - it notifies nobody when nothing was paused, so an ordinary deactivation is
 *    silent;
 *  - the notice names the reports and says what to do about them, because "a
 *    report was paused" with no name is not actionable.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const USER = 'user-lead';

const mockPost = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockHolders = jest.fn<(...a: unknown[]) => Promise<string[]>>();
const mockNotify = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockUserFindById = jest.fn<(...a: unknown[]) => unknown>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  InternalHttpClient: class {
    post(...args: unknown[]) { return mockPost(...args); }
  },
  getServiceAuthHeader: () => 'Bearer service-token',
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: { reporting: { serviceHost: 'reporting', servicePort: 3000, serviceTimeout: 5000 } },
}));

jest.unstable_mockModule('../src/services/ecosystem-notifications.js', () => ({
  holdersOfPermission: (...a: unknown[]) => mockHolders(...a),
}));

jest.unstable_mockModule('../src/helpers/in-app-notify.js', () => ({
  sendInAppNotification: (...a: unknown[]) => mockNotify(...a),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  User: {
    findById: (...args: unknown[]) => {
      const chain = { select: () => chain, lean: () => Promise.resolve(mockUserFindById(...args)) };
      return chain;
    },
  },
}));

const { pauseFormerMemberReports } = await import('../src/services/report-ownership.js');

const ok = (paused: unknown[]) => ({ statusCode: 200, body: { data: { paused } } });
const report = (over: Record<string, unknown> = {}) => ({
  id: 'def-1', name: 'Weekly delivery', cadence: 'weekly', ...over,
});

describe('pauseFormerMemberReports', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPost.mockResolvedValue(ok([]));
    mockHolders.mockResolvedValue(['admin-1', 'admin-2']);
    mockNotify.mockResolvedValue(undefined);
    mockUserFindById.mockReturnValue({ username: 'Dana Ng', email: 'dana@acme.test' });
  });

  it('asks reporting to pause, naming the org, the user and the reason', async () => {
    await pauseFormerMemberReports(ORG, USER);
    expect(mockPost).toHaveBeenCalledWith(
      `/reports/stakeholder-internal/owner-left/${ORG}/${USER}`,
      { reason: 'owner_inactive' },
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer service-token' }) }),
    );
  });

  it('carries the permission-loss reason when given one', async () => {
    await pauseFormerMemberReports(ORG, USER, 'permission_lost');
    expect(mockPost.mock.calls[0][1]).toEqual({ reason: 'permission_lost' });
  });

  /** An ordinary deactivation of someone who owned no reports must be silent. */
  it('notifies nobody when nothing was paused', async () => {
    await pauseFormerMemberReports(ORG, USER);
    expect(mockHolders).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    // And costs no extra reads for the name.
    expect(mockUserFindById).not.toHaveBeenCalled();
  });

  it('tells every org:settings holder which reports stopped and what to do', async () => {
    mockPost.mockResolvedValue(ok([report(), report({ id: 'def-2', name: 'Monthly health', cadence: 'monthly' })]));
    await pauseFormerMemberReports(ORG, USER);
    expect(mockHolders).toHaveBeenCalledWith(ORG, 'org:settings');
    expect(mockNotify).toHaveBeenCalledTimes(2);
    const [first] = mockNotify.mock.calls as any[];
    expect(first[0]).toMatchObject({ recipientOrgId: ORG, recipientUserId: 'admin-1' });
    expect(first[0].subject).toContain('2 scheduled reports');
    expect(first[0].content).toContain('Weekly delivery');
    expect(first[0].content).toContain('Monthly health');
    expect(first[0].content).toContain('Dana Ng');
    // The action, not just the fact.
    expect(first[0].content).toMatch(/Transfer it to someone/);
  });

  it('uses the singular when one report stopped', async () => {
    mockPost.mockResolvedValue(ok([report()]));
    await pauseFormerMemberReports(ORG, USER);
    expect((mockNotify.mock.calls[0] as any)[0].subject).toBe('A scheduled report has been paused');
  });

  it('falls back to the email, then to a neutral phrase, for the name', async () => {
    mockPost.mockResolvedValue(ok([report()]));
    mockUserFindById.mockReturnValue({ email: 'dana@acme.test' });
    await pauseFormerMemberReports(ORG, USER);
    expect((mockNotify.mock.calls[0] as any)[0].content).toContain('dana@acme.test');

    jest.clearAllMocks();
    mockPost.mockResolvedValue(ok([report()]));
    mockHolders.mockResolvedValue(['admin-1']);
    mockUserFindById.mockReturnValue(null);
    await pauseFormerMemberReports(ORG, USER);
    expect((mockNotify.mock.calls[0] as any)[0].content).toContain('A former member');
  });

  /**
   * NEVER THROWS. The membership change is what the admin asked for; the scheduler
   * re-checks every owner on every run, so a missed call here costs one cycle of
   * latency, not correctness.
   */
  it.each([
    ['reporting is unreachable', () => { mockPost.mockRejectedValue(new Error('ECONNREFUSED')); }],
    ['reporting answers 500', () => { mockPost.mockResolvedValue({ statusCode: 500, body: {} }); }],
    ['reporting answers 403', () => { mockPost.mockResolvedValue({ statusCode: 403, body: {} }); }],
    ['the notification fails', () => {
      mockPost.mockResolvedValue(ok([report()]));
      mockNotify.mockRejectedValue(new Error('message service down'));
    }],
    ['resolving the admins fails', () => {
      mockPost.mockResolvedValue(ok([report()]));
      mockHolders.mockRejectedValue(new Error('mongo down'));
    }],
  ])('does not throw when %s', async (_case, arrange) => {
    arrange();
    await expect(pauseFormerMemberReports(ORG, USER)).resolves.toBeUndefined();
  });

  it('tolerates a malformed body from reporting', async () => {
    mockPost.mockResolvedValue({ statusCode: 200, body: { data: { paused: 'not-a-list' } } });
    await expect(pauseFormerMemberReports(ORG, USER)).resolves.toBeUndefined();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('ignores entries that are not shaped like a report', async () => {
    mockPost.mockResolvedValue(ok([report(), null, { id: 'x' }, { name: 'y' }]));
    await pauseFormerMemberReports(ORG, USER);
    expect((mockNotify.mock.calls[0] as any)[0].content).toContain('Weekly delivery');
    expect((mockNotify.mock.calls[0] as any)[0].subject).toBe('A scheduled report has been paused');
  });

  it('says so in the log rather than failing when the org has no admin to tell', async () => {
    mockPost.mockResolvedValue(ok([report()]));
    mockHolders.mockResolvedValue([]);
    await expect(pauseFormerMemberReports(ORG, USER)).resolves.toBeUndefined();
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
