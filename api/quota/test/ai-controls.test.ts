// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The account's optional AI controls on an aiCalls reservation: per-member
 * share (users only, pct × the account limit, from the ledger) and the
 * per-period token budget (platform-key tokens). Both OFF by default; a read
 * failure fails open.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const emitCounter = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ emitCounter }));

const findOne = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/models/quota-notice.js', () => ({
  QuotaNoticeSettings: { findOne: (...a: unknown[]) => ({ lean: () => findOne(...a) }) },
}));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ resolveRootOrgId: async (id: string) => (id === 'team-1' ? 'root' : id) }));
jest.unstable_mockModule('../src/config.js', () => ({ config: { quota: { resetDays: 3 } } }));
const aiTokensSince = jest.fn<AnyFn>();
const aiCallsByPrincipalSince = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/services/usage-ledger.js', () => ({ aiTokensSince, aiCallsByPrincipalSince }));

const { checkAiControls, clearAiControlsCache, invalidateAiControls } = await import('../src/services/ai-controls.js');

const resetAt = new Date('2099-01-04T00:00:00Z');
const svc = (limit = 100) => ({ getQuotaStatus: jest.fn<AnyFn>(async () => ({ limit, used: 0, remaining: limit, allowed: true, unlimited: limit === -1, resetAt })) });
const USER = { principalType: 'user' as const, principalId: 'u1' };

beforeEach(() => {
  jest.clearAllMocks();
  clearAiControlsCache();
  aiTokensSince.mockResolvedValue(0);
  aiCallsByPrincipalSince.mockResolvedValue(0);
});

describe('checkAiControls', () => {
  it('is a no-op (no status or ledger read) when the account set neither control', async () => {
    findOne.mockResolvedValue(null);
    const s = svc();
    await expect(checkAiControls(s as never, 'org-1', 1, USER)).resolves.toBeNull();
    expect(s.getQuotaStatus).not.toHaveBeenCalled();
    expect(aiCallsByPrincipalSince).not.toHaveBeenCalled();
  });

  it('per-member share: refuses past pct × the account limit, read across the ACCOUNT for this period', async () => {
    findOne.mockResolvedValue({ aiCallsPerMemberPct: 25, aiTokenBudget: null });
    aiCallsByPrincipalSince.mockResolvedValue(24);
    await expect(checkAiControls(svc(100) as never, 'team-1', 1, USER)).resolves.toBeNull();
    const denial = await checkAiControls(svc(100) as never, 'team-1', 2, USER);
    expect(denial).toMatchObject({ code: 'AI_MEMBER_SHARE_EXCEEDED', quota: { type: 'aiCalls', limit: 25, used: 24, remaining: 1 } });
    expect(denial!.message).toMatch(/your share of the organization's AI calls/i);
    // Read on the ROOT, from the start of the counter's period (resetAt − 3 days).
    expect(aiCallsByPrincipalSince).toHaveBeenCalledWith('root', 'u1', new Date('2099-01-01T00:00:00Z'));
  });

  it('per-member share never applies to a service account, an unlimited account, or an unattributed call', async () => {
    findOne.mockResolvedValue({ aiCallsPerMemberPct: 1, aiTokenBudget: null });
    aiCallsByPrincipalSince.mockResolvedValue(1_000);
    await expect(checkAiControls(svc(100) as never, 'org-1', 1, { principalType: 'service_account', principalId: 'sa' })).resolves.toBeNull();
    await expect(checkAiControls(svc(-1) as never, 'org-1', 1, USER)).resolves.toBeNull();
    await expect(checkAiControls(svc(100) as never, 'org-1', 1, undefined)).resolves.toBeNull();
  });

  it('a tiny share still allows one call (floor of 1)', async () => {
    findOne.mockResolvedValue({ aiCallsPerMemberPct: 1, aiTokenBudget: null });
    await expect(checkAiControls(svc(20) as never, 'org-1', 1, USER)).resolves.toBeNull();
    aiCallsByPrincipalSince.mockResolvedValue(1);
    await expect(checkAiControls(svc(20) as never, 'org-1', 1, USER)).resolves.toMatchObject({ code: 'AI_MEMBER_SHARE_EXCEEDED' });
  });

  it('token budget: refuses once the period\'s platform-key tokens reach it — for any principal', async () => {
    findOne.mockResolvedValue({ aiCallsPerMemberPct: null, aiTokenBudget: 10_000 });
    aiTokensSince.mockResolvedValue(9_999);
    await expect(checkAiControls(svc() as never, 'org-1', 1, { principalType: 'service_account', principalId: 'sa' })).resolves.toBeNull();
    aiTokensSince.mockResolvedValue(10_000);
    await expect(checkAiControls(svc() as never, 'org-1', 1, undefined)).resolves.toMatchObject({
      code: 'AI_TOKEN_BUDGET_EXCEEDED', quota: { limit: 10_000, used: 10_000, remaining: 0 },
    });
  });

  it('caches the settings, and a save invalidates them', async () => {
    findOne.mockResolvedValue({ aiCallsPerMemberPct: null, aiTokenBudget: null });
    await checkAiControls(svc() as never, 'org-1', 1, USER);
    await checkAiControls(svc() as never, 'org-1', 1, USER);
    expect(findOne).toHaveBeenCalledTimes(1);
    invalidateAiControls('org-1');
    await checkAiControls(svc() as never, 'org-1', 1, USER);
    expect(findOne).toHaveBeenCalledTimes(2);
  });

  it('fails OPEN (counted) when a read fails — the account cap is still enforced by the counter', async () => {
    findOne.mockRejectedValue(new Error('mongo down'));
    await expect(checkAiControls(svc() as never, 'org-1', 1, USER)).resolves.toBeNull();
    expect(emitCounter).toHaveBeenCalledWith('quota_ai_controls_fail_open_total', {});
  });
});
