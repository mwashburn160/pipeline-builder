// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

describe('derivePluginImageCompliance (the one definition of signed/scanned)', () => {
  const DIGEST = `sha256:${'a'.repeat(64)}`;
  const load = async () => import('../src/utils/plugin-compliance.js');

  it('an image plugin with a signed digest and a scan sends the real facts', async () => {
    const { derivePluginImageCompliance } = await load();
    const { attributes, deferredFields } = derivePluginImageCompliance({
      buildType: 'build_image',
      pluginType: 'CodeBuildStep',
      imageDigest: DIGEST,
      scannedAt: new Date(),
      vulnCritical: 1,
      vulnHigh: 2,
      vulnMedium: 0,
      vulnLow: 5,
      runAsRoot: false,
      keywords: ['node'],
      labels: { team: 'core' },
    }, ['openssl', 'zlib']);
    expect(attributes).toEqual({
      tags: ['node', 'team=core'],
      signed: true,
      scanned: true,
      vulnCritical: 1,
      vulnHigh: 2,
      vulnMedium: 0,
      vulnLow: 5,
      runAsRoot: false,
      packages: ['openssl', 'zlib'],
    });
    expect(deferredFields).toEqual([]);
  });

  it('unscanned sends scanned=false and NO counts (a numeric rule cannot pass on a missing value)', async () => {
    const { derivePluginImageCompliance } = await load();
    const { attributes } = derivePluginImageCompliance({
      buildType: 'build_image',
      pluginType: 'CodeBuildStep',
      imageDigest: DIGEST,
      scannedAt: null,
      vulnCritical: null,
      vulnHigh: null,
      runAsRoot: true,
    }, null);
    expect(attributes).toEqual({ tags: [], signed: true, scanned: false, runAsRoot: true });
  });

  it('no digest is unsigned; unknown packages are deferred on paths without the SBOM', async () => {
    const { derivePluginImageCompliance } = await load();
    const { attributes, deferredFields } = derivePluginImageCompliance({
      buildType: 'prebuilt', pluginType: 'CodeBuildStep', imageDigest: null, scannedAt: null,
    });
    expect(attributes.signed).toBe(false);
    expect(attributes).not.toHaveProperty('packages');
    expect(deferredFields).toEqual(['packages']);
  });

  it('a plugin with no image of its own is unsigned, unscanned, package-less — nothing deferred', async () => {
    const { derivePluginImageCompliance } = await load();
    const { attributes, deferredFields } = derivePluginImageCompliance({ buildType: 'metadata_only', pluginType: 'CodeBuildStep', keywords: ['x'] });
    expect(attributes).toEqual({ tags: ['x'], signed: false, scanned: false, packages: [] });
    expect(deferredFields).toEqual([]);
  });
});
