// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugin-ecosystem notification contract: the event table's
 * transactional/opt-out split, the recipient-rule parser shared by sender and
 * relay, digest timing, the N23 template, and the relay client.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockPost = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../src/services/http-client.js', () => ({
  createSafeClient: () => ({ post: mockPost, get: jest.fn(), put: jest.fn(), delete: jest.fn() }),
}));
const mockEmit = jest.fn();
jest.unstable_mockModule('../src/utils/metric-emitter.js', () => ({ emitCounter: mockEmit }));
jest.unstable_mockModule('../src/middleware/service-tokens.js', () => ({
  getServiceAuthHeader: jest.fn((opts: { serviceName: string; orgId: string }) => `Bearer svc-${opts.serviceName}-${opts.orgId}`),
}));

const {
  ECOSYSTEM_EMAIL_PREFERENCE_FIELD_NAMES,
  ECOSYSTEM_NOTIFICATION_EVENTS,
  isEcosystemNotificationEvent,
  nextEcosystemDigestTime,
  parseEcosystemNotifyRequest,
  renderEcosystemDigest,
  renderEcosystemManagerChange,
} = await import('../src/types/ecosystem-notifications.js');
const { createEcosystemNotifyClient, ECOSYSTEM_NOTIFY_PATH } = await import('../src/services/ecosystem-notify-client.js');

const base = { event: 'N23', subject: 'S', text: 'T', recipients: [{ kind: 'superadmins' }] };

describe('ECOSYSTEM_NOTIFICATION_EVENTS', () => {
  it('covers N1..N31 exactly', () => {
    expect(Object.keys(ECOSYSTEM_NOTIFICATION_EVENTS)).toEqual(Array.from({ length: 31 }, (_, i) => `N${i + 1}`));
    expect(isEcosystemNotificationEvent('N31')).toBe(true);
    expect(isEcosystemNotificationEvent('N32')).toBe(false);
    expect(isEcosystemNotificationEvent('toString')).toBe(false);
  });

  it('makes the notification transactional and security notices non-optional', () => {
    for (const n of ['N1', 'N3', 'N4', 'N5', 'N7', 'N8', 'N9', 'N10', 'N18', 'N19', 'N20', 'N21', 'N22', 'N23', 'N25', 'N28', 'N29', 'N30', 'N31'] as const) {
      expect([n, ECOSYSTEM_NOTIFICATION_EVENTS[n].preference]).toEqual([n, null]);
    }
  });

  it('batches the digest events on their cadences', () => {
    expect(ECOSYSTEM_NOTIFICATION_EVENTS.N2.digest).toBe('daily');
    expect(ECOSYSTEM_NOTIFICATION_EVENTS.N24.digest).toBe('daily');
    expect(ECOSYSTEM_NOTIFICATION_EVENTS.N13.digest).toBe('weekly');
    expect(ECOSYSTEM_NOTIFICATION_EVENTS.N15.digest).toBe('hourly');
  });

  it('exposes the four stored preference fields', () => {
    expect([...ECOSYSTEM_EMAIL_PREFERENCE_FIELD_NAMES].sort()).toEqual(['installsEmail', 'moderationDigestEmail', 'reviewsEmail', 'upgradesEmail']);
  });
});

describe('parseEcosystemNotifyRequest', () => {
  it('accepts and normalizes every recipient rule', () => {
    const parsed = parseEcosystemNotifyRequest({
      event: 'N8',
      subject: ' Suspended ',
      text: ' body ',
      channels: ['email', 'email'],
      mandatory: true,
      recipients: [
        { kind: 'user', userId: 'u1', orgId: 'o1' },
        { kind: 'org_permission', orgId: 'o2', permission: 'publishers:manage', inheritFromRoot: true },
        { kind: 'moderators', permission: 'plugins:moderate', excludeMembersOfOrgId: 'o2', excludeUserIds: ['u9'] },
        { kind: 'superadmins' },
      ],
    });
    expect(parsed).toEqual({
      event: 'N8',
      subject: 'Suspended',
      text: 'body',
      channels: ['email'],
      mandatory: true,
      recipients: [
        { kind: 'user', userId: 'u1', orgId: 'o1' },
        { kind: 'org_permission', orgId: 'o2', permission: 'publishers:manage', inheritFromRoot: true },
        { kind: 'moderators', permission: 'plugins:moderate', excludeMembersOfOrgId: 'o2', excludeUserIds: ['u9'] },
        { kind: 'superadmins' },
      ],
    });
  });

  it.each([
    [{ ...base, event: 'N99' }, /event/],
    [{ ...base, subject: '' }, /subject/],
    [{ ...base, text: 'x'.repeat(10001) }, /text/],
    [{ ...base, recipients: [] }, /non-empty/],
    [{ ...base, recipients: Array.from({ length: 51 }, () => ({ kind: 'superadmins' })) }, /at most/],
    [{ ...base, recipients: ['x'] }, /object/],
    [{ ...base, recipients: [{ kind: 'nope' }] }, /unknown/],
    [{ ...base, recipients: [{ kind: 'user' }] }, /userId/],
    [{ ...base, recipients: [{ kind: 'user', userId: 'u', orgId: 5 }] }, /orgId/],
    [{ ...base, recipients: [{ kind: 'org_permission', permission: 'publishers:manage' }] }, /orgId/],
    // A tenant-org rule can never name a governance permission (or anything else).
    [{ ...base, recipients: [{ kind: 'org_permission', orgId: 'o', permission: 'plugins:moderate' }] }, /unsupported/],
    [{ ...base, recipients: [{ kind: 'moderators', permission: 'members:manage' }] }, /unsupported/],
    [{ ...base, recipients: [{ kind: 'org_members', userIds: ['u'] }] }, /orgId/],
    [{ ...base, recipients: [{ kind: 'org_members', orgId: 'o', userIds: [] }] }, /userIds/],
    [{ ...base, recipients: [{ kind: 'org_members', orgId: 'o', userIds: [3] }] }, /userIds/],
    [{ ...base, recipients: [{ kind: 'org_members', orgId: 'o', userIds: Array.from({ length: 101 }, (_, i) => `u${i}`) }] }, /at most 100/],
    [{ ...base, recipients: [{ kind: 'moderators', permission: 'plugins:moderate', excludeMembersOfOrgId: 3 }] }, /excludeMembersOfOrgId/],
    [{ ...base, recipients: [{ kind: 'moderators', permission: 'plugins:moderate', excludeUserIds: [1] }] }, /excludeUserIds/],
    // A raw address only for the anonymous-submitter notices.
    [{ ...base, recipients: [{ kind: 'address', email: 'a@b.co' }] }, /only allowed/],
    [{ ...base, event: 'N1', recipients: [{ kind: 'address', email: 'nope' }] }, /valid email/],
    [{ ...base, channels: [] }, /channels/],
    [{ ...base, event: 'N22', channels: ['in_app'] }, /not delivered on: in_app/],
    [{ ...base, mandatory: 'yes' }, /mandatory/],
    [null, /object/],
  ])('rejects %#', (body, message) => {
    const result = parseEcosystemNotifyRequest(body);
    expect(typeof result).toBe('string');
    expect(result).toMatch(message);
  });

  it('allows the verified external security address on N30/N31 only', () => {
    for (const event of ['N30', 'N31']) {
      expect(parseEcosystemNotifyRequest({ ...base, event, recipients: [{ kind: 'address', email: 'Sec@Example.com' }] }))
        .toMatchObject({ recipients: [{ kind: 'address', email: 'sec@example.com' }] });
    }
    expect(parseEcosystemNotifyRequest({ ...base, event: 'N20', recipients: [{ kind: 'address', email: 'sec@example.com' }] })).toMatch(/only allowed/);
  });

  it('accepts plugins:write writers and deduplicated org members', () => {
    expect(parseEcosystemNotifyRequest({
      ...base,
      event: 'N30',
      recipients: [
        { kind: 'org_permission', orgId: 'o', permission: 'plugins:write' },
        { kind: 'org_members', orgId: 'o', userIds: ['u1', 'u1', 'u2'] },
      ],
    })).toMatchObject({
      recipients: [
        { kind: 'org_permission', orgId: 'o', permission: 'plugins:write' },
        { kind: 'org_members', orgId: 'o', userIds: ['u1', 'u2'] },
      ],
    });
  });

  it('allows a submitter address on N1/N3/N4 and lowercases it', () => {
    expect(parseEcosystemNotifyRequest({ ...base, event: 'N3', recipients: [{ kind: 'address', email: 'Dev@Example.COM' }] }))
      .toMatchObject({ recipients: [{ kind: 'address', email: 'dev@example.com' }] });
  });
});

describe('nextEcosystemDigestTime', () => {
  const at = (iso: string) => new Date(iso);
  it('hourly → next top of the hour', () => {
    expect(nextEcosystemDigestTime('hourly', at('2026-09-21T10:15:00Z')).toISOString()).toBe('2026-09-21T11:00:00.000Z');
    expect(nextEcosystemDigestTime('hourly', at('2026-09-21T10:00:00Z')).toISOString()).toBe('2026-09-21T11:00:00.000Z');
  });
  it('daily → next 09:00 UTC', () => {
    expect(nextEcosystemDigestTime('daily', at('2026-09-21T08:59:00Z')).toISOString()).toBe('2026-09-21T09:00:00.000Z');
    expect(nextEcosystemDigestTime('daily', at('2026-09-21T09:00:00Z')).toISOString()).toBe('2026-09-22T09:00:00.000Z');
  });
  it('weekly → next Monday 09:00 UTC', () => {
    // 2026-09-21 is a Monday.
    expect(nextEcosystemDigestTime('weekly', at('2026-09-21T08:00:00Z')).toISOString()).toBe('2026-09-21T09:00:00.000Z');
    expect(nextEcosystemDigestTime('weekly', at('2026-09-21T10:00:00Z')).toISOString()).toBe('2026-09-28T09:00:00.000Z');
  });
  it('defaults to now', () => {
    expect(nextEcosystemDigestTime('hourly').getTime()).toBeGreaterThan(Date.now());
  });
});

describe('templates', () => {
  it('renders N23 for an add and a removal', () => {
    const added = renderEcosystemManagerChange({ user: 'ann@x.io', added: true, actor: 'root@x.io' });
    expect(added.subject).toBe('ann@x.io was added to the Ecosystem Manager role');
    expect(added.text).toContain('by root@x.io');
    expect(added.text).toContain('two-factor');
    const removed = renderEcosystemManagerChange({ user: 'ann@x.io', added: false });
    expect(removed.subject).toContain('removed from');
    expect(removed.text).toContain('can no longer');
  });

  it('coalesces a digest, and passes a single item through untouched', () => {
    const one = { subject: 'a', text: 'b' };
    expect(renderEcosystemDigest('N24', [one])).toBe(one);
    const d = renderEcosystemDigest('N24', [{ subject: 'first', text: '' }, { subject: 'second', text: '' }]);
    expect(d.subject).toBe('Daily digest: 2 × Publish request submitted');
    expect(d.text).toBe('• first\n• second');
    expect(renderEcosystemDigest('N15', [one, one]).subject).toMatch(/^Hourly/);
    expect(renderEcosystemDigest('N13', [one, one]).subject).toMatch(/^Weekly/);
  });
});

describe('createEcosystemNotifyClient', () => {
  beforeEach(() => { mockPost.mockReset(); mockEmit.mockReset(); });
  const client = createEcosystemNotifyClient({ serviceName: 'plugin', host: 'platform', port: 3000 });

  it('posts the validated request with a system-org service token', async () => {
    mockPost.mockResolvedValue({ statusCode: 200, body: { data: { recipientCount: 3 } }, headers: {} });
    await expect(client.send(base as never)).resolves.toEqual({ ok: true, status: 200, recipientCount: 3 });
    expect(mockPost).toHaveBeenCalledWith(ECOSYSTEM_NOTIFY_PATH, expect.objectContaining({ event: 'N23' }), {
      headers: { Authorization: 'Bearer svc-plugin-000000000000000000000001' },
    });
  });

  it('reports a non-2xx and counts the failure', async () => {
    mockPost.mockResolvedValue({ statusCode: 503, body: {}, headers: {} });
    await expect(client.send(base as never)).resolves.toEqual({ ok: false, status: 503 });
    expect(mockEmit).toHaveBeenCalledWith('ecosystem_notification_failed_total', { event: 'N23' });
  });

  it('reports an unreachable platform', async () => {
    mockPost.mockResolvedValue(null);
    await expect(client.send(base as never)).resolves.toEqual({ ok: false });
    mockPost.mockRejectedValue(new Error('boom'));
    await expect(client.send(base as never)).resolves.toEqual({ ok: false });
  });

  it('succeeds without a recipient count in the body', async () => {
    mockPost.mockResolvedValue({ statusCode: 201, body: undefined, headers: {} });
    await expect(client.send(base as never)).resolves.toEqual({ ok: true, status: 201 });
  });

  it('throws on an invalid request (a programming error, never retried)', async () => {
    await expect(client.send({ ...base, event: 'N0' } as never)).rejects.toThrow(/Invalid ecosystem notification/);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('defaults host/port from the environment', () => {
    expect(createEcosystemNotifyClient({ serviceName: 'plugin' })).toHaveProperty('send');
  });
});
