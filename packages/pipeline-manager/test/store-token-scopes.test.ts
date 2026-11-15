// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

const { STORE_TOKEN_SCOPES } = await import('../src/commands/store-token.js');
const { scopeSecretLeaf, siblingSecretName } = await import('../src/utils/platform-secret.js');
const { PIPELINE_REGISTRATION_SECRET_LEAF } = await import('@pipeline-builder/pipeline-core');

describe('store-token scopes (what audit tokens scans)', () => {
  it('cover every scoped secret leaf, the pipeline-registration key included', () => {
    expect(STORE_TOKEN_SCOPES.map(scopeSecretLeaf).sort())
      .toEqual(['pipeline-registry-write', 'registry-push', 'reporting-ingest']);
    expect(STORE_TOKEN_SCOPES.map(scopeSecretLeaf)).toContain(PIPELINE_REGISTRATION_SECRET_LEAF);
  });
});

describe('siblingSecretName (a scoped key never lands in PLATFORM_SECRET_NAME)', () => {
  it('keeps the platform secret for the platform credential', () => {
    expect(siblingSecretName('pipeline-builder/org-1/platform', 'platform')).toBe('pipeline-builder/org-1/platform');
  });
  it('puts a scoped credential beside it', () => {
    expect(siblingSecretName('pipeline-builder/org-1/platform', 'registry-push')).toBe('pipeline-builder/org-1/registry-push');
    expect(siblingSecretName('team/custom-name', 'reporting-ingest')).toBe('team/reporting-ingest');
  });
  it('suffixes a name with no path', () => {
    expect(siblingSecretName('my-secret', 'registry-push')).toBe('my-secret-registry-push');
  });
});
