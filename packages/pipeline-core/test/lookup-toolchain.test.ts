// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import { parseLookupToolchain } from '../src/core/plugin-lookup-envelope.js';

describe('parseLookupToolchain', () => {
  const versions = { pipelineManager: '4.5.6', awsCdk: '2.1148.1', cdkAssets: '4.8.0', node: '26.13.1' };

  it('reads the tool versions a release carries', () => {
    expect(parseLookupToolchain({ releaseVersion: '1.1.8', resolvedVia: 'default', versions }))
      .toEqual({ releaseVersion: '1.1.8', resolvedVia: 'default', versions });
  });

  it('drops tools the toolchain no longer carries instead of failing on them', () => {
    // esbuild and pnpm left the toolchain when nothing bundled at synth any more.
    const parsed = parseLookupToolchain(
      { releaseVersion: '1.1.7', resolvedVia: 'default', versions: { ...versions, esbuild: '0.28.1', pnpm: '12.14.0' } },
      { metadata: { 'toolchain.esbuild': '0.28.1', 'toolchain.pnpm': '12.14.0' } },
    );
    expect(parsed?.versions).toEqual(versions);
  });
});
