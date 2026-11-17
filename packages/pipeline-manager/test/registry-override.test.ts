// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { pipelineStackName } from '../src/config/cli.constants.js';
import { bakePlatformRegistry, buildRegistryPayload, readStepManifest, registryOverrideFromBaseUrl } from '../src/utils/registry.js';

describe('registryOverrideFromBaseUrl', () => {
  it.each([
    ['https://p.example.com', { pullHost: 'p.example.com', pullPort: 443 }],
    ['http://p.example.com', { pullHost: 'p.example.com', pullPort: 80 }],
    ['https://p.example.com:8443', { pullHost: 'p.example.com', pullPort: 8443 }],
  ])('maps %s', (url, expected) => {
    expect(registryOverrideFromBaseUrl(url as string)).toEqual(expected);
  });

  it.each([undefined, '', 'garbage'])('returns undefined for %s', (bad) => {
    expect(registryOverrideFromBaseUrl(bad as string | undefined)).toBeUndefined();
  });
});

describe('bakePlatformRegistry', () => {
  const saved = process.env.IMAGE_REGISTRY_PULL_HOST;
  beforeEach(() => { delete process.env.IMAGE_REGISTRY_PULL_HOST; });
  afterEach(() => {
    if (saved === undefined) delete process.env.IMAGE_REGISTRY_PULL_HOST;
    else process.env.IMAGE_REGISTRY_PULL_HOST = saved;
  });

  it('bakes the pull target from the base URL', () => {
    const props: Record<string, unknown> = {};
    bakePlatformRegistry(props, 'https://p.example.com');
    expect(props.registry).toEqual({ pullHost: 'p.example.com', pullPort: 443 });
  });

  it('is a no-op when IMAGE_REGISTRY_PULL_HOST is set (explicit env wins)', () => {
    process.env.IMAGE_REGISTRY_PULL_HOST = 'operator.example.com';
    const props: Record<string, unknown> = {};
    bakePlatformRegistry(props, 'https://p.example.com');
    expect(props.registry).toBeUndefined();
  });

  it('is a no-op for an unparseable/absent base URL', () => {
    const props: Record<string, unknown> = {};
    bakePlatformRegistry(props, undefined);
    bakePlatformRegistry(props, 'garbage');
    expect(props.registry).toBeUndefined();
  });
});

describe('readStepManifest', () => {
  it('reads the manifest the synth app wrote into the cloud assembly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-manifest-'));
    const steps = [{ stageName: 'test-wave', actionName: 'jest', pluginId: 'pl-1', pluginName: 'jest', pluginVersion: '1.0.0', imageDigest: null }];
    writeFileSync(join(dir, 'pb-step-manifest.json'), JSON.stringify(steps));
    await expect(readStepManifest(dir)).resolves.toEqual(steps);
  });

  it('returns undefined when absent or malformed (registration proceeds without it)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-manifest-'));
    await expect(readStepManifest(dir)).resolves.toBeUndefined();
    writeFileSync(join(dir, 'pb-step-manifest.json'), '{"not":"an array"}');
    await expect(readStepManifest(dir)).resolves.toBeUndefined();
  });
});

describe('buildRegistryPayload stack name', () => {
  // The registry must record the SAME stack name the synth app deploys
  // (boilerplate.ts), or audit-stacks reports a live stack as orphaned.
  it('records the hyphenated stack name and keeps project/organization as given', async () => {
    const payload = await buildRegistryPayload(
      { id: 'pl-1', orgId: 'org-1', project: 'spring_boot', organization: 'system' },
      'us-east-1',
    );
    // `spring_boot` is lossy under `_` → `-`, so it carries the raw-pair hash.
    expect(payload.stackName).toBe(pipelineStackName('spring_boot', 'system'));
    expect(payload.stackName).toMatch(/^spring-boot-system-[0-9a-f]{8}$/);
    expect(payload.project).toBe('spring_boot');
    expect(payload.organization).toBe('system');
  });
});
