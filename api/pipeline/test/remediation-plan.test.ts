// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Who gets a remediation fix, per step (helpers/remediation-rollout.ts
 * `planMove`): an exact pin is rewritten, an install policy that already admits
 * the fix gets a redeploy, a listing install pinned to the flagged version is
 * moved (or, gated, gets a change request), and a rollback pins range steps
 * back. The resolver (what synth would pick) and the listing state are driven
 * per test.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';

const mockResolve = jest.fn<AnyFn>();
const mockListingStates = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/helpers/plugin-contract-check.js', () => ({
  resolveContractPlugin: (...a: unknown[]) => mockResolve(...a),
  recordPipelineResolution: jest.fn(),
}));
jest.unstable_mockModule('../src/helpers/plugin-upgrade-apply.js', () => ({ applyUpgradeToPipeline: jest.fn(), redeployPipeline: jest.fn() }));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  orgListingStates: (...a: unknown[]) => mockListingStates(...a),
  drizzleListingSource: () => ({}),
  runWithTenantContext: (_c: unknown, fn: () => unknown) => fn(),
  withTenantTx: (fn: (tx: unknown) => unknown) => fn({}),
  schema: new Proxy({}, { get: () => ({}) }),
}));

const { planMove } = await import('../src/helpers/remediation-rollout.js');
const { applyPluginUpgrades } = await import('../src/helpers/plugin-upgrades.js');

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ref = (publisher: string | null = null) => ({ remediationId: 'r-1', plugin: 'trivy', publisher, fromVersion: '1.4.2', toVersion: '1.4.3' });

const step = (name: string, version?: string, extra: Record<string, unknown> = {}) => ({
  name: `s-${name}-${version ?? 'none'}`,
  plugin: { name, ...extra, ...(version ? { filter: { version } } : {}) },
});
const props = (...steps: unknown[]): any => ({ stages: [{ stageName: 'Build', steps }] });

/** The resolver: `trivy` resolves to `resolved[declared ?? '']`. */
function resolvesTo(map: Record<string, string>, publisher: string | null = null) {
  mockResolve.mockImplementation(async (filter: any) => {
    if (filter.name !== 'trivy') return { plugin: { name: filter.name, version: '9.9.9', publisher: null } };
    const v = map[filter.version ?? ''];
    return v ? { plugin: { name: 'trivy', version: v, publisher } } : null;
  });
}

beforeEach(() => { jest.clearAllMocks(); });

describe('planMove', () => {
  it('rewrites an exact pin on the flagged version, leaving the rest of the config alone', async () => {
    resolvesTo({ '1.4.2': '1.4.2' });
    const p = props(step('trivy', '1.4.2'), step('jest', '2.0.0'));
    const plan = await planMove({ orgId: ORG, props: p }, null, ref());
    expect(plan.kind).toBe('step_pin');
    expect(plan.steps).toHaveLength(1);
    const { props: next, applied } = applyPluginUpgrades(p, plan.steps);
    expect(applied).toEqual([expect.objectContaining({ fromVersion: '1.4.2', toDeclared: '1.4.3' })]);
    expect((next as any).stages[0].steps[0].plugin.filter.version).toBe('1.4.3');
    expect((next as any).stages[0].steps[1].plugin.filter.version).toBe('2.0.0');
  });

  it('a range the install policy admits already resolves to the fix: a redeploy, no rewrite', async () => {
    resolvesTo({ '^1.4.0': '1.4.3' });
    const plan = await planMove({ orgId: ORG, props: props(step('trivy', '^1.4.0')) }, null, ref());
    expect(plan).toEqual({ kind: 'redeploy', steps: [], install: null });
  });

  it('a range held on the flagged version with no install to move is not admitted', async () => {
    resolvesTo({ '~1.4.2': '1.4.2' });
    const plan = await planMove({ orgId: ORG, props: props(step('trivy', '~1.4.2')) }, null, ref());
    expect(plan.kind).toBe('not_admitted');
  });

  it('a listing install pinned to the flagged version is moved; its tier\'s approval rule makes it gated', async () => {
    resolvesTo({ '': '1.4.2' }, 'acme');
    const state = (tier: string) => [{
      publisher: { handle: 'acme', tier },
      mode: { kind: 'explicit', inherited: false, install: { id: 'inst-1', orgId: ORG, versionPolicy: 'pinned', pinnedVersion: '1.4.2' } },
      policy: { requireApprovalTiers: ['community', 'unverified'] },
    }];
    mockListingStates.mockResolvedValueOnce(state('verified'));
    const plan = await planMove({ orgId: ORG, props: props(step('trivy', undefined, { publisher: 'acme' })) }, null, ref('acme'));
    expect(plan).toEqual({ kind: 'install_pin', steps: [], install: { id: 'inst-1', orgId: ORG, gated: false } });

    mockListingStates.mockResolvedValueOnce(state('community'));
    const gated = await planMove({ orgId: ORG, props: props(step('trivy', undefined, { publisher: 'acme' })) }, null, ref('acme'));
    expect(gated.install).toEqual({ id: 'inst-1', orgId: ORG, gated: true });
  });

  it('a team resolves through its root org', async () => {
    resolvesTo({ '1.4.2': '1.4.2' });
    await planMove({ orgId: ORG, props: props(step('trivy', '1.4.2')) }, 'rootrootrootrootrootroot', ref());
    expect(mockResolve).toHaveBeenCalledWith(expect.anything(), ORG, 'rootrootrootrootrootroot');
  });

  it('a rollback pins range steps back to the previous version', async () => {
    resolvesTo({ '^1.4.0': '1.4.3' });
    const back = { ...ref(), fromVersion: '1.4.3', toVersion: '1.4.2' };
    const plan = await planMove({ orgId: ORG, props: props(step('trivy', '^1.4.0')) }, null, back, { pinRanges: true });
    expect(plan.kind).toBe('step_pin');
    expect(plan.steps[0]!.apply.version).toBe('1.4.2');
  });

  it('a team\'s rollback never moves its root\'s inherited install: its own range steps are pinned back', async () => {
    resolvesTo({ '': '1.4.3' }, 'acme');
    mockListingStates.mockResolvedValueOnce([{
      publisher: { handle: 'acme', tier: 'verified' },
      mode: { kind: 'explicit', inherited: true, install: { id: 'root-inst', orgId: 'rootrootrootrootrootroot', versionPolicy: 'pinned', pinnedVersion: '1.4.3' } },
      policy: { requireApprovalTiers: [] },
    }]);
    const back = { ...ref('acme'), fromVersion: '1.4.3', toVersion: '1.4.2' };
    const plan = await planMove({ orgId: ORG, props: props(step('trivy', undefined, { publisher: 'acme' })) }, 'rootrootrootrootrootroot', back, { pinRanges: true });
    expect(plan.kind).toBe('step_pin');
    expect(plan.install).toBeNull();
    expect(plan.steps[0]!.apply.version).toBe('1.4.2');
  });

  it('a pipeline no longer on either version is stale', async () => {
    resolvesTo({ '2.0.0': '2.0.0' });
    expect((await planMove({ orgId: ORG, props: props(step('trivy', '2.0.0')) }, null, ref())).kind).toBe('stale');
  });
});
