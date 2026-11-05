// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /quotas/internal/:orgId/profile` — the read the expansion-offers profile
 * is built from (docs/plans/sales-agent.md Phase 0).
 *
 * The assertions are about the three things a caller cannot recover if this gets
 * them wrong:
 *
 *  - **`ratio: null` for an unlimited cap.** A zero would read as "no pressure"
 *    on exactly the dimension that cannot have any, and the rules compare
 *    ratios — so a zero there is a silent, permanent suppression.
 *  - **the two CONSENT switches, both opt-OUT.** They ride this read rather than
 *    a second route precisely so the AND cannot be evaluated against two
 *    different fetches; an absent settings row must read as BOTH on.
 *  - **`rootOrgId`**, so the caller never resolves the hierarchy itself and a
 *    pooled team's profile is filed under the account that pays.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSendSuccess = jest.fn<AnyFn>();
const mockSendError = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: mockSendSuccess,
  sendError: mockSendError,
  requireAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireInternalService: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getParam: (params: Record<string, string>, key: string) => params[key],
  VALID_QUOTA_TYPES: ['plugins', 'pipelines', 'apiCalls'],
  isValidQuotaType: (t: string) => ['plugins', 'pipelines', 'apiCalls'].includes(t),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: AnyFn) => async (req: Record<string, unknown>, res: unknown) =>
    handler({ req, res, ctx: { log: jest.fn<AnyFn>() }, orgId: 'acct-1', userId: 'svc' }),
}));

jest.unstable_mockModule('../src/middleware/authorize-org.js', () => ({
  authorizeOrg: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireInternalCaller: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const mockSettingsFindOne = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/models/quota-notice.js', () => ({
  QuotaNoticeSettings: { findOne: mockSettingsFindOne },
  QuotaNotice: { create: jest.fn<AnyFn>() },
}));

jest.unstable_mockModule('../src/config.js', () => ({
  config: { quota: { defaults: {}, resetDays: 3 } },
}));

const { createReadQuotaRoutes } = await import('../src/routes/read-quotas.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The settings read is `.findOne(...).select(...).lean()`. */
function settings(row: unknown) {
  mockSettingsFindOne.mockReturnValue({ select: () => ({ lean: async () => row, catch: () => row }) });
}
/** …and a read that BLOWS UP, which the route swallows into "no preference". */
function settingsFailure() {
  mockSettingsFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.reject(new Error('down')) }) });
}

const RESET = '2026-12-01T00:00:00.000Z';

function quota(over: Record<string, unknown> = {}) {
  return {
    orgId: 'acct-1',
    tier: 'pro',
    periodDays: 3,
    quotas: {
      pipelines: { used: 9, limit: 10, resetAt: RESET, periodDays: 3 },
      // UNLIMITED: the case whose ratio must be null, not zero.
      apiCalls: { used: 5_000, limit: -1, resetAt: RESET, periodDays: 3 },
    },
    ...over,
  };
}

function router(q: Record<string, unknown>) {
  return createReadQuotaRoutes({ findByOrgId: async () => q } as any);
}

function handlerOf(r: any) {
  const layer = r.stack.find((l: any) => l.route?.path === '/internal/:orgId/profile' && l.route?.methods.get);
  if (!layer) throw new Error('no profile route');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

const call = (r: any) => handlerOf(r)({ params: { orgId: 'acct-1' }, query: {}, headers: {}, user: {} }, {});
const body = () => mockSendSuccess.mock.calls[0]![2] as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(() => {
  jest.clearAllMocks();
  settings(null);
});

describe('the usage-profile read', () => {
  it('reports a ratio for a finite cap and NULL for an unlimited one', async () => {
    await call(router(quota()));
    const { profile } = body();
    expect(profile.dimensions.pipelines.ratio).toBeCloseTo(0.9);
    expect(profile.dimensions.apiCalls.ratio).toBeNull();
  });

  it('carries the raw figures the copy needs, not only the ratio', async () => {
    await call(router(quota()));
    expect(body().profile.dimensions.pipelines).toMatchObject({ used: 9, limit: 10 });
  });

  it('projects the trajectory HERE, so no caller recomputes it', async () => {
    await call(router(quota()));
    // Whether it projects a number or null depends on the clock; what matters is
    // that the field is present, because a caller that had to compute it would
    // be the second answer the dashboard disagrees with.
    expect(body().profile.dimensions.pipelines).toHaveProperty('projected');
  });

  it('puts resetAt on the wire as ISO', async () => {
    await call(router(quota()));
    expect(body().profile.dimensions.pipelines.resetAt).toBe(RESET);
  });

  it('falls back to the ORG period when a dimension has none', async () => {
    await call(router(quota({
      quotas: { pipelines: { used: 1, limit: 10, resetAt: RESET } },
    })));
    expect(body().profile.dimensions.pipelines.periodDays).toBe(3);
  });

  it('reports no period rather than a wrong one when neither has it', async () => {
    await call(router(quota({
      periodDays: undefined,
      quotas: { pipelines: { used: 1, limit: 10, resetAt: RESET } },
    })));
    expect(body().profile.dimensions.pipelines.periodDays).toBeNull();
  });

  it('skips an absent summary instead of emitting an empty dimension', async () => {
    await call(router(quota({
      quotas: { pipelines: { used: 1, limit: 10, resetAt: RESET }, plugins: null },
    })));
    expect(Object.keys(body().profile.dimensions)).toEqual(['pipelines']);
  });

  it('reads BOTH consent switches as ON when the account never set them', async () => {
    settings(null);
    await call(router(quota()));
    expect(body().profile).toMatchObject({ noticesEnabled: true, offersEnabled: true });
  });

  it('honours an explicit opt-out of each, independently', async () => {
    settings({ enabled: false, offersEnabled: true });
    await call(router(quota()));
    expect(body().profile).toMatchObject({ noticesEnabled: false, offersEnabled: true });

    mockSendSuccess.mockClear();
    settings({ enabled: true, offersEnabled: false });
    await call(router(quota()));
    expect(body().profile).toMatchObject({ noticesEnabled: true, offersEnabled: false });
  });

  it('treats an unreadable settings row as "never said", not as opted out', async () => {
    settingsFailure();
    await call(router(quota()));
    expect(body().profile).toMatchObject({ noticesEnabled: true, offersEnabled: true });
  });

  it('names the ACCOUNT ROOT for a pooled team', async () => {
    await call(router(quota({ orgId: 'team-7', pool: { rootOrgId: 'acct-1' } })));
    const { profile } = body();
    expect(profile.orgId).toBe('team-7');
    expect(profile.rootOrgId).toBe('acct-1');
  });

  it('falls back to the org itself when it is not pooled', async () => {
    await call(router(quota()));
    expect(body().profile.rootOrgId).toBe('acct-1');
  });

  it('reads the settings row for the ROOT, not the team', async () => {
    await call(router(quota({ orgId: 'team-7', pool: { rootOrgId: 'acct-1' } })));
    expect(mockSettingsFindOne).toHaveBeenCalledWith({ orgId: 'acct-1' });
  });

  it('carries the tier, which the rules need to price anything', async () => {
    await call(router(quota()));
    expect(body().profile.tier).toBe('pro');
  });
});
