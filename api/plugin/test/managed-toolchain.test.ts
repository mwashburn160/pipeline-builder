// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for helpers/managed-toolchain — the refusals for the managed toolchain
 * names (docs/plans/bootstrap-image-versioning.md §1, §5, D5).
 */

import { describe, it, expect } from '@jest/globals';
import { SYSTEM_ORG_ID } from '@pipeline-builder/api-core';

const { assertListable, assertManagedUploadAllowed, assertNotManaged } = await import('../src/helpers/managed-toolchain.js');

function thrown(fn: () => void): { statusCode?: number; code?: string } | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err as { statusCode?: number; code?: string };
  }
}

describe('assertManagedUploadAllowed', () => {
  it('ignores every other name', () => {
    expect(thrown(() => assertManagedUploadAllowed('org-1', 'my-synth', '1.0.0-dev.1', { publishRequest: true }))).toBeNull();
  });

  it('refuses a customer org first (403 PLUGIN_MANAGED_NAME_RESERVED), whatever else is wrong', () => {
    expect(thrown(() => assertManagedUploadAllowed('org-1', 'cdk-synth', '1.0.0-dev.1', { publishRequest: true })))
      .toMatchObject({ statusCode: 403, code: 'PLUGIN_MANAGED_NAME_RESERVED' });
  });

  it('refuses a publish request (400 PLUGIN_MANAGED_NOT_LISTABLE), then a prerelease (400 PLUGIN_MANAGED_PRERELEASE)', () => {
    expect(thrown(() => assertManagedUploadAllowed(SYSTEM_ORG_ID, 'pipeline-bootstrap', '1.0.0', { publishRequest: true })))
      .toMatchObject({ statusCode: 400, code: 'PLUGIN_MANAGED_NOT_LISTABLE' });
    expect(thrown(() => assertManagedUploadAllowed(SYSTEM_ORG_ID, 'pipeline-bootstrap', '1.0.1-dev.2')))
      .toMatchObject({ statusCode: 400, code: 'PLUGIN_MANAGED_PRERELEASE' });
  });

  it('accepts a plain release from the system org', () => {
    expect(thrown(() => assertManagedUploadAllowed(SYSTEM_ORG_ID.toUpperCase(), 'cdk-synth', '1.4.2'))).toBeNull();
  });
});

describe('assertListable / assertNotManaged', () => {
  it('refuse only the managed names', () => {
    expect(thrown(() => assertListable('cdk-synth'))).toMatchObject({ statusCode: 400, code: 'PLUGIN_MANAGED_NOT_LISTABLE' });
    expect(thrown(() => assertNotManaged('pipeline-bootstrap'))).toMatchObject({ statusCode: 400, code: 'TOOLCHAIN_USE_CONSOLE' });
    expect(thrown(() => assertListable('lint'))).toBeNull();
    expect(thrown(() => assertNotManaged(undefined))).toBeNull();
  });
});
