// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * services/kms-config-verify.ts — the post-change verification pass that closes
 * the per-org KMS old-key window: a replica that missed the eviction broadcast
 * keeps encrypting under the OLD key until its cache TTL lapses, so TTL + margin
 * after the change every org secret is decrypted under the current config, and
 * any that will not open is reported (field names only), audited, counted and
 * sent to the org's admins to re-enter.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockLoggerError = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: (...a: unknown[]) => mockLoggerError(...a) }),
}));
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({}));

const mockOrgFind = jest.fn<AnyFn>();
const mockOrgFindById = jest.fn<AnyFn>();
const mockOrgUpdateOne = jest.fn<AnyFn>();
const mockMembersFind = jest.fn<AnyFn>();
const mockUsersFind = jest.fn<AnyFn>();
const chain = (v: unknown) => {
  const c: any = { select: () => c, sort: () => c, limit: () => c, lean: () => Promise.resolve(typeof v === 'function' ? (v as AnyFn)() : v) };
  return c;
};
jest.unstable_mockModule('../src/models/index.js', () => ({
  PersonalAccessToken: {},
  UserPreferences: {},
  Organization: {
    find: (...a: unknown[]) => mockOrgFind(...a),
    findById: (...a: unknown[]) => mockOrgFindById(...a),
    updateOne: (...a: unknown[]) => mockOrgUpdateOne(...a),
  },
  UserOrganization: { find: (...a: unknown[]) => mockMembersFind(...a) },
  User: { find: (...a: unknown[]) => mockUsersFind(...a) },
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));

const mockFindUnreadable = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/services/secret-reencrypt.js', () => ({
  findUnreadableOrgSecrets: (...a: unknown[]) => mockFindUnreadable(...a),
}));
const mockWrap = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/utils/secret-blob.js', () => ({ wrapEncrypted: (...a: unknown[]) => mockWrap(...a) }));
const mockAudit = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ recordAuditEvent: (...a: unknown[]) => mockAudit(...a) }));
const mockInc = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: (...a: unknown[]) => mockInc(...a) }));
const mockInApp = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/helpers/in-app-notify.js', () => ({ sendInAppNotification: (...a: unknown[]) => mockInApp(...a) }));
const mockEmail = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/utils/email.js', () => ({ emailService: { send: (...a: unknown[]) => mockEmail(...a) } }));

const { runDueKmsVerifications, kmsConfigVerifySweep } = await import('../src/services/kms-config-verify.js');
const { kmsVerifySchedule, KMS_VERIFY_DELAY_MS } = await import('../src/helpers/org-kms-config.js');
const { PER_ORG_KMS_CACHE_TTL_MS } = await import('@pipeline-builder/api-core');

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const DUE = new Date('2026-01-01T00:06:00Z');

/** A stateful marker store: updateOne applies the conditional claim / clear the way Mongo would. */
function marker(initial: Date | undefined) {
  let current = initial;
  mockOrgFind.mockImplementation(() => chain(() => (current && current.getTime() <= Date.now() ? [{ _id: ORG, kmsVerifyDueAt: current }] : [])));
  mockOrgUpdateOne.mockImplementation(async (filter: any, update: any) => {
    if (!current || filter.kmsVerifyDueAt?.getTime() !== current.getTime()) return { matchedCount: 0, modifiedCount: 0 };
    current = update.$set?.kmsVerifyDueAt ?? undefined;
    return { matchedCount: 1, modifiedCount: 1 };
  });
  return {
    get: () => current,
    /** A config change landing now (supersedes whatever is scheduled). */
    reschedule: (d: Date) => { current = d; },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWrap.mockResolvedValue('{"probe":true}');
  mockFindUnreadable.mockResolvedValue([]);
  mockOrgFindById.mockReturnValue(chain({ name: 'Acme' }));
  mockMembersFind.mockReturnValue(chain([{ userId: 'admin-1' }, { userId: 'owner-1' }]));
  mockUsersFind.mockReturnValue(chain([{ email: 'a@acme.io' }, { email: 'o@acme.io' }]));
  mockEmail.mockResolvedValue(true);
  mockInApp.mockResolvedValue(undefined);
});

describe('kmsVerifySchedule', () => {
  it('schedules the check one cache TTL plus a margin after the change', () => {
    expect(KMS_VERIFY_DELAY_MS).toBeGreaterThan(PER_ORG_KMS_CACHE_TTL_MS as number);
    expect(KMS_VERIFY_DELAY_MS).toBeLessThanOrEqual((PER_ORG_KMS_CACHE_TTL_MS as number) + 2 * 60_000);
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(kmsVerifySchedule(now)).toEqual({ kmsVerifyDueAt: new Date(now + KMS_VERIFY_DELAY_MS) });
  });
});

describe('runDueKmsVerifications', () => {
  it('does nothing when no org is due', async () => {
    marker(new Date(Date.now() + 60_000));
    await runDueKmsVerifications();
    expect(mockFindUnreadable).not.toHaveBeenCalled();
    expect(mockOrgUpdateOne).not.toHaveBeenCalled();
  });

  it('all secrets readable: clears the marker; no audit, counter or notice', async () => {
    const db = marker(DUE);
    const res = await runDueKmsVerifications();
    expect(res).toEqual({ verified: 1, unreadable: 0 });
    expect(mockFindUnreadable).toHaveBeenCalledWith(ORG);
    expect(db.get()).toBeUndefined();
    expect(mockAudit).not.toHaveBeenCalled();
    expect(mockInc).not.toHaveBeenCalled();
    expect(mockInApp).not.toHaveBeenCalled();
    expect(mockEmail).not.toHaveBeenCalled();
  });

  it('claims the org conditionally on the exact due value before verifying (one replica wins)', async () => {
    marker(DUE);
    await runDueKmsVerifications();
    const [filter, update] = mockOrgUpdateOne.mock.calls[0] as [any, any];
    expect(filter).toEqual({ _id: ORG, kmsVerifyDueAt: DUE });
    // The claim is a lease, not a delete: a crash mid-check leaves a marker that comes due again.
    expect(update.$set.kmsVerifyDueAt.getTime()).toBeGreaterThan(Date.now());
    expect(mockOrgUpdateOne.mock.invocationCallOrder[0]).toBeLessThan(mockFindUnreadable.mock.invocationCallOrder[0]);
  });

  it('a lost claim (another replica, or a newer change) verifies nothing', async () => {
    marker(DUE);
    mockOrgUpdateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
    const res = await runDueKmsVerifications();
    expect(res).toEqual({ verified: 0, unreadable: 0 });
    expect(mockFindUnreadable).not.toHaveBeenCalled();
  });

  it('two replicas sweeping at once: exactly one verifies', async () => {
    marker(DUE);
    await Promise.all([runDueKmsVerifications(), runDueKmsVerifications()]);
    expect(mockFindUnreadable).toHaveBeenCalledTimes(1);
  });

  it('unreadable secrets: field names only are audited as a failure, logged, counted and sent to the org admins', async () => {
    const db = marker(DUE);
    mockFindUnreadable.mockResolvedValue(['aiProviderKeys.openai', 'idpClientSecret']);
    const res = await runDueKmsVerifications();
    expect(res).toEqual({ verified: 1, unreadable: 2 });
    expect(db.get()).toBeUndefined();

    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][0]).toMatchObject({
      action: 'admin.org.kms-config.verify',
      affectedOrgId: ORG,
      targetType: 'org-kms-config',
      targetId: ORG,
      outcome: 'failure',
      details: { unreadableSecrets: ['aiProviderKeys.openai', 'idpClientSecret'] },
    });
    expect(mockLoggerError).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ orgId: ORG, fields: ['aiProviderKeys.openai', 'idpClientSecret'] }));
    expect(mockInc).toHaveBeenCalledWith('platform_kms_secret_verify_failed_total', { field: 'aiProviderKeys.openai' });
    expect(mockInc).toHaveBeenCalledWith('platform_kms_secret_verify_failed_total', { field: 'idpClientSecret' });

    // Targeted to each admin in-app, plus one email to all of them.
    expect(mockInApp).toHaveBeenCalledTimes(2);
    expect(mockInApp.mock.calls.map((c: any) => c[0].recipientUserId).sort()).toEqual(['admin-1', 'owner-1']);
    const notice = mockInApp.mock.calls[0][0] as { recipientOrgId: string; subject: string; content: string };
    expect(notice.recipientOrgId).toBe(ORG);
    expect(notice.content).toMatch(/openai/i);
    expect(notice.content).toMatch(/SSO|identity provider/i);
    expect(notice.content).toMatch(/re-enter/i);
    expect(mockEmail).toHaveBeenCalledWith(expect.objectContaining({ to: ['a@acme.io', 'o@acme.io'] }));
  });

  it('a second config change during the check supersedes it: no report, the newer check stays scheduled', async () => {
    const db = marker(DUE);
    const later = new Date(Date.now() + KMS_VERIFY_DELAY_MS);
    mockFindUnreadable.mockImplementation(async () => {
      db.reschedule(later);
      return ['aiProviderKeys.openai'];
    });
    const res = await runDueKmsVerifications();
    expect(res).toEqual({ verified: 0, unreadable: 0 });
    expect(db.get()).toEqual(later);
    expect(mockAudit).not.toHaveBeenCalled();
    expect(mockInc).not.toHaveBeenCalled();
    expect(mockInApp).not.toHaveBeenCalled();
  });

  it('a provider that cannot encrypt at all (KMS outage) is NOT reported as unreadable secrets: it throws and the check comes due again', async () => {
    const db = marker(DUE);
    mockWrap.mockRejectedValue(new Error('KMS Decrypt throttled'));
    await expect(runDueKmsVerifications()).rejects.toThrow(/throttled/);
    expect(mockFindUnreadable).not.toHaveBeenCalled();
    expect(db.get()).toBeDefined();
    expect(mockAudit).not.toHaveBeenCalled();
    expect(mockInApp).not.toHaveBeenCalled();
  });

  it('one org failing does not stop the others; the pass still throws so the sweep reads as failing', async () => {
    const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    mockOrgFind.mockReturnValue(chain([{ _id: ORG, kmsVerifyDueAt: DUE }, { _id: OTHER, kmsVerifyDueAt: DUE }]));
    mockOrgUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    mockFindUnreadable.mockImplementation(async (id: unknown) => {
      if (id === ORG) throw new Error('mongo blip');
      return [];
    });
    await expect(runDueKmsVerifications()).rejects.toThrow(/1 of 2/);
    expect(mockFindUnreadable).toHaveBeenCalledWith(OTHER);
  });
});

describe('kmsConfigVerifySweep', () => {
  it('runs under the leader lock, and is concurrency-safe (every org is claimed atomically)', () => {
    const def = kmsConfigVerifySweep();
    expect(def.name).toBe('kms-config-verify');
    expect(def.lockKey).toMatch(/kms-config-verify/);
    expect(def.concurrencySafe).toBe(true);
    expect(def.intervalMs).toBeLessThanOrEqual(60_000);
  });
});
