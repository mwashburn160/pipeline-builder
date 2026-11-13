// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline's toolchain release pin at save time
 * (docs/plans/bootstrap-image-versioning.md §5, D15): a managed cdk-synth can't
 * carry its own version, and `toolchain.release` must be eligible — checked only
 * when the pin CHANGES against the stored pipeline.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';

const actualData = jest.requireActual('@pipeline-builder/pipeline-data') as Record<string, unknown>;
const mockEligible = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  ...actualData,
  isEligibleRelease: (...a: unknown[]) => mockEligible(...a),
}));

const { checkToolchainPin, stepsPinningManagedVersion } = await import('../src/helpers/toolchain-pin-check.js');

const synth = (filter?: Record<string, unknown>, name = 'cdk-synth') => ({ synth: { plugin: { name, ...(filter ? { filter } : {}) } } });

beforeEach(() => { mockEligible.mockReset(); });

describe('checkToolchainPin', () => {
  it('refuses a managed cdk-synth pinning its own version: TOOLCHAIN_PIN_VIA_RELEASE', async () => {
    for (const props of [synth({ version: '1.1.0' }), synth({ version: '^1.0.0' }), synth({ name: 'cdk-synth', version: '1.1.0' }, 'BuildSynth'), synth({ id: 'row-1' })]) {
      await expect(checkToolchainPin(props, 'org-a')).resolves.toMatchObject({ status: 400, code: 'TOOLCHAIN_PIN_VIA_RELEASE', details: { steps: ['synth'] } });
    }
    expect(mockEligible).not.toHaveBeenCalled();
    // Unpinned (filter.isDefault and friends are not a version pin) and a non-managed pinned step are fine.
    expect(stepsPinningManagedVersion(synth({ name: 'cdk-synth', isActive: true, isDefault: true }, 'BuildSynth'))).toEqual([]);
    expect(stepsPinningManagedVersion(synth({ version: '1.0.0' }, 'my-synth'))).toEqual([]);
  });

  it('checks eligibility when the pin is new on a create', async () => {
    mockEligible.mockResolvedValueOnce(false);
    await expect(checkToolchainPin({ ...synth(), toolchain: { release: '1.4.0' } }, 'org-a'))
      .resolves.toMatchObject({ status: 400, code: 'TOOLCHAIN_RELEASE_NOT_ELIGIBLE', details: { release: '1.4.0' } });
    expect(mockEligible).toHaveBeenCalledWith('org-a', '1.4.0');
    mockEligible.mockResolvedValueOnce(true);
    await expect(checkToolchainPin({ ...synth(), toolchain: { release: '1.4.0' } }, 'org-a')).resolves.toBeNull();
  });

  it('checks eligibility only when the pin CHANGES: an unrelated edit of a pipeline on a later-yanked release saves', async () => {
    const stored = { ...synth(), toolchain: { release: '1.2.0' } };
    await expect(checkToolchainPin({ ...stored, description: 'edited' }, 'org-a', stored)).resolves.toBeNull();
    expect(mockEligible).not.toHaveBeenCalled();

    mockEligible.mockResolvedValueOnce(false);
    await expect(checkToolchainPin({ ...synth(), toolchain: { release: '1.3.0' } }, 'org-a', stored))
      .resolves.toMatchObject({ code: 'TOOLCHAIN_RELEASE_NOT_ELIGIBLE' });
    expect(mockEligible).toHaveBeenCalledWith('org-a', '1.3.0');
  });

  it('no pin, or removing one, is always fine', async () => {
    await expect(checkToolchainPin(synth(), 'org-a')).resolves.toBeNull();
    await expect(checkToolchainPin(synth(), 'org-a', { ...synth(), toolchain: { release: '1.2.0' } })).resolves.toBeNull();
    expect(mockEligible).not.toHaveBeenCalled();
  });
});
