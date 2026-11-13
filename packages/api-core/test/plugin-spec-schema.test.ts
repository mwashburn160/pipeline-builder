// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for validation/plugin-spec-schema — the plugin PACKAGE schemas
 * (`plugin-spec.yaml`, `config.yaml`) the upload API and the CLI share.
 */

import { describe, it, expect } from '@jest/globals';
import {
  checkPluginConfig, checkPluginSpec, isValidEgressHost, pluginSpecRequiredFieldsProblem,
  PLUGIN_NAME_PATTERN, PLUGIN_VERSION_PATTERN,
} from '../src/validation/plugin-spec-schema.js';

describe('isValidEgressHost', () => {
  it.each(['api.github.com', '*.amazonaws.com', 'registry-1.docker.io'])('accepts %s', (host) => {
    expect(isValidEgressHost(host)).toBe(true);
  });

  it.each([
    'localhost', '10.0.0.1', 'https://api.github.com', 'api.github.com:443', 'api.github.com/path',
    '*.*.example.com', 'a.*.example.com', 'API.GITHUB.COM', `${'a'.repeat(250)}.com`, '',
  ])('refuses %p', (host) => {
    expect(isValidEgressHost(host)).toBe(false);
  });
});

describe('checkPluginSpec', () => {
  const base = {
    name: 'my-lint',
    version: '0.1.0',
    pluginType: 'CodeBuildStep',
    computeType: 'SMALL',
    commands: ['echo hi'],
    primaryOutputDirectory: 'out',
  };

  it('accepts a full catalog-ready spec', () => {
    const r = checkPluginSpec({
      ...base,
      summary: 'Lints.',
      license: 'Apache-2.0',
      icon: { key: 'eslint', badge: 'typescript' },
      homepageUrl: 'https://example.com',
      network: { egress: ['registry.npmjs.org'] },
      smokeTest: 'true',
    });
    expect(r.ok).toBe(true);
  });

  it('normalizes a null primaryOutputDirectory to undefined', () => {
    const r = checkPluginSpec({ ...base, primaryOutputDirectory: null });
    expect(r).toEqual({ ok: true, value: expect.not.objectContaining({ primaryOutputDirectory: expect.anything() }) });
  });

  it('reports path-qualified issues, unknown keys included', () => {
    const r = checkPluginSpec({ ...base, computeType: 'HUGE', license: 'WTFPL', surprise: 1, network: { egress: ['https://x.io'] } });
    expect(r.ok).toBe(false);
    const { issues: list, message } = r as { issues: string[]; message: string };
    expect(message).toBe(`plugin-spec.yaml: ${list.join('; ')}`);
    const issues = list.join('\n');
    expect(issues).toContain('computeType:');
    expect(issues).toContain('license: must be a supported SPDX');
    expect(issues).toContain('network.egress.0: must be a bare hostname');
    expect(issues).toMatch(/\(root\): .*surprise/);
  });

  it('refuses a non-mapping document', () => {
    const refused = { ok: false, issues: ['plugin-spec.yaml must be a YAML mapping'], message: 'plugin-spec.yaml must be a YAML mapping' };
    expect(checkPluginSpec(['x'])).toEqual(refused);
    expect(checkPluginSpec(null)).toEqual(refused);
  });

  it('caps the changelog in UTF-8 bytes', () => {
    expect(checkPluginSpec({ ...base, changelog: 'é'.repeat(17 * 1024) }).ok).toBe(false);
  });
});

describe('checkPluginConfig', () => {
  it('accepts a build manifest', () => {
    expect(checkPluginConfig({ pluginSpec: 'plugin-spec.yaml', buildType: 'build_image', dockerfile: 'Dockerfile' }).ok).toBe(true);
  });

  it('refuses a dockerfile for prebuilt / metadata_only, and a non-mapping', () => {
    expect(checkPluginConfig({ buildType: 'prebuilt', dockerfile: 'Dockerfile' })).toEqual({
      ok: false, issues: ['dockerfile is not allowed when buildType is prebuilt'], message: 'config.yaml: dockerfile is not allowed when buildType is prebuilt',
    });
    expect(checkPluginConfig({ buildType: 'metadata_only', dockerfile: 'Dockerfile' }).ok).toBe(false);
    expect(checkPluginConfig('x')).toMatchObject({ ok: false, message: 'config.yaml must be a YAML mapping' });
  });
});

describe('pluginSpecRequiredFieldsProblem', () => {
  it('requires name, version and (except approvals) commands', () => {
    expect(pluginSpecRequiredFieldsProblem({ name: 'a', version: '1.0.0', commands: ['x'] })).toBeNull();
    expect(pluginSpecRequiredFieldsProblem({ name: 'a', version: '1.0.0', pluginType: 'ManualApprovalStep' })).toBeNull();
    expect(pluginSpecRequiredFieldsProblem({ name: 'pipeline-bootstrap', version: '1.0.0', pluginType: 'BuildImage' })).toBeNull();
    expect(pluginSpecRequiredFieldsProblem({ name: 'a', version: '1.0.0' })).toMatch(/required/);
    expect(pluginSpecRequiredFieldsProblem({ version: '1.0.0', commands: ['x'] })).toMatch(/required/);
  });
});

describe('name / version patterns', () => {
  it('matches the upload rules', () => {
    expect(PLUGIN_NAME_PATTERN.test('my-lint-2')).toBe(true);
    expect(PLUGIN_NAME_PATTERN.test('My_Lint')).toBe(false);
    expect(PLUGIN_VERSION_PATTERN.test('1.2.3-beta.1+build.5')).toBe(true);
    expect(PLUGIN_VERSION_PATTERN.test('1.2')).toBe(false);
  });
});

describe('BuildImage specs (managed toolchain)', () => {
  const toolchain = { pipelineManager: '4.4.19', awsCdk: '2.1100.0', cdkAssets: '3.2.0', esbuild: '0.25.0', pnpm: '10.12.1', node: '24.11.0' };
  const sourceDigest = 'a'.repeat(64);
  const buildImage = { name: 'pipeline-bootstrap', version: '1.0.0', pluginType: 'BuildImage', description: 'Bootstrap image', category: 'infrastructure', toolchain, sourceDigest };
  const issuesOf = (raw: unknown) => {
    const r = checkPluginSpec(raw);
    return r.ok ? [] : r.issues;
  };

  it('accepts a BuildImage spec without commands', () => {
    expect(checkPluginSpec(buildImage).ok).toBe(true);
    expect(checkPluginSpec({ ...buildImage, sourceDigest: `sha256:${sourceDigest}` }).ok).toBe(true);
  });

  it.each(['commands', 'installCommands'])('refuses %s on a BuildImage spec', (field) => {
    expect(issuesOf({ ...buildImage, [field]: ['echo hi'] })).toEqual([`${field}: is not allowed on a BuildImage plugin`]);
  });

  it('refuses metadata on a BuildImage spec', () => {
    expect(issuesOf({ ...buildImage, metadata: { a: 'b' } })).toEqual(['metadata: is not allowed on a BuildImage plugin']);
  });

  it('requires toolchain and sourceDigest', () => {
    const { toolchain: _t, sourceDigest: _d, ...bare } = buildImage;
    expect(issuesOf(bare)).toEqual(['toolchain: is required on a BuildImage plugin', 'sourceDigest: is required on a BuildImage plugin']);
  });

  it('refuses a BuildImage under a non-managed name', () => {
    expect(issuesOf({ ...buildImage, name: 'my-bootstrap' })).toEqual(['pluginType: BuildImage is reserved for the managed toolchain plugins']);
  });

  it('refuses a partial, inexact or extended toolchain, and a malformed digest', () => {
    const { node: _n, ...partial } = toolchain;
    expect(issuesOf({ ...buildImage, toolchain: partial }).join('\n')).toContain('toolchain.node');
    expect(issuesOf({ ...buildImage, toolchain: { ...toolchain, awsCdk: '^2.1100.0' } })).toEqual(['toolchain.awsCdk: must be an exact semver version (e.g. 1.2.3)']);
    expect(issuesOf({ ...buildImage, toolchain: { ...toolchain, extra: '1.0.0' } }).join('\n')).toMatch(/toolchain/);
    expect(issuesOf({ ...buildImage, sourceDigest: 'xyz' })).toEqual(['sourceDigest: must be a sha256 hex digest']);
  });

  it('refuses toolchain / sourceDigest on any other plugin type', () => {
    expect(issuesOf({ name: 'cdk-synth', version: '1.0.0', pluginType: 'CodeBuildStep', commands: ['cdk synth'], toolchain, sourceDigest })).toEqual([
      'toolchain: is only allowed on a BuildImage plugin',
      'sourceDigest: is only allowed on a BuildImage plugin',
    ]);
  });

  it('does not require prebuilt in config.yaml (the checked-in config says build_image)', () => {
    expect(checkPluginConfig({ pluginSpec: 'plugin-spec.yaml', dockerfile: 'Dockerfile', buildType: 'build_image' }).ok).toBe(true);
  });
});
