// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proactive 80% / 100% quota notices: which writes cross a threshold, the
 * insert-first dedupe, the account opt-out, and the `quota.threshold` webhook.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const emitCounter = jest.fn<AnyFn>();
const sendSystemNotification = jest.fn<AnyFn>();
const deliver = jest.fn<AnyFn>();
const relayPost = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  emitCounter,
  sendSystemNotification,
  createWebhookChannel: () => ({ channel: 'quota-webhook', deliver }),
  createSafeClient: () => ({ post: relayPost }),
  serviceEndpoint: () => ({ host: 'platform', port: 3000 }),
  getServiceAuthHeader: ({ serviceName, orgId }: { serviceName: string; orgId: string }) => `Bearer ${serviceName}@${orgId}`,
}));

const noticeCreate = jest.fn<AnyFn>();
const settingsFindOne = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/models/quota-notice.js', () => ({
  QUOTA_NOTICE_THRESHOLDS: [80, 100],
  QuotaNotice: { create: noticeCreate },
  QuotaNoticeSettings: { findOne: (...a: unknown[]) => ({ lean: () => settingsFindOne(...a) }) },
}));

const cfg = { quota: { thresholdNoticesEnabled: true } };
jest.unstable_mockModule('../src/config.js', () => ({ config: cfg }));

const { clearThresholdMemos, crossedThresholds, notifyThresholds, thresholdNoticeText, thresholdWebhookPayload } = await import('../src/services/threshold-notifier.js');

const RESET = '2026-11-05T00:00:00.000Z';
const base = { rootOrgId: 'root', quotaType: 'apiCalls' as const, limit: 100, resetAt: RESET };

beforeEach(() => {
  jest.clearAllMocks();
  clearThresholdMemos();
  cfg.quota.thresholdNoticesEnabled = true;
  noticeCreate.mockResolvedValue({});
  settingsFindOne.mockResolvedValue(null);
  sendSystemNotification.mockResolvedValue(true);
  deliver.mockResolvedValue({ ok: true, code: 200 });
  relayPost.mockResolvedValue({ statusCode: 200, body: { data: { ok: true } } });
});

describe('crossedThresholds', () => {
  it('reports only the lines a write moved across', () => {
    expect(crossedThresholds(100, 79, 1)).toEqual([]);
    expect(crossedThresholds(100, 80, 1)).toEqual([80]);
    expect(crossedThresholds(100, 81, 1)).toEqual([]); // already past 80 before this write
    expect(crossedThresholds(100, 100, 25)).toEqual([80, 100]);
  });

  it('a refusal (amount 0) at the limit reports 100 — and 80, which is claimed but superseded', () => {
    expect(crossedThresholds(100, 100, 0)).toEqual([80, 100]);
  });

  it('never notifies unlimited or zero limits', () => {
    expect(crossedThresholds(-1, 10_000, 1)).toEqual([]);
    expect(crossedThresholds(0, 1, 1)).toEqual([]);
  });
});

describe('notifyThresholds', () => {
  it('claims the dedupe row, then drops a notice in the ROOT org\'s inbox', async () => {
    await notifyThresholds({ ...base, used: 80, amount: 1 });

    expect(noticeCreate).toHaveBeenCalledWith({ rootOrgId: 'root', quotaType: 'apiCalls', periodResetAt: RESET, threshold: 80 });
    expect(sendSystemNotification).toHaveBeenCalledWith(expect.objectContaining({
      recipientOrgId: 'root', subject: 'API call quota at 80%', priority: 'normal',
    }));
    expect(emitCounter).toHaveBeenCalledWith('quota_threshold_notices_total', { type: 'apiCalls', threshold: '80', outcome: 'sent' });
  });

  it('a duplicate (another write already sent it) sends nothing', async () => {
    noticeCreate.mockRejectedValue(Object.assign(new Error('E11000'), { code: 11000 }));
    await notifyThresholds({ ...base, used: 80, amount: 1 });
    expect(sendSystemNotification).not.toHaveBeenCalled();
  });

  it('jumping past 100% sends ONE "reached" notice; the 80% line is claimed as superseded', async () => {
    await notifyThresholds({ ...base, used: 100, amount: 30 });
    expect(noticeCreate.mock.calls.map((c) => (c[0] as { threshold: number }).threshold)).toEqual([100, 80]);
    expect(sendSystemNotification).toHaveBeenCalledTimes(1);
    expect(sendSystemNotification).toHaveBeenCalledWith(expect.objectContaining({ subject: 'API call quota reached', priority: 'high' }));
    expect(emitCounter).toHaveBeenCalledWith('quota_threshold_notices_total', { type: 'apiCalls', threshold: '80', outcome: 'superseded' });
  });

  it('honours the account opt-out', async () => {
    settingsFindOne.mockResolvedValue({ orgId: 'root', enabled: false });
    await notifyThresholds({ ...base, used: 80, amount: 1 });
    expect(noticeCreate).not.toHaveBeenCalled();
    expect(sendSystemNotification).not.toHaveBeenCalled();
    expect(emitCounter).toHaveBeenCalledWith('quota_threshold_notices_total', { type: 'apiCalls', threshold: '80', outcome: 'opted_out' });
  });

  it('delivers the quota.threshold webhook when the account set one', async () => {
    settingsFindOne.mockResolvedValue({ orgId: 'root', enabled: true, webhookUrl: 'https://hooks.example.com/q' });
    await notifyThresholds({ ...base, used: 80, amount: 1 });
    const [msg, target] = deliver.mock.calls[0] as [{ payload: Record<string, unknown> }, { value: string }];
    expect(target.value).toBe('https://hooks.example.com/q');
    expect(msg.payload).toMatchObject({ event: 'quota.threshold', orgId: 'root', quotaType: 'apiCalls', threshold: 80, limit: 100, used: 80, upgradeUrl: '/dashboard/billing' });
    expect(emitCounter).toHaveBeenCalledWith('quota_threshold_webhooks_total', { type: 'apiCalls', outcome: 'delivered' });
  });

  it('counts a failed webhook delivery', async () => {
    settingsFindOne.mockResolvedValue({ orgId: 'root', enabled: true, webhookUrl: 'https://hooks.example.com/q' });
    deliver.mockResolvedValue({ ok: false, code: 500 });
    await notifyThresholds({ ...base, used: 80, amount: 1 });
    expect(emitCounter).toHaveBeenCalledWith('quota_threshold_webhooks_total', { type: 'apiCalls', outcome: 'failed' });
  });

  it('never throws: a store failure is counted and swallowed', async () => {
    settingsFindOne.mockRejectedValue(new Error('mongo down'));
    await expect(notifyThresholds({ ...base, used: 80, amount: 1 })).resolves.toBeUndefined();
    expect(emitCounter).toHaveBeenCalledWith('quota_threshold_notices_total', { type: 'apiCalls', threshold: 'any', outcome: 'failed' });
  });

  it('a non-duplicate insert failure is counted and swallowed too', async () => {
    noticeCreate.mockRejectedValue(new Error('write concern'));
    await notifyThresholds({ ...base, used: 80, amount: 1 });
    expect(sendSystemNotification).not.toHaveBeenCalled();
    expect(emitCounter).toHaveBeenCalledWith('quota_threshold_notices_total', { type: 'apiCalls', threshold: 'any', outcome: 'failed' });
  });

  it('is a no-op when switched off for the deploy, for storageBytes, or below every line', async () => {
    cfg.quota.thresholdNoticesEnabled = false;
    await notifyThresholds({ ...base, used: 80, amount: 1 });
    cfg.quota.thresholdNoticesEnabled = true;
    await notifyThresholds({ ...base, quotaType: 'storageBytes', used: 80, amount: 1 });
    await notifyThresholds({ ...base, used: 10, amount: 1 });
    expect(settingsFindOne).not.toHaveBeenCalled();
    expect(sendSystemNotification).not.toHaveBeenCalled();
  });

  it('records a failed inbox delivery', async () => {
    sendSystemNotification.mockResolvedValue(false);
    await notifyThresholds({ ...base, used: 80, amount: 1 });
    expect(emitCounter).toHaveBeenCalledWith('quota_threshold_notices_total', { type: 'apiCalls', threshold: '80', outcome: 'failed' });
  });
});

describe('notice text + payload', () => {
  it('names the reset date and where to act', () => {
    const t = thresholdNoticeText({ ...base, used: 80, amount: 1 }, 80);
    expect(t.content).toContain('resets on 2026-11-05');
    expect(t.content).toContain('/dashboard/billing');
    expect(thresholdNoticeText({ ...base, used: 100, amount: 0, resetAt: undefined }, 100).content).toContain('the end of the period');
    expect(thresholdWebhookPayload({ ...base, used: 1, amount: 1, resetAt: undefined }, 80).resetAt).toBeNull();
  });
});

describe('threshold email', () => {
  it('mails the notice through platform\'s relay as the quota service, scoped to the ROOT org', async () => {
    await notifyThresholds({ ...base, used: 80, amount: 1 });

    expect(relayPost).toHaveBeenCalledWith('/internal/notify-email', {
      quotaNotice: true,
      orgId: 'root',
      subject: 'API call quota at 80%',
      text: expect.stringContaining('/dashboard/quotas'),
    }, expect.objectContaining({ headers: { authorization: 'Bearer quota@root' } }));
    expect(emitCounter).toHaveBeenCalledWith('quota_threshold_emails_total', { type: 'apiCalls', threshold: '80', outcome: 'sent' });
  });

  it('counts a relay refusal or an unreachable relay as failed, without throwing', async () => {
    relayPost.mockResolvedValueOnce({ statusCode: 403 });
    await notifyThresholds({ ...base, used: 80, amount: 1 });
    expect(emitCounter).toHaveBeenCalledWith('quota_threshold_emails_total', { type: 'apiCalls', threshold: '80', outcome: 'failed' });

    relayPost.mockResolvedValueOnce(null);
    await notifyThresholds({ ...base, used: 100, amount: 20 });
    expect(emitCounter).toHaveBeenCalledWith('quota_threshold_emails_total', { type: 'apiCalls', threshold: '100', outcome: 'failed' });
  });

  it('sends no email when the account opted out', async () => {
    settingsFindOne.mockResolvedValue({ enabled: false });
    await notifyThresholds({ ...base, used: 80, amount: 1 });
    expect(relayPost).not.toHaveBeenCalled();
  });
});

describe('notifyThresholds — cheap at the cap', () => {
  it('an org pinned at its cap costs ONE settings read and ONE claim attempt per period, not one per refusal', async () => {
    noticeCreate.mockRejectedValue({ code: 11000 }); // already claimed by another replica
    for (let i = 0; i < 5; i++) await notifyThresholds({ ...base, used: 100, amount: 0 });
    expect(settingsFindOne).toHaveBeenCalledTimes(1);
    expect(noticeCreate).toHaveBeenCalledTimes(2); // 100 and 80, once each
    // A NEW period is a new notice.
    await notifyThresholds({ ...base, used: 100, amount: 0, resetAt: '2026-11-08T00:00:00.000Z' });
    expect(noticeCreate).toHaveBeenCalledTimes(4);
  });

  it('a notice this pod sent is not re-attempted for the period', async () => {
    await notifyThresholds({ ...base, used: 80, amount: 1 });
    await notifyThresholds({ ...base, used: 80, amount: 1 });
    expect(noticeCreate).toHaveBeenCalledTimes(1);
    expect(sendSystemNotification).toHaveBeenCalledTimes(1);
  });

  it('the automationCalls "reached" notice says automation keeps running through the grace band', () => {
    const text = thresholdNoticeText({ rootOrgId: 'r', quotaType: 'automationCalls', limit: 60_000, used: 60_000, amount: 1, resetAt: RESET }, 100);
    expect(text.content).toContain('grace band of up to 66,000 calls');
    expect(text.content).toContain('Automation Pack');
  });
});
