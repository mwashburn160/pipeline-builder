// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for helpers/docker-build.
 *
 * Mocks child_process (spawn, execFileSync) and fs to verify
 * build command construction, input validation, two-step OCI
 * build+push flow, streaming output, and Dockerfile injection.
 */

import { EventEmitter } from 'events';
import { Readable } from 'stream';

// Mocks — must be defined before imports

/** Create a fake ChildProcess that emits 'close' with code 0 on next tick. */
function createMockChild(exitCode = 0): any {
  const child = new EventEmitter();
  (child as any).stdout = new Readable({ read() { this.push(null); } });
  (child as any).stderr = new Readable({ read() { this.push(null); } });
  process.nextTick(() => child.emit('close', exitCode));
  return child;
}

const mockSpawn = jest.fn<any, [string, string[], any?]>(() => createMockChild(0));
const mockExecFileSync = jest.fn();

jest.mock('child_process', () => ({
  spawn: mockSpawn,
  execFileSync: mockExecFileSync,
}));

const mockMkdirSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockReadFileSync = jest.fn().mockReturnValue('FROM node:24-slim\nRUN echo hello');
const mockExistsSync = jest.fn();
const mockRmSync = jest.fn();

jest.mock('fs', () => ({
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync,
  rmSync: mockRmSync,
}));

jest.mock('@pipeline-builder/api-core', () => {
  class ValidationError extends Error {
    statusCode = 400;
    code = 'VALIDATION_ERROR';
    constructor(message: string) { super(message); this.name = 'ValidationError'; }
  }
  return {
    ValidationError,
    createLogger: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }),
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    // writeAuthJson mints a platform JWT to use as Basic-auth password.
    // Tests don't push anywhere — return a deterministic placeholder so
    // assertions on the resulting `auth` field are stable.
    signServiceToken: jest.fn(() => 'test-jwt-token'),
  };
});

let mockStrategy = 'docker';

const mockConfigGet = (section: string) => {
  if (section === 'dockerConfig') {
    return {
      strategy: mockStrategy,
      tempRoot: '/tmp',
      timeoutMs: 900000,
      pushTimeoutMs: 300000,
      kanikoExecutor: '/kaniko/executor',
      kanikoCacheDir: '/kaniko/cache',
    };
  }
  return {};
};

jest.mock('@pipeline-builder/pipeline-core', () => ({
  Config: {
    get: mockConfigGet,
    getAny: mockConfigGet,
  },
}));

import {
  buildAndPush,
  type BuildRequest,
  type RegistryInfo,
} from '../src/helpers/docker-build';

// Helpers

function makeRegistry(overrides: Partial<RegistryInfo> = {}): RegistryInfo {
  return {
    host: 'registry',
    port: 5000,
    network: '',
    http: true,
    insecure: true,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<BuildRequest> = {}): BuildRequest {
  return {
    contextDir: '/tmp/build-ctx',
    dockerfile: 'Dockerfile',
    imageTag: 'p-test-abc123',
    orgId: 'test-org',
    buildType: 'build_image' as const,
    registry: makeRegistry(),
    ...overrides,
  };
}

// Tests

describe('docker-build', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: spawn returns a child that exits with code 0
    mockSpawn.mockImplementation(() => createMockChild(0));
    // Default: execFileSync returns successfully
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    // Default: readFileSync returns a simple Dockerfile
    mockReadFileSync.mockReturnValue('FROM node:24-slim\nRUN echo hello');
    // Default: strategy is docker
    mockStrategy = 'docker';
  });

  describe('input validation', () => {
    it('rejects invalid registry host', async () => {
      const req = makeRequest({ registry: makeRegistry({ host: 'bad host!' }) });
      await expect(buildAndPush(req)).rejects.toThrow('Invalid registry host');
    });

    it('rejects empty registry host', async () => {
      const req = makeRequest({ registry: makeRegistry({ host: '' }) });
      await expect(buildAndPush(req)).rejects.toThrow('Invalid registry host');
    });

    it('rejects port below 1', async () => {
      const req = makeRequest({ registry: makeRegistry({ port: 0 }) });
      await expect(buildAndPush(req)).rejects.toThrow('Invalid registry port');
    });

    it('rejects port above 65535', async () => {
      const req = makeRequest({ registry: makeRegistry({ port: 70000 }) });
      await expect(buildAndPush(req)).rejects.toThrow('Invalid registry port');
    });

    it('rejects non-integer port', async () => {
      const req = makeRequest({ registry: makeRegistry({ port: 5000.5 }) });
      await expect(buildAndPush(req)).rejects.toThrow('Invalid registry port');
    });

    it('rejects invalid image tag', async () => {
      const req = makeRequest({ imageTag: 'UPPER-CASE' });
      await expect(buildAndPush(req)).rejects.toThrow('Invalid image tag');
    });

    it('rejects image tag starting with dot', async () => {
      const req = makeRequest({ imageTag: '.hidden' });
      await expect(buildAndPush(req)).rejects.toThrow('Invalid image tag');
    });

    it('rejects invalid network name', async () => {
      const req = makeRequest({ registry: makeRegistry({ network: 'bad network!' }) });
      await expect(buildAndPush(req)).rejects.toThrow('Invalid network');
    });

    it('accepts valid inputs', async () => {
      const req = makeRequest();
      const result = await buildAndPush(req);
      expect(result.fullImage).toBe('registry:5000/org-test-org/p-test-abc123:latest');
    });

    it('accepts valid network name', async () => {
      const req = makeRequest({ registry: makeRegistry({ network: 'my-compose_net' }) });
      const result = await buildAndPush(req);
      expect(result.fullImage).toBe('registry:5000/org-test-org/p-test-abc123:latest');
    });
  });

  describe('Docker config setup', () => {
    it('creates .docker config directory', async () => {
      await buildAndPush(makeRequest());

      expect(mockMkdirSync).toHaveBeenCalledWith(
        '/tmp/build-ctx/.docker',
        { recursive: true },
      );
    });

    it('writes auth config with a platform-JWT-based credential', async () => {
      await buildAndPush(makeRequest());

      // Auth carries `_token:<platform JWT>` — image-registry's /token
      // endpoint verifies the JWT and trades it for a Bearer registry token.
      const expectedAuth = Buffer.from('_token:test-jwt-token').toString('base64');
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/tmp/build-ctx/.docker/config.json',
        JSON.stringify({
          auths: { 'registry:5000': { auth: expectedAuth } },
        }),
      );
    });

    it('writes auth config for podman strategy', async () => {
      mockStrategy = 'podman';
      await buildAndPush(makeRequest());

      const expectedAuth = Buffer.from('_token:test-jwt-token').toString('base64');
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/tmp/build-ctx/.docker/config.json',
        JSON.stringify({
          auths: { 'registry:5000': { auth: expectedAuth } },
        }),
      );
    });
  });

  describe('build without network (default Docker networking)', () => {
    it('spawns docker build then docker push as two separate calls', async () => {
      await buildAndPush(makeRequest());

      expect(mockSpawn).toHaveBeenCalledTimes(2);

      // First call: docker build
      const [buildBinary, buildArgs] = mockSpawn.mock.calls[0];
      expect(buildBinary).toBe('docker');
      expect(buildArgs[0]).toBe('build');
      expect(buildArgs).toContain('--progress');
      expect(buildArgs).toContain('-f');
      expect(buildArgs).toContain('-t');
      expect(buildArgs).toContain('registry:5000/org-test-org/p-test-abc123:latest');

      // Second call: docker push
      const [pushBinary, pushArgs] = mockSpawn.mock.calls[1];
      expect(pushBinary).toBe('docker');
      expect(pushArgs[0]).toBe('push');
      expect(pushArgs).toContain('registry:5000/org-test-org/p-test-abc123:latest');
    });

    it('sets DOCKER_CONFIG env var for docker auth', async () => {
      await buildAndPush(makeRequest());

      expect(process.env.DOCKER_CONFIG).toBe('/tmp/build-ctx/.docker');
    });

    it('calls execFileSync for rmi cleanup after push', async () => {
      await buildAndPush(makeRequest());

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
        ['rmi', 'registry:5000/org-test-org/p-test-abc123:latest'],
        { stdio: 'ignore' },
      );
    });

    it('returns the full image reference', async () => {
      const result = await buildAndPush(makeRequest());
      expect(result).toEqual({ fullImage: 'registry:5000/org-test-org/p-test-abc123:latest' });
    });
  });

  describe('buildArgs handling', () => {
    it('includes --build-arg flags in the build spawn call', async () => {
      const req = makeRequest({
        buildArgs: { PYTHON_VERSION: '3.12' },
      });
      await buildAndPush(req);

      // First spawn call is the build
      const buildArgs = mockSpawn.mock.calls[0][1];
      expect(buildArgs).toContain('--build-arg');
      expect(buildArgs).toContain('PYTHON_VERSION=3.12');
    });

    it('does not include --build-arg in the push spawn call', async () => {
      const req = makeRequest({
        buildArgs: { PYTHON_VERSION: '3.12' },
      });
      await buildAndPush(req);

      // Second spawn call is the push
      const pushArgs = mockSpawn.mock.calls[1][1];
      expect(pushArgs).not.toContain('--build-arg');
    });

    it('includes multiple --build-arg flags', async () => {
      const req = makeRequest({
        buildArgs: { PYTHON_VERSION: '3.12', NODE_ENV: 'production' },
      });
      await buildAndPush(req);

      const buildArgs = mockSpawn.mock.calls[0][1];
      const buildArgFlags = buildArgs.filter((a: string) => a === '--build-arg');
      expect(buildArgFlags).toHaveLength(2);
      expect(buildArgs).toContain('PYTHON_VERSION=3.12');
      expect(buildArgs).toContain('NODE_ENV=production');
    });

    it('skips --build-arg when buildArgs is empty', async () => {
      const req = makeRequest({ buildArgs: {} });
      await buildAndPush(req);

      const buildArgs = mockSpawn.mock.calls[0][1];
      expect(buildArgs).not.toContain('--build-arg');
    });

    it('skips --build-arg when buildArgs is undefined', async () => {
      const req = makeRequest();
      await buildAndPush(req);

      const buildArgs = mockSpawn.mock.calls[0][1];
      expect(buildArgs).not.toContain('--build-arg');
    });

    it('places --build-arg flags before -f flag', async () => {
      const req = makeRequest({ buildArgs: { VERSION: '1.0' } });
      await buildAndPush(req);

      const args = mockSpawn.mock.calls[0][1];
      const buildArgIdx = args.indexOf('--build-arg');
      const fIdx = args.indexOf('-f');
      expect(buildArgIdx).toBeGreaterThan(-1);
      expect(buildArgIdx).toBeLessThan(fIdx);
    });
  });

  describe('error handling', () => {
    it('throws when Docker build exits non-zero', async () => {
      mockSpawn.mockImplementation(() => createMockChild(1));

      await expect(buildAndPush(makeRequest())).rejects.toThrow(
        'Build failed with exit code 1',
      );
    });

    it('throws when spawn emits error', async () => {
      mockSpawn.mockImplementation(() => {
        const child = new EventEmitter();
        (child as any).stdout = new Readable({ read() { this.push(null); } });
        (child as any).stderr = new Readable({ read() { this.push(null); } });
        process.nextTick(() => child.emit('error', new Error('spawn ENOENT')));
        return child;
      });

      await expect(buildAndPush(makeRequest())).rejects.toThrow('spawn ENOENT');
    });
  });

  describe('output streaming', () => {
    it('includes --progress plain flag', async () => {
      await buildAndPush(makeRequest());

      const spawnArgs = mockSpawn.mock.calls[0][1];
      const progressIdx = spawnArgs.indexOf('--progress');
      expect(progressIdx).toBeGreaterThan(-1);
      expect(spawnArgs[progressIdx + 1]).toBe('plain');
    });
  });

  describe('podman strategy', () => {
    beforeEach(() => {
      mockStrategy = 'podman';
    });

    it('spawns podman as binary instead of docker', async () => {
      await buildAndPush(makeRequest());

      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(mockSpawn.mock.calls[0][0]).toBe('podman');
      expect(mockSpawn.mock.calls[1][0]).toBe('podman');
    });

    it('includes --layers flag in build args', async () => {
      await buildAndPush(makeRequest());

      const buildArgs = mockSpawn.mock.calls[0][1];
      expect(buildArgs).toContain('--layers');
    });

    it('includes --tls-verify=false for insecure registry', async () => {
      const req = makeRequest({ registry: makeRegistry({ insecure: true }) });
      await buildAndPush(req);

      const buildArgs = mockSpawn.mock.calls[0][1];
      expect(buildArgs).toContain('--tls-verify=false');

      const pushArgs = mockSpawn.mock.calls[1][1];
      expect(pushArgs).toContain('--tls-verify=false');
    });

    it('includes --tls-verify=false for http registry', async () => {
      const req = makeRequest({ registry: makeRegistry({ http: true, insecure: false }) });
      await buildAndPush(req);

      const buildArgs = mockSpawn.mock.calls[0][1];
      expect(buildArgs).toContain('--tls-verify=false');
    });

    it('omits --tls-verify=false for secure registry', async () => {
      const req = makeRequest({ registry: makeRegistry({ http: false, insecure: false }) });
      await buildAndPush(req);

      const buildArgs = mockSpawn.mock.calls[0][1];
      expect(buildArgs).not.toContain('--tls-verify=false');
    });

    it('uses --authfile for podman auth', async () => {
      await buildAndPush(makeRequest());

      const buildArgs = mockSpawn.mock.calls[0][1];
      expect(buildArgs).toContain('--authfile=/tmp/build-ctx/.docker/config.json');

      const pushArgs = mockSpawn.mock.calls[1][1];
      expect(pushArgs).toContain('--authfile=/tmp/build-ctx/.docker/config.json');
    });

    it('calls execFileSync for rmi cleanup with podman binary', async () => {
      await buildAndPush(makeRequest());

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'podman',
        ['rmi', 'registry:5000/org-test-org/p-test-abc123:latest'],
        { stdio: 'ignore' },
      );
    });
  });

  describe('Dockerfile injection', () => {
    it('reads and patches Dockerfile for docker strategy', async () => {
      await buildAndPush(makeRequest());

      expect(mockReadFileSync).toHaveBeenCalledWith(
        '/tmp/build-ctx/Dockerfile',
        'utf-8',
      );

      // Find the writeFileSync call for the Dockerfile (not auth config)
      const dockerfileWrite = mockWriteFileSync.mock.calls.find(
        (c: any) => String(c[0]) === '/tmp/build-ctx/Dockerfile',
      );
      expect(dockerfileWrite).toBeDefined();

      const patchedContent = dockerfileWrite![1] as string;
      expect(patchedContent).toContain('DEBIAN_FRONTEND=noninteractive');
      expect(patchedContent).toContain('force-confnew');
    });

    it('reads and patches Dockerfile for podman strategy without force-confnew', async () => {
      mockStrategy = 'podman';
      await buildAndPush(makeRequest());

      expect(mockReadFileSync).toHaveBeenCalledWith(
        '/tmp/build-ctx/Dockerfile',
        'utf-8',
      );

      const dockerfileWrite = mockWriteFileSync.mock.calls.find(
        (c: any) => String(c[0]) === '/tmp/build-ctx/Dockerfile',
      );
      expect(dockerfileWrite).toBeDefined();

      const patchedContent = dockerfileWrite![1] as string;
      expect(patchedContent).toContain('DEBIAN_FRONTEND=noninteractive');
      expect(patchedContent).not.toContain('force-confnew');
    });
  });

  describe('image cleanup after push', () => {
    it('calls rmi after successful push', async () => {
      await buildAndPush(makeRequest());

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
        ['rmi', 'registry:5000/org-test-org/p-test-abc123:latest'],
        { stdio: 'ignore' },
      );
    });

    it('calls rmi even when push fails', async () => {
      // First spawn (build) succeeds, second spawn (push) fails
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        callCount++;
        return createMockChild(callCount === 2 ? 1 : 0);
      });

      await expect(buildAndPush(makeRequest())).rejects.toThrow(
        'Build failed with exit code 1',
      );

      // rmi should still be called even though push failed
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
        ['rmi', 'registry:5000/org-test-org/p-test-abc123:latest'],
        { stdio: 'ignore' },
      );
    });
  });
});
