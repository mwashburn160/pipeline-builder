// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for helpers/docker-build.
 *
 * The strategy switch is gone — every build runs through buildctl, every
 * prebuilt-tar push runs through crane. Tests assert command shape, auth
 * config writing, Dockerfile patching, and validation.
 */

import { EventEmitter } from 'events';
import { Readable } from 'stream';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

function createMockChild(exitCode = 0): any {
  const child = new EventEmitter();
  (child as any).stdout = new Readable({ read() { this.push(null); } });
  (child as any).stderr = new Readable({ read() { this.push(null); } });
  process.nextTick(() => child.emit('close', exitCode));
  return child;
}

const mockSpawn = jest.fn<(cmd: string, args: string[], opts?: any) => any>(() => createMockChild(0));

jest.unstable_mockModule('child_process', () => ({ spawn: mockSpawn }));

const mockMkdirSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockReadFileSync = jest.fn<(...args: any[]) => any>().mockReturnValue('FROM node:24-slim\nRUN echo hello');
const mockExistsSync = jest.fn<(...args: any[]) => any>().mockReturnValue(true);

jest.unstable_mockModule('fs', () => ({
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync,
}));

class ValidationError extends Error {
  statusCode = 400;
  code = 'VALIDATION_ERROR';
  constructor(message: string) { super(message); this.name = 'ValidationError'; }
}

const mockSignServiceToken = jest.fn<(opts: { ttlSeconds?: number }) => string>(() => 'test-jwt-token');

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  ValidationError,
  signServiceToken: mockSignServiceToken,
}));

const mockConfigGet = (section: string) => {
  if (section === 'dockerConfig') {
    return {
      tempRoot: '/tmp',
      timeoutMs: 900000,
      pushTimeoutMs: 300000,
      buildkitAddr: 'unix:///run/buildkit/buildkitd.sock',
    };
  }
  return {};
};

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  Config: { get: mockConfigGet, getAny: mockConfigGet },
}));

const {
  buildAndPush,
  loadAndPush,
} = await import('../src/helpers/docker-build.js');
type BuildRequest = import('../src/helpers/docker-build.js').BuildRequest;
type RegistryInfo = import('../src/helpers/docker-build.js').RegistryInfo;

function makeRegistry(overrides: Partial<RegistryInfo> = {}): RegistryInfo {
  return { host: 'registry', port: 5000, network: '', http: true, ...overrides };
}

function makeRequest(overrides: Partial<BuildRequest> = {}): BuildRequest {
  return {
    contextDir: '/tmp/build-ctx',
    dockerfile: 'Dockerfile',
    name: 'test-plugin',
    version: '1.0.0',
    orgId: 'test-org',
    buildType: 'build_image' as const,
    registry: makeRegistry(),
    ...overrides,
  };
}

describe('buildAndPush', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSpawn.mockImplementation(() => createMockChild(0));
  });

  it('invokes buildctl with the configured addr and frontend', async () => {
    await buildAndPush(makeRequest());
    const [binary, args] = mockSpawn.mock.calls[0];
    expect(binary).toBe('buildctl');
    expect(args).toEqual(expect.arrayContaining([
      '--addr', 'unix:///run/buildkit/buildkitd.sock',
      'build',
      '--frontend', 'dockerfile.v0',
    ]));
  });

  it('pins the published platform to linux/amd64 (the CodeBuild runtime)', async () => {
    await buildAndPush(makeRequest());
    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining(['--opt', 'platform=linux/amd64']));
  });

  it('namespaces tenant builds under org-<id>/<name>:<version>', async () => {
    const result = await buildAndPush(makeRequest({ orgId: 'acme', name: 'foo', version: '2.1.0' }));
    expect(result.fullImage).toBe('registry:5000/org-acme/foo:2.1.0');
    const outputArg = mockSpawn.mock.calls[0][1].find((a) => a.startsWith('type=image'));
    expect(outputArg).toContain('name=registry:5000/org-acme/foo:2.1.0');
    expect(outputArg).toContain('push=true');
  });

  it('namespaces system org builds under system/<name>:<version>', async () => {
    const result = await buildAndPush(makeRequest({ orgId: 'system' }));
    expect(result.fullImage).toBe('registry:5000/system/test-plugin:1.0.0');
  });

  it('passes registry.insecure=true when http registry', async () => {
    await buildAndPush(makeRequest({ registry: makeRegistry({ http: true }) }));
    const outputArg = mockSpawn.mock.calls[0][1].find((a) => a.startsWith('type=image'));
    expect(outputArg).toContain('registry.insecure=true');
  });

  it('omits registry.insecure when https registry', async () => {
    await buildAndPush(makeRequest({ registry: makeRegistry({ http: false }) }));
    const outputArg = mockSpawn.mock.calls[0][1].find((a) => a.startsWith('type=image'));
    expect(outputArg).not.toContain('registry.insecure');
  });

  it('writes ~/.docker/config.json with bearer JWT', async () => {
    await buildAndPush(makeRequest());
    const configWrite = mockWriteFileSync.mock.calls.find((c) => c[0].endsWith('config.json'));
    expect(configWrite).toBeDefined();
    const parsed = JSON.parse(configWrite![1] as string);
    expect(parsed.auths['registry:5000'].auth).toBe(Buffer.from('_token:test-jwt-token').toString('base64'));
  });

  it('mints the registry-auth token with a TTL equal to the build window', async () => {
    // Regression: the token is spent only at push time (end of the build).
    // A short default TTL (5 min) expired before long builds (gcloud-deploy,
    // playwright) finished pushing, yielding a 401 from image-registry/token.
    // The whole build+push is bounded by timeoutMs, so TTL must equal it (900s).
    await buildAndPush(makeRequest());
    expect(mockSignServiceToken).toHaveBeenCalledWith(
      expect.objectContaining({ ttlSeconds: 900 }),
    );
  });

  it('also writes credentials for the PLATFORM_BASE_URL host (token realm)', async () => {
    // The registry's bearer realm points at PLATFORM_BASE_URL/image-registry/token
    // (the public URL the platform fronts via nginx). Crane only sends Basic auth
    // to hosts present in `auths` — without this second entry it gets 401 when
    // following the bearer challenge.
    const prev = process.env.PLATFORM_BASE_URL;
    process.env.PLATFORM_BASE_URL = 'https://example.com:8443';
    try {
      await buildAndPush(makeRequest());
      const configWrite = mockWriteFileSync.mock.calls.find((c) => c[0].endsWith('config.json'));
      const parsed = JSON.parse(configWrite![1] as string);
      const expected = Buffer.from('_token:test-jwt-token').toString('base64');
      expect(parsed.auths['registry:5000'].auth).toBe(expected);
      expect(parsed.auths['example.com:8443'].auth).toBe(expected);
    } finally {
      process.env.PLATFORM_BASE_URL = prev;
    }
  });

  it('skips the realm host entry when PLATFORM_BASE_URL is unset', async () => {
    const prev = process.env.PLATFORM_BASE_URL;
    delete process.env.PLATFORM_BASE_URL;
    try {
      await buildAndPush(makeRequest());
      const configWrite = mockWriteFileSync.mock.calls.find((c) => c[0].endsWith('config.json'));
      const parsed = JSON.parse(configWrite![1] as string);
      expect(Object.keys(parsed.auths)).toEqual(['registry:5000']);
    } finally {
      if (prev !== undefined) process.env.PLATFORM_BASE_URL = prev;
    }
  });

  it('tolerates a malformed PLATFORM_BASE_URL without throwing', async () => {
    const prev = process.env.PLATFORM_BASE_URL;
    process.env.PLATFORM_BASE_URL = 'not a url';
    try {
      await buildAndPush(makeRequest());
      const configWrite = mockWriteFileSync.mock.calls.find((c) => c[0].endsWith('config.json'));
      const parsed = JSON.parse(configWrite![1] as string);
      // Falls back to just the registry entry — better than crashing the build.
      expect(Object.keys(parsed.auths)).toEqual(['registry:5000']);
    } finally {
      if (prev !== undefined) process.env.PLATFORM_BASE_URL = prev;
      else delete process.env.PLATFORM_BASE_URL;
    }
  });

  it('patches Dockerfile to set DEBIAN_FRONTEND=noninteractive', async () => {
    await buildAndPush(makeRequest());
    const patchWrite = mockWriteFileSync.mock.calls.find((c) => c[0].endsWith('Dockerfile'));
    expect(patchWrite![1]).toContain('ENV DEBIAN_FRONTEND=noninteractive');
  });

  it('passes build args as --opt build-arg:KEY=VALUE', async () => {
    await buildAndPush(makeRequest({ buildArgs: { FOO: 'bar', BAZ: '1' } }));
    const args = mockSpawn.mock.calls[0][1];
    expect(args).toEqual(expect.arrayContaining([
      '--opt', 'build-arg:FOO=bar',
      '--opt', 'build-arg:BAZ=1',
    ]));
  });

  it('rejects invalid registry host', async () => {
    await expect(buildAndPush(makeRequest({ registry: makeRegistry({ host: 'bad host' }) })))
      .rejects.toThrow(/Invalid registry host/);
  });

  it('rejects invalid plugin name', async () => {
    await expect(buildAndPush(makeRequest({ name: 'Bad_Name' })))
      .rejects.toThrow(/Invalid plugin name/);
  });

  it('rejects invalid plugin version', async () => {
    await expect(buildAndPush(makeRequest({ version: '.dotstart' })))
      .rejects.toThrow(/Invalid plugin version/);
  });

  it('rejects invalid build arg key', async () => {
    await expect(buildAndPush(makeRequest({ buildArgs: { '1-bad': 'x' } })))
      .rejects.toThrow(/Invalid build arg key/);
  });

  it('throws when buildctl exits non-zero', async () => {
    mockSpawn.mockImplementation(() => createMockChild(1));
    await expect(buildAndPush(makeRequest())).rejects.toThrow(/exit code 1/);
  });
});

describe('loadAndPush', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSpawn.mockImplementation(() => createMockChild(0));
    mockExistsSync.mockReturnValue(true);
  });

  it('invokes crane push with the tarball and image ref', async () => {
    const result = await loadAndPush('/tmp/image.tar', 'foo', '1.0.0', makeRegistry(), 'acme');
    expect(result.fullImage).toBe('registry:5000/org-acme/foo:1.0.0');
    const [binary, args] = mockSpawn.mock.calls[0];
    expect(binary).toBe('crane');
    expect(args).toEqual(expect.arrayContaining(['push', '/tmp/image.tar', 'registry:5000/org-acme/foo:1.0.0']));
  });

  it('mints the registry-auth token with a TTL equal to the push window', async () => {
    // crane push is bounded by pushTimeoutMs (300s); the token TTL equals it.
    await loadAndPush('/tmp/image.tar', 'foo', '1.0.0', makeRegistry(), 'acme');
    expect(mockSignServiceToken).toHaveBeenCalledWith(
      expect.objectContaining({ ttlSeconds: 300 }),
    );
  });

  it('passes --insecure for http registry', async () => {
    await loadAndPush('/tmp/image.tar', 'foo', '1.0.0', makeRegistry({ http: true }), 'acme');
    expect(mockSpawn.mock.calls[0][1]).toContain('--insecure');
  });

  it('omits --insecure for https registry', async () => {
    await loadAndPush('/tmp/image.tar', 'foo', '1.0.0', makeRegistry({ http: false }), 'acme');
    expect(mockSpawn.mock.calls[0][1]).not.toContain('--insecure');
  });

  it('throws when tarball does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    await expect(loadAndPush('/tmp/missing.tar', 'foo', '1.0.0', makeRegistry(), 'acme'))
      .rejects.toThrow(/Tarball not found/);
  });

  it('rejects invalid plugin name', async () => {
    await expect(loadAndPush('/tmp/image.tar', 'Bad_Name', '1.0.0', makeRegistry(), 'acme'))
      .rejects.toThrow(/Invalid plugin name/);
  });
});
