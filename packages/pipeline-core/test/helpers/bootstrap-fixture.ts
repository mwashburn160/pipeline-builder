// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A resolved toolchain release for synth tests: the `pipeline-bootstrap` half
 * as `/plugins/lookup` returns it (system repository, signed digest) plus the
 * release it came from, and a registry with an external pull host so the image
 * resolves the way it does against a real platform.
 */

import type { ResolvedBootstrap } from '../../src/core/plugin-lookup-envelope.js';

export const BOOTSTRAP_DIGEST = `sha256:${'b'.repeat(64)}`;
export const TEST_AWS_CDK = '2.1148.0';
export const TEST_CDK_ASSETS = '4.8.0';

/** Registry override (BuilderProps.registry) with a CodeBuild-reachable pull host. */
export const TEST_REGISTRY = { host: 'registry.example.com', port: 443, pullHost: 'registry.example.com', pullPort: 443 };

export function bootstrapFixture(overrides: { digest?: string; repository?: string; releaseVersion?: string; versions?: Record<string, string> } = {}): ResolvedBootstrap {
  return {
    plugin: {
      id: '00000000-0000-0000-0000-0000000000b0',
      orgId: 'system',
      name: 'pipeline-bootstrap',
      version: overrides.releaseVersion ?? '1.1.0',
      pluginType: 'BuildImage',
      buildType: 'prebuilt',
      imageDigest: overrides.digest ?? BOOTSTRAP_DIGEST,
      imageRepository: overrides.repository ?? 'system/pipeline-bootstrap',
      commands: [],
      installCommands: [],
      metadata: {},
      env: {},
      secrets: [],
    } as never,
    toolchain: {
      releaseVersion: overrides.releaseVersion ?? '1.1.0',
      resolvedVia: 'default',
      versions: overrides.versions ?? { awsCdk: TEST_AWS_CDK, cdkAssets: TEST_CDK_ASSETS, pipelineManager: '4.4.20', node: '26.13.0' },
    },
  };
}
