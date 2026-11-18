// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `QuotaService.purgeOrg`: the org-purge leg drops EVERY row quota keeps for
 * the org, not just the quota document. The notice settings (webhook URL, AI
 * controls) carry no TTL, so a purge that left them would keep a purged
 * tenant's configuration forever; the ledger and sent notices carry
 * principal-attributed rows.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

process.env.MONGODB_URI ||= 'mongodb://localhost:27017/quota-purge-test';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));

const orgDeleteOne = jest.fn<AnyFn>();
const eventDeleteMany = jest.fn<AnyFn>();
const bucketDeleteMany = jest.fn<AnyFn>();
const noticeDeleteMany = jest.fn<AnyFn>();
const settingsDeleteMany = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/models/organization.js', () => ({ Organization: { deleteOne: orgDeleteOne } }));
jest.unstable_mockModule('../src/models/usage-event.js', () => ({ UsageEvent: { deleteMany: eventDeleteMany } }));
jest.unstable_mockModule('../src/models/usage-bucket.js', () => ({ UsageBucket: { deleteMany: bucketDeleteMany } }));
jest.unstable_mockModule('../src/models/quota-notice.js', () => ({
  QuotaNotice: { deleteMany: noticeDeleteMany },
  QuotaNoticeSettings: { deleteMany: settingsDeleteMany },
}));

const { quotaService } = await import('../src/services/quota-service.js');

const ORG = '507f1f77bcf86cd799439011';

beforeEach(() => {
  jest.clearAllMocks();
  orgDeleteOne.mockResolvedValue({ deletedCount: 1 });
  eventDeleteMany.mockResolvedValue({ deletedCount: 4 });
  bucketDeleteMany.mockResolvedValue({ deletedCount: 7 });
  noticeDeleteMany.mockResolvedValue({ deletedCount: 2 });
  settingsDeleteMany.mockResolvedValue({ deletedCount: 1 });
});

describe('QuotaService.purgeOrg', () => {
  it('drops the quota document, notice settings, notices and usage ledger, keyed on the org', async () => {
    const tables = await quotaService.purgeOrg(ORG);

    for (const fn of [eventDeleteMany, bucketDeleteMany, noticeDeleteMany, settingsDeleteMany]) {
      expect(fn).toHaveBeenCalledWith({ orgId: ORG });
    }
    expect(orgDeleteOne).toHaveBeenCalledTimes(1);
    expect(tables).toEqual({
      organizations: 1, quotaNoticeSettings: 1, quotaNotices: 2, usageBuckets: 7, usageEvents: 4,
    });
  });

  it('keeps the quota document when a dependent delete fails, so the retry still finds the org', async () => {
    bucketDeleteMany.mockRejectedValue(new Error('mongo down'));
    await expect(quotaService.purgeOrg(ORG)).rejects.toThrow('mongo down');
    expect(orgDeleteOne).not.toHaveBeenCalled();
  });

  it('is idempotent: an already-purged org answers all zeroes', async () => {
    for (const fn of [orgDeleteOne, eventDeleteMany, bucketDeleteMany, noticeDeleteMany, settingsDeleteMany]) {
      fn.mockResolvedValue({ deletedCount: 0 });
    }
    expect(Object.values(await quotaService.purgeOrg(ORG)).every((n) => n === 0)).toBe(true);
  });
});
