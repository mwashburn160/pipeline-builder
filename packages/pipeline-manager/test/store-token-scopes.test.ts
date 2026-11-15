// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

const { STORE_TOKEN_SCOPES } = await import('../src/commands/store-token.js');
const { scopeSecretLeaf } = await import('../src/utils/platform-secret.js');
const { PIPELINE_REGISTRATION_SECRET_LEAF } = await import('@pipeline-builder/pipeline-core');

describe('store-token scopes (what audit tokens scans)', () => {
  it('cover every scoped secret leaf, the pipeline-registration key included', () => {
    expect(STORE_TOKEN_SCOPES.map(scopeSecretLeaf).sort())
      .toEqual(['pipeline-registry-write', 'registry-push', 'reporting-ingest']);
    expect(STORE_TOKEN_SCOPES.map(scopeSecretLeaf)).toContain(PIPELINE_REGISTRATION_SECRET_LEAF);
  });
});
