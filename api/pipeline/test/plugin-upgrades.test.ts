// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const scanned = new Date();
const summary = (criticalFixable: number, highFixable = 0, kev = 0) => ({ criticalFixable, highFixable, kev, findings: [], imageDigest: DIGEST });

/** What each step's reference resolves to (keyed by filter.version ?? '*'). */
const mockResolve = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/helpers/plugin-contract-check.js', () => ({
  resolveContractPlugin: (...a: unknown[]) => mockResolve(...a),
}));

/** The org's own live versions of the plugin (the candidates). */
let mockOwnRows: Array<Record<string, unknown>> = [];
const actualData = jest.requireActual('@pipeline-builder/pipeline-data') as Record<string, unknown>;
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  withTenantTx: async (fn: (tx: unknown) => unknown) => fn({
    select: () => ({ from: () => ({ where: async () => mockOwnRows }) }),
  }),
  runWithTenantContext: (_c: unknown, fn: () => unknown) => fn(),
  buildPluginConditions: () => [],
  compareSemver: actualData.compareSemver,
  satisfiesVersionSpec: actualData.satisfiesVersionSpec,
  isVersionRange: actualData.isVersionRange,
  schema: {
    plugin: {
      version: 'version',
      name: 'name',
      imageDigest: 'image_digest',
      buildType: 'build_type',
      pluginType: 'plugin_type',
      scannedAt: 'scanned_at',
      scanSummary: 'scan_summary',
      scanFlag: 'scan_flag',
      scanFlaggedAt: 'scan_flagged_at',
      deletedAt: 'deleted_at',
      yankedAt: 'yanked_at',
      deprecatedAt: 'deprecated_at',
    },
  },
}));

const { previewPluginUpgrades, applyPluginUpgrades } = await import('../src/helpers/plugin-upgrades.js');

const row = (version: string, scanSummary: unknown, over: Record<string, unknown> = {}) => ({
  name: 'trivy', version, imageDigest: DIGEST, buildType: 'build_image', pluginType: 'CodeBuildStep', scannedAt: scanned, scanSummary, scanFlag: null, scanFlaggedAt: null, ...over,
});

const props = (version?: string) => ({
  project: 'p',
  organization: 'o',
  synth: { plugin: { name: 'cdk-synth' } },
  stages: [{ stageName: 'Build', steps: [{ plugin: { name: 'trivy', ...(version ? { filter: { version } } : {}) } }] }],
});

describe('plugin upgrades', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOwnRows = [
      row('1.2.0', summary(2)), // the current, vulnerable one
      row('1.3.0', summary(0, 1)), // newer but still a fixable High → not clean
      row('1.4.0', summary(0)), // newest clean in ^1
      row('1.5.0', null, { scannedAt: null }), // unscanned → never suggested
      row('2.1.0', summary(0)), // newest clean overall
    ];
    mockResolve.mockImplementation(async (filter: any) => (filter.name === 'trivy'
      ? { plugin: { id: 'x', orgId: 'org-1', publisher: null, name: 'trivy', version: '1.2.0', scan: { imageDigest: DIGEST, scanSummary: summary(2) } } }
      : { plugin: { id: 'y', orgId: 'org-1', publisher: null, name: 'cdk-synth', version: '1.0.0', scan: { imageDigest: DIGEST, scanSummary: summary(0) } } }));
  });

  it('lists only steps that need an upgrade, with the newest CLEAN version in the pin and overall', async () => {
    const upgrades = await previewPluginUpgrades(props('1.2.0'), 'org-1');
    expect(upgrades).toEqual([expect.objectContaining({
      stepKey: 'Build/trivy',
      path: 'stages[0].steps[0]',
      pin: 'exact',
      currentVersion: '1.2.0',
      reason: { flagged: false, kev: 0, criticalFixable: 2, highFixable: 0 },
      suggestedInPin: '1.4.0',
      suggestedLatest: '2.1.0',
      apply: { version: '1.4.0', widenVersion: '1.4.0' },
    })]);
  });

  it('a range is left alone unless widened, which re-anchors it at the newest clean version', async () => {
    const [u] = await previewPluginUpgrades(props('~1.2.0'), 'org-1');
    expect(u).toEqual(expect.objectContaining({ pin: 'range', suggestedInPin: null, apply: { version: null, widenVersion: '^2.1.0' } }));

    expect(applyPluginUpgrades(props('~1.2.0'), [u!]).applied).toEqual([]);
    const widened = applyPluginUpgrades(props('~1.2.0'), [u!], { widen: true });
    expect((widened.props.stages as any)[0].steps[0].plugin.filter).toEqual({ version: '^2.1.0' });
  });

  it('rewrites only filter.version, on a copy, and reports what moved', async () => {
    const input = props('1.2.0');
    const upgrades = await previewPluginUpgrades(input, 'org-1');
    const { props: next, applied } = applyPluginUpgrades(input, upgrades);
    expect((next.stages as any)[0].steps[0].plugin).toEqual({ name: 'trivy', filter: { version: '1.4.0' } });
    expect((input.stages as any)[0].steps[0].plugin.filter.version).toBe('1.2.0');
    expect(applied).toEqual([{ stepKey: 'Build/trivy', plugin: 'trivy', publisher: null, fromVersion: '1.2.0', fromDeclared: '1.2.0', toDeclared: '1.4.0' }]);
    expect(applyPluginUpgrades(input, upgrades, { onlySteps: ['synth'] }).applied).toEqual([]);
  });
});
