// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import { ErrorCode, getStatusForErrorCode } from '../src/types/error-codes.js';
import { MANAGED_TOOLCHAIN_PLUGINS, isManagedToolchainPlugin } from '../src/types/plugin-catalog.js';

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
  ])('%s → %i', (code, status) => {
    expect(getStatusForErrorCode(code)).toBe(status);
  });
});
