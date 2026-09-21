// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { App, Stack } from 'aws-cdk-lib';

const { Config } = await import('../src/config/app-config.js');
const { resolveDefaultBuildImage, resolvePluginImage } = await import('../src/core/pipeline-helpers.js');
const { parsePlatformBaseUrl } = await import('../src/config/infrastructure-config.js');

const DIGEST = `sha256:${'a'.repeat(64)}`;

/** Minimal image-backed plugin (signed digest recorded) that reaches the pull-host resolution. */
const imagePlugin = {
  name: 'trivy', version: '1.0.0', buildType: 'build_image', orgId: '000000000000000000000001', imageDigest: DIGEST,
} as never;

/**
 * The CodeBuild image URI must use a registry host AWS CodeBuild can resolve.
 * When it resolves to the in-cluster `registry` default, synth must fail fast
 * (instead of baking `registry:5000` into a pipeline that dies at build time).
 */
describe('registry pull-host guard (resolveDefaultBuildImage)', () => {
  const REGISTRY_ENV = [
    'IMAGE_REGISTRY_HOST', 'IMAGE_REGISTRY_PORT',
    'IMAGE_REGISTRY_PULL_HOST', 'IMAGE_REGISTRY_PULL_PORT',
    'PLATFORM_BASE_URL', 'ALLOW_INCLUSTER_PULL_HOST', 'CODEBUILD_DEFAULT_IMAGE',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of REGISTRY_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
    // A bare tag forces the registry-prefix path (where the guard lives).
    process.env.CODEBUILD_DEFAULT_IMAGE = 'pipeline-bootstrap:1.0';
    Config._resetForTesting();
  });

  afterEach(() => {
    for (const k of REGISTRY_ENV) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    Config._resetForTesting();
  });

  it('throws when the pull host resolves to the in-cluster registry default', () => {
    // IMAGE_REGISTRY_HOST unset → defaults to 'registry'; no pull host configured.
    const stack = new Stack(new App(), 'S');
    expect(() => resolveDefaultBuildImage(stack, 'org1')).toThrow(/CodeBuild cannot reach/);
  });

  it('does not throw when an external pull host is configured', () => {
    process.env.IMAGE_REGISTRY_PULL_HOST = 'registry.example.com';
    process.env.IMAGE_REGISTRY_PULL_PORT = '443';
    Config._resetForTesting();
    const stack = new Stack(new App(), 'S');
    expect(() => resolveDefaultBuildImage(stack, 'org1')).not.toThrow();
  });

  it('derives the pull host from PLATFORM_BASE_URL', () => {
    process.env.PLATFORM_BASE_URL = 'https://pipeline.example.com';
    Config._resetForTesting();
    const stack = new Stack(new App(), 'S');
    expect(() => resolveDefaultBuildImage(stack, 'org1')).not.toThrow();
  });

  it('bypasses the guard with ALLOW_INCLUSTER_PULL_HOST=true', () => {
    process.env.ALLOW_INCLUSTER_PULL_HOST = 'true';
    Config._resetForTesting();
    const stack = new Stack(new App(), 'S');
    expect(() => resolveDefaultBuildImage(stack, 'org1')).not.toThrow();
  });

  // The plugin-image path is the common one for real plugins — guard it too.
  it('throws on the resolvePluginImage path for an in-cluster default host', () => {
    const stack = new Stack(new App(), 'S');
    expect(() => resolvePluginImage(stack, imagePlugin, 'org1')).toThrow(/CodeBuild cannot reach/);
  });

  it('does not throw on resolvePluginImage with an external pull host', () => {
    process.env.IMAGE_REGISTRY_PULL_HOST = 'registry.example.com';
    Config._resetForTesting();
    const stack = new Stack(new App(), 'S');
    expect(() => resolvePluginImage(stack, imagePlugin, 'org1')).not.toThrow();
  });

  // Host normalization: uppercase, embedded :port, IPv6 brackets, and
  // cluster/mDNS suffixes must all be recognized as unreachable.
  it.each([
    ['REGISTRY', true],
    ['registry:5000', true],
    ['localhost:5000', true],
    ['svc.pipeline.svc.cluster.local', true],
    ['anything.local', true],
    ['0.0.0.0', true],
    ['registry.example.com', false],
    ['10.0.0.5', false], // RFC1918 IS reachable from CodeBuild in a VPC
  ])('host %s → unreachable=%s', (host, unreachable) => {
    process.env.IMAGE_REGISTRY_PULL_HOST = host as string;
    Config._resetForTesting();
    const stack = new Stack(new App(), 'S');
    const call = () => resolveDefaultBuildImage(stack, 'org1');
    if (unreachable) expect(call).toThrow(/CodeBuild cannot reach/);
    else expect(call).not.toThrow();
  });
});

/**
 * CodeBuild must pull the plugin image BY the digest the plugin service verified,
 * never by the mutable `name:version` tag — and a plugin that needs an image but
 * has no signed digest must fail the synth rather than fall back to the tag.
 */
describe('resolvePluginImage digest pinning', () => {
  beforeEach(() => {
    process.env.IMAGE_REGISTRY_PULL_HOST = 'registry.example.com';
    process.env.IMAGE_REGISTRY_PULL_PORT = '443';
    Config._resetForTesting();
  });
  afterEach(() => {
    delete process.env.IMAGE_REGISTRY_PULL_HOST;
    delete process.env.IMAGE_REGISTRY_PULL_PORT;
    Config._resetForTesting();
  });

  it('pins the image URI to the recorded digest', () => {
    const stack = new Stack(new App(), 'S');
    const image = resolvePluginImage(stack, imagePlugin, 'org1') as { imageId: string };
    expect(image.imageId).toBe(`registry.example.com/system/trivy@${DIGEST}`);
    expect(image.imageId).not.toContain(':1.0.0');
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['malformed', 'sha256:not-hex'],
  ])('refuses an image plugin whose digest is %s', (_label, imageDigest) => {
    const stack = new Stack(new App(), 'S');
    const plugin = { ...(imagePlugin as object), imageDigest } as never;
    expect(() => resolvePluginImage(stack, plugin, 'org1')).toThrow(/no signed image digest/);
  });

  it('needs no digest for a metadata_only plugin', () => {
    const stack = new Stack(new App(), 'S');
    const plugin = { ...(imagePlugin as object), buildType: 'metadata_only', imageDigest: null } as never;
    expect(resolvePluginImage(stack, plugin, 'org1')).toBeUndefined();
  });
});

describe('Config.override', () => {
  afterEach(() => Config._resetForTesting());

  it('merges a partial over the env-loaded section and ignores undefined fields', () => {
    process.env.IMAGE_REGISTRY_HOST = 'registry';
    Config._resetForTesting();

    Config.override('registry', { pullHost: 'public.example.com', pullPort: 443, host: undefined });

    const registry = Config.get('registry');
    expect(registry.pullHost).toBe('public.example.com');
    expect(registry.pullPort).toBe(443);
    // undefined in the partial must not clobber the loaded value
    expect(registry.host).toBe('registry');
  });
});

describe('parsePlatformBaseUrl', () => {
  it.each([
    ['https://pipeline.example.com', { host: 'pipeline.example.com', port: 443 }],
    ['http://pipeline.example.com', { host: 'pipeline.example.com', port: 80 }],
    ['https://pipeline.example.com:8443', { host: 'pipeline.example.com', port: 8443 }],
    ['https://pipeline.example.com/some/path', { host: 'pipeline.example.com', port: 443 }],
  ])('parses %s', (url, expected) => {
    expect(parsePlatformBaseUrl(url as string)).toEqual(expected);
  });

  it.each([undefined, '', 'not a url', 'pipeline.example.com:8443'])(
    'returns null for unparseable/scheme-less input %s',
    (bad) => {
      expect(parsePlatformBaseUrl(bad as string | undefined)).toBeNull();
    },
  );
});

describe('Config.reload', () => {
  const saved = process.env.IMAGE_REGISTRY_HOST;
  afterEach(() => {
    if (saved === undefined) delete process.env.IMAGE_REGISTRY_HOST;
    else process.env.IMAGE_REGISTRY_HOST = saved;
    Config._resetForTesting();
  });

  it('re-reads env on the next get() and drops override() values', () => {
    process.env.IMAGE_REGISTRY_HOST = 'first';
    Config.reload();
    expect(Config.get('registry').host).toBe('first');

    // Override, then mutate env — reload must reflect env, not the override.
    Config.override('registry', { host: 'overridden' });
    expect(Config.get('registry').host).toBe('overridden');

    process.env.IMAGE_REGISTRY_HOST = 'second';
    Config.reload();
    expect(Config.get('registry').host).toBe('second');
  });
});
