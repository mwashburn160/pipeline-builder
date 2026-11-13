// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import { ErrorCode, getStatusForErrorCode } from '../src/types/error-codes.js';
import {
  MANAGED_TOOLCHAIN_PLUGINS, isManagedToolchainPlugin, managedRefPinsVersion, managedToolchainRefName, toolchainReleasePin,
} from '../src/types/plugin-catalog.js';
import { PipelineCreateSchema, PipelineUpdateSchema } from '../src/validation/pipeline-schemas.js';

describe('isManagedToolchainPlugin', () => {
  it('matches exactly the two reserved names, case-insensitively', () => {
    expect([...MANAGED_TOOLCHAIN_PLUGINS]).toEqual(['pipeline-bootstrap', 'cdk-synth']);
    expect(isManagedToolchainPlugin('pipeline-bootstrap')).toBe(true);
    expect(isManagedToolchainPlugin('CDK-Synth')).toBe(true);
    expect(isManagedToolchainPlugin('cdk-synth-custom')).toBe(false);
    expect(isManagedToolchainPlugin('')).toBe(false);
    expect(isManagedToolchainPlugin(undefined)).toBe(false);
    expect(isManagedToolchainPlugin(null)).toBe(false);
  });
});

describe('managed toolchain error codes', () => {
  it.each([
    [ErrorCode.PLUGIN_MANAGED_NAME_RESERVED, 403],
    [ErrorCode.PLUGIN_MANAGED_NOT_LISTABLE, 400],
    [ErrorCode.PLUGIN_MANAGED_PRERELEASE, 400],
    [ErrorCode.TOOLCHAIN_USE_CONSOLE, 400],
    [ErrorCode.PLUGIN_VERSION_IMMUTABLE, 409],
    [ErrorCode.TOOLCHAIN_NO_DEFAULT, 409],
    [ErrorCode.TOOLCHAIN_RELEASE_NOT_ELIGIBLE, 400],
    [ErrorCode.TOOLCHAIN_PIN_VIA_RELEASE, 400],
    [ErrorCode.TOOLCHAIN_PAIR_MISMATCH, 500],
  ])('%s → %i', (code, status) => {
    expect(getStatusForErrorCode(code)).toBe(status);
  });
});

describe('managed references', () => {
  it('names the managed half a reference RESOLVES (filter.name wins)', () => {
    expect(managedToolchainRefName({ name: 'cdk-synth' })).toBe('cdk-synth');
    expect(managedToolchainRefName({ name: 'BuildSynth', filter: { name: 'CDK-Synth' } })).toBe('cdk-synth');
    expect(managedToolchainRefName({ name: 'cdk-synth', filter: { name: 'my-synth' } })).toBeNull();
    expect(managedToolchainRefName({ name: 'trivy' })).toBeNull();
    expect(managedToolchainRefName(null)).toBeNull();
  });

  it('a version (exact or range) or id is a pin; isDefault and friends are not', () => {
    expect(managedRefPinsVersion({ version: '1.0.0' })).toBe(true);
    expect(managedRefPinsVersion({ version: '^1.0.0' })).toBe(true);
    expect(managedRefPinsVersion({ id: 'x' })).toBe(true);
    expect(managedRefPinsVersion({ isDefault: true, isActive: true, version: ' ' })).toBe(false);
    expect(managedRefPinsVersion(undefined)).toBe(false);
  });

  it('reads the pipeline toolchain.release pin', () => {
    expect(toolchainReleasePin({ toolchain: { release: ' 1.2.0 ' } })).toBe('1.2.0');
    expect(toolchainReleasePin({ toolchain: {} })).toBeUndefined();
    expect(toolchainReleasePin({})).toBeUndefined();
    expect(toolchainReleasePin(null)).toBeUndefined();
  });
});

describe('pipeline props: toolchain.release', () => {
  const props = (toolchain?: unknown) => ({ project: 'p', organization: 'o', synth: { plugin: { name: 'cdk-synth' } }, ...(toolchain !== undefined ? { toolchain } : {}) });
  const create = (toolchain?: unknown) => PipelineCreateSchema.safeParse({ project: 'p', organization: 'o', props: props(toolchain) });

  it('is optional and must be a release version', () => {
    expect(create().success).toBe(true);
    expect(create({ release: '1.4.2' }).success).toBe(true);
    for (const bad of [{ release: '^1.4.0' }, { release: '1.4' }, { release: '1.4.2-dev.1' }, { release: 7 }, { release: '1.4.2', extra: true }, 'x']) {
      expect(create(bad).success).toBe(false);
    }
    expect(PipelineUpdateSchema.safeParse({ props: props({ release: '1.0.0' }) }).success).toBe(true);
  });
});
