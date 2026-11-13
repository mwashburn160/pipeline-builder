// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Step facts resolve a managed toolchain step (cdk-synth) through the toolchain
 * resolver ONLY, with the pipeline's `toolchain.release` — never a row or
 * listing of the same name (docs/plans/bootstrap-image-versioning.md §2).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';

const actualData = jest.requireActual('@pipeline-builder/pipeline-data') as Record<string, unknown>;
const mockManagedHalf = jest.fn<AnyFn>();
const mockRowQuery = jest.fn<AnyFn>(async () => []);
const mockListing = jest.fn<AnyFn>(async () => null);
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  ...actualData,
  runWithTenantContext: (_c: unknown, fn: () => unknown) => fn(),
  withTenantTx: async (fn: AnyFn) => fn({
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: mockRowQuery }) }) }) }),
  }),
  resolveListingReference: (...a: unknown[]) => mockListing(...a),
  resolveManagedToolchainHalf: (...a: unknown[]) => mockManagedHalf(...a),
}));

const { withPipelineStepFacts } = await import('../src/helpers/pipeline-step-facts.js');

beforeEach(() => { jest.clearAllMocks(); });

describe('withPipelineStepFacts — managed toolchain', () => {
  it('resolves cdk-synth from the toolchain resolver with the pipeline pin, never a row or listing', async () => {
    mockManagedHalf.mockResolvedValue({ plugin: { category: 'infrastructure', pluginType: 'CodeBuildStep', scanSummary: { kev: 2 }, scanFlag: null } });
    const props = { toolchain: { release: '1.2.0' }, synth: { plugin: { name: 'BuildSynth', filter: { name: 'cdk-synth' } } } };
    const { attributes, deferredFields } = await withPipelineStepFacts({ props }, 'org-a', 'root-a');
    expect(deferredFields).toEqual([]);
    expect(mockManagedHalf).toHaveBeenCalledWith({ orgId: 'org-a' }, 'cdk-synth', { releasePin: '1.2.0' });
    expect(mockRowQuery).not.toHaveBeenCalled();
    expect(mockListing).not.toHaveBeenCalled();
    expect(attributes.stepFacts).toMatchObject({ kevSteps: 1, kevStepNames: ['synth'] });
  });

  it('a refused managed step contributes nothing (and still never falls through to a row)', async () => {
    mockManagedHalf.mockResolvedValue({ refusal: { code: 'PLUGIN_UNAVAILABLE', reason: 'toolchain_no_default', message: 'none' } });
    const { attributes } = await withPipelineStepFacts({ props: { synth: { plugin: { name: 'cdk-synth' } } } }, 'org-a');
    expect(mockManagedHalf).toHaveBeenCalledWith({ orgId: 'org-a' }, 'cdk-synth', {});
    expect(mockRowQuery).not.toHaveBeenCalled();
    expect(attributes.stepFacts).toMatchObject({ kevSteps: 0, securityScanSteps: 0 });
  });
});

describe('withPipelineStepFacts — other steps', () => {
  it('resolves an own row first, then a listing; a failure defers the facts', async () => {
    mockRowQuery.mockResolvedValueOnce([{ category: 'security', pluginType: 'CodeBuildStep', scanSummary: null, scanFlag: { kev: 1 } }]);
    mockListing.mockResolvedValueOnce({
      ok: true,
      publisher: { handle: 'acme', tier: 'verified', ownerOrgId: null },
      listing: { id: 'l1', name: 'lint', description: null, summary: null, category: 'quality', license: null, homepageUrl: null, sourceUrl: null, icon: null },
      version: { id: 'v1', version: '1.0.0', specSnapshot: { pluginType: 'CodeBuildStep', category: 'security' }, scanSummary: { kev: 0 }, scanFlag: null },
      mode: { kind: 'implicit' },
      secretsWithheld: false,
    });
    const props = { stages: [{ stageName: 'Test', steps: [{ plugin: { name: 'trivy' } }, { plugin: { name: 'lint', publisher: 'acme', filter: { version: '1.0.0' } } }] }] };
    const { attributes } = await withPipelineStepFacts({ props }, 'org-a', 'root-a');
    expect(mockManagedHalf).not.toHaveBeenCalled();
    expect(attributes.stepFacts).toMatchObject({ securityScanSteps: 2, kevSteps: 1, kevStepNames: ['Test/trivy'] });

    mockRowQuery.mockRejectedValueOnce(new Error('db down'));
    const failed = await withPipelineStepFacts({ props: { synth: { plugin: { name: 'trivy' } } } }, 'org-a');
    expect(failed.deferredFields).toEqual(['stepFacts']);
  });
});
