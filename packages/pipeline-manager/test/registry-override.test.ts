// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { bakePlatformRegistry, registryOverrideFromBaseUrl } from '../src/utils/registry.js';

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
