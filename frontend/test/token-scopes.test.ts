// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describeCredentialAuthority, inCatalogOrder, readOnlyPreset } from '../src/components/settings/token-scopes';

describe('permission-scoped credential helpers', () => {
  it('the read-only preset is the :read permissions the person HOLDS', () => {
    expect(readOnlyPreset(['pipelines:write', 'plugins:read', 'pipelines:read'])).toEqual(['pipelines:read', 'plugins:read']);
    expect(readOnlyPreset([])).toEqual([]);
  });

  it('puts a selection in catalog order', () => {
    expect(inCatalogOrder(new Set(['plugins:read', 'pipelines:read', 'bogus']))).toEqual(['pipelines:read', 'plugins:read']);
  });

  it('describes scope, full access and a subset', () => {
    expect(describeCredentialAuthority({ scope: 'registry:push', permissions: null })).toBe('registry:push');
    expect(describeCredentialAuthority({ scope: null, permissions: null })).toBe('Full access (your current permissions)');
    expect(describeCredentialAuthority({ scope: null, permissions: ['pipelines:read'] })).toBe('View pipelines');
  });
});
