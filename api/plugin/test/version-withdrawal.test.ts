// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Withdrawals that do not refuse (deactivate, yank, unreferenced delete,
 * uninstall, listing / publisher suspend): an in-use WARNING built from
 * `findVersionReferences`, and an N14 notice per affected org naming only that
 * org's own pipelines.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockFindRefs = jest.fn<(...a: any[]) => Promise<any[]>>();
const mockFindOrgsUsingVersion = jest.fn<(...a: any[]) => Promise<string[]>>();
const mockEnqueue = jest.fn<(...a: any[]) => Promise<string>>();

const actualData = jest.requireActual('@pipeline-builder/pipeline-data') as Record<string, unknown>;
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  findVersionReferences: (...a: unknown[]) => mockFindRefs(...a),
  distinctPipelines: actualData.distinctPipelines,
  runWithTenantContext: (_c: unknown, fn: () => unknown) => fn(),
}));
jest.unstable_mockModule('../src/services/plugin-service.js', () => ({
  pluginService: { findOrgsUsingVersion: (...a: unknown[]) => mockFindOrgsUsingVersion(...a) },
}));
jest.unstable_mockModule('../src/services/ecosystem-notifications.js', () => ({ enqueueEcosystemNotification: mockEnqueue }));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { incCounter: jest.fn() }));

const w = await import('../src/services/version-withdrawal.js');

const ref = (pipelineId: string, orgId: string, source = 'declared', steps = ['Build/lint']) => ({
  pipelineId, pipelineName: `name-${pipelineId}`, orgId, source, pipelineDeleted: false, steps,
});
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  mockEnqueue.mockResolvedValue('sent');
  mockFindRefs.mockResolvedValue([]);
  mockFindOrgsUsingVersion.mockResolvedValue([]);
});

describe('withdrawalImpact', () => {
  it('warns (never refuses) with the viewer\'s own pipelines by name and other orgs as counts', async () => {
    mockFindRefs.mockResolvedValueOnce([ref('p1', 'org-a'), ref('p1', 'org-a', 'deployed'), ref('p2', 'ORG-B')]);
    const { affected, warning } = await w.withdrawalImpact(
      [{ pluginName: 'lint', pluginVersion: '1.0.0', imageDigest: 'sha256:x', ownerOrgId: 'org-a' }],
      { viewerOrgId: 'org-a', label: 'lint@1.0.0', kind: 'deactivated' },
    );
    expect(affected.map((p) => [p.pipelineId, p.orgId])).toEqual([['p1', 'org-a'], ['p2', 'org-b']]);
    expect(warning).toEqual(expect.objectContaining({
      code: 'PLUGIN_VERSION_IN_USE',
      severity: 'warning',
      pipelineCount: 2,
      orgCount: 2,
      pipelines: [{ id: 'p1', name: 'name-p1', steps: ['Build/lint'] }],
    }));
    expect(warning!.message).toMatch(/was deactivated while 2 pipelines in 2 organizations reference it/);
  });

  it('asks findVersionReferences once per target and can confine the impact to the viewer\'s org', async () => {
    mockFindRefs.mockResolvedValueOnce([ref('p1', 'org-a')]).mockResolvedValueOnce([ref('p2', 'org-b')]);
    const targets = w.listingTargets('acme', 'lint', [{ version: '1.0.0', imageDigest: 'sha256:a' }, { version: '1.1.0' }]);
    expect(targets).toEqual([
      { pluginName: 'lint', pluginVersion: '1.0.0', imageDigest: 'sha256:a', publisher: 'acme' },
      { pluginName: 'lint', pluginVersion: '1.1.0', imageDigest: null, publisher: 'acme' },
    ]);
    const { affected, warning } = await w.withdrawalImpact(targets, { viewerOrgId: 'org-a', label: 'acme/lint', kind: 'uninstalled', onlyViewerOrg: true });
    expect(mockFindRefs).toHaveBeenCalledTimes(2);
    expect(affected.map((p) => p.pipelineId)).toEqual(['p1']);
    expect(warning).toEqual(expect.objectContaining({ pipelineCount: 1, orgCount: 1 }));
  });

  it('answers no warning when nothing references it, or when the read fails', async () => {
    expect((await w.withdrawalImpact([], { viewerOrgId: 'o', label: 'x', kind: 'yanked' })).warning).toBeNull();
    mockFindRefs.mockRejectedValueOnce(new Error('db down'));
    expect(await w.withdrawalImpact([{ pluginName: 'x', pluginVersion: '1' }], { viewerOrgId: 'o', label: 'x', kind: 'yanked' }))
      .toEqual({ affected: [], warning: null });
  });
});

describe('notifyWithdrawal', () => {
  it('sends each affected org its own N14 naming only its pipelines, and one shared notice to orgs with none', async () => {
    const sent = await w.notifyWithdrawal({
      label: 'lint@1.0.0',
      kind: 'yanked',
      affected: [
        { pipelineId: 'p1', pipelineName: 'checkout', orgId: 'org-a', steps: ['Build/lint'] },
        { pipelineId: 'p2', pipelineName: 'billing', orgId: 'org-b', steps: [] },
      ],
      orgIds: ['ORG-A', 'org-c'],
      reason: 'CVE-2026-1',
    });
    expect(sent).toBe(3);
    expect(mockEnqueue).toHaveBeenCalledTimes(3);
    const byRecipient = new Map(mockEnqueue.mock.calls.map(([event, recipients, content]) => {
      expect(event).toBe('N14');
      return [(recipients as Array<{ orgId: string }>).map((r) => r.orgId).join(','), content as { subject: string; text: string }];
    }));
    expect(byRecipient.get('org-c')!.text).not.toMatch(/checkout|billing/);
    expect(byRecipient.get('org-a')!.text).toMatch(/pipeline checkout \(Build\/lint\)/);
    expect(byRecipient.get('org-a')!.text).not.toMatch(/billing/);
    expect(byRecipient.get('org-b')!.text).toMatch(/pipeline billing/);
    expect(byRecipient.get('org-a')!.subject).toBe('Plugin lint@1.0.0 was yanked');
    expect(byRecipient.get('org-a')!.text).toMatch(/Reason: CVE-2026-1/);
  });

  it('sends nothing with no one to tell, and never throws', async () => {
    expect(await w.notifyWithdrawal({ label: 'x', kind: 'deleted', affected: [] })).toBe(0);
    mockEnqueue.mockRejectedValueOnce(new Error('relay down'));
    await expect(w.notifyWithdrawal({ label: 'x', kind: 'deleted', affected: [], orgIds: ['o'] })).resolves.toBe(0);
  });
});

describe('onVersionWithdrawn', () => {
  const plugin = { id: 'id-1', orgId: 'org-a', name: 'lint', version: '1.0.0', isDefault: false, visibility: 'org', imageDigest: 'sha256:d' };

  it('returns the in-use warning and notifies the orgs using the version plus every referencing org', async () => {
    mockFindRefs.mockResolvedValueOnce([ref('p1', 'org-a')]);
    mockFindOrgsUsingVersion.mockResolvedValueOnce(['org-z']);
    const warning = await w.onVersionWithdrawn(plugin, 'deactivated');
    expect(mockFindRefs).toHaveBeenCalledWith({ pluginName: 'lint', pluginVersion: '1.0.0', imageDigest: 'sha256:d', ownerOrgId: 'org-a' });
    expect(warning).toEqual(expect.objectContaining({ pipelineCount: 1 }));
    await flush();
    const orgs = mockEnqueue.mock.calls.flatMap(([, r]) => (r as Array<{ orgId: string }>).map((x) => x.orgId)).sort();
    expect(orgs).toEqual(['org-a', 'org-z']);
  });

  it('still notifies the referencing orgs when the usage read fails', async () => {
    mockFindRefs.mockResolvedValueOnce([ref('p1', 'org-a')]);
    mockFindOrgsUsingVersion.mockRejectedValueOnce(new Error('down'));
    await w.onVersionWithdrawn(plugin, 'yanked', { reason: 'r' });
    await flush();
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });
});
