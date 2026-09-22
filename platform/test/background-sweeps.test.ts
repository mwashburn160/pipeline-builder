// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * services/background-sweeps.ts — the registry: which sweeps apply to the
 * deployment, locked vs every-replica, and that one broken sweep can't keep
 * the rest from starting.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const lockedCalls: Array<{ name: string; lockKey: string }> = [];
const fakeScheduler = () => ({ start: jest.fn<AnyFn>(), stop: jest.fn<AnyFn>() });
const mockCreateScheduler = jest.fn<AnyFn>(() => fakeScheduler());

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createScheduler: (...a: unknown[]) => mockCreateScheduler(...a),
}));
let failBuild: string | undefined;
jest.unstable_mockModule('../src/utils/leader-lock.js', () => ({
  createLockedSweep: (o: { name: string; lockKey: string }) => {
    if (o.name === failBuild) throw new Error('bad config');
    lockedCalls.push(o);
    return fakeScheduler();
  },
}));

const cfg = {
  audit: { spoolDrainIntervalMs: 1000, headExport: { intervalMs: 5000 } },
  billing: { enabled: true, reconcileIntervalMs: 2000 },
  organization: { domainReverifyIntervalMs: 3000, domainReverifyStaleMs: 10 },
  invitation: { sweepIntervalMs: 1000 },
};
jest.unstable_mockModule('../src/config/index.js', () => mockConfig(cfg));

let headTarget: unknown = { bucket: 'b' };
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ drainLocalAuditSpool: jest.fn(async () => undefined) }));
jest.unstable_mockModule('../src/services/audit-head-export.js', () => ({
  exportAuditChainHeads: jest.fn(async () => undefined),
  headExportTarget: () => headTarget,
}));
jest.unstable_mockModule('../src/services/billing-provision.js', () => ({ reconcilePendingBillingSubscriptions: jest.fn(async () => undefined) }));
const mockReverify = jest.fn<AnyFn>(async () => ({ checked: 1, unverified: 0 }));
jest.unstable_mockModule('../src/services/org-domain-service.js', () => ({ orgDomainService: { reverifyStaleDomains: mockReverify } }));
const def = (name: string) => () => ({ name, lockKey: `platform:leader:${name}`, intervalMs: 1000, run: async () => undefined });
jest.unstable_mockModule('../src/services/invitation-reaper.js', () => ({ invitationReaperSweep: def('invitation-reaper') }));
jest.unstable_mockModule('../src/services/impersonation-reaper.js', () => ({ impersonationReaperSweep: def('impersonation-reaper') }));
jest.unstable_mockModule('../src/services/org-purge.js', () => ({ orgPurgeSweep: def('org-purge-sweep') }));
let softDeleteScheduler: unknown = fakeScheduler();
jest.unstable_mockModule('../src/services/soft-delete-purge.js', () => ({
  softDeletePurgeSweep: { name: 'soft-delete-purge', create: () => softDeleteScheduler },
}));

const { sweepDefinitions, registerBackgroundSweeps, buildSweep } = await import('../src/services/background-sweeps.js');

beforeEach(() => {
  jest.clearAllMocks();
  lockedCalls.length = 0;
  headTarget = { bucket: 'b' };
  cfg.billing.enabled = true;
  cfg.organization.domainReverifyIntervalMs = 3000;
  softDeleteScheduler = fakeScheduler();
  failBuild = undefined;
});

describe('sweepDefinitions', () => {
  it('lists every sweep when everything is configured', async () => {
    expect((await sweepDefinitions()).map((d) => d.name)).toEqual([
      'audit-local-spool-drain', 'audit-head-export', 'billing-reconcile', 'domain-reverify',
      'invitation-reaper', 'impersonation-reaper', 'org-purge-sweep', 'soft-delete-purge',
    ]);
  });

  it('drops the sweeps whose feature is off', async () => {
    headTarget = null;
    cfg.billing.enabled = false;
    cfg.organization.domainReverifyIntervalMs = 0;
    const names = (await sweepDefinitions()).map((d) => d.name);
    expect(names).not.toContain('audit-head-export');
    expect(names).not.toContain('billing-reconcile');
    expect(names).not.toContain('domain-reverify');
  });

  it('the domain re-verify sweep re-checks stale domains', async () => {
    const reverify = (await sweepDefinitions()).find((d) => d.name === 'domain-reverify') as { run: () => Promise<void> };
    await reverify.run();
    expect(mockReverify).toHaveBeenCalledWith(10);
  });
});

describe('buildSweep', () => {
  it('locks a sweep with a lockKey and runs one without on every replica', () => {
    buildSweep({ name: 'locked', lockKey: 'k', intervalMs: 1, run: async () => undefined });
    buildSweep({ name: 'every-pod', intervalMs: 1, run: async () => undefined });
    expect(lockedCalls.map((c) => c.name)).toEqual(['locked']);
    expect(mockCreateScheduler).toHaveBeenCalledWith(expect.objectContaining({ name: 'every-pod' }));
  });
});

describe('registerBackgroundSweeps', () => {
  it('starts every applicable sweep and returns them for shutdown', async () => {
    const started = await registerBackgroundSweeps();
    expect(started).toHaveLength(8);
    for (const s of started) expect((s as unknown as { start: jest.Mock }).start).toHaveBeenCalledTimes(1);
  });

  it('skips a disabled custom sweep and survives one that fails to build', async () => {
    softDeleteScheduler = null;
    failBuild = 'org-purge-sweep';
    const started = await registerBackgroundSweeps();
    expect(started).toHaveLength(6);
    expect(lockedCalls.map((c) => c.name)).toContain('impersonation-reaper');
  });
});
