/**
 * Tests for helpers/docker-build.
 *
 * Mocks child_process (spawn, execFileSync) and fs to verify
 * build command construction, input validation, persistent builder
 * lifecycle, streaming output, and network-change detection.
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
const mockExistsSync = jest.fn();
const mockRmSync = jest.fn();

jest.mock('fs', () => ({
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
  existsSync: mockExistsSync,
  rmSync: mockRmSync,
}));

jest.mock('@mwashburn160/api-core', () => {
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
  };
});

let mockInsecure = true;

jest.mock('@mwashburn160/pipeline-core', () => ({
  CoreConstants: {
    DOCKER_BUILDER_NAME: 'plugin-builder',
    DOCKER_BUILD_TIMEOUT_MS: 900000,
  },
  Config: {
    get: (section: string) => {
      if (section === 'registry') return { insecure: mockInsecure };
      return {};
    },
  },
}));

import {
  buildAndPush,
  destroyBuilder,
  _resetBuilderStateForTesting,
  type BuildRequest,
  type RegistryInfo,
} from '../src/helpers/docker-build';

// Helpers

function makeRegistry(overrides: Partial<RegistryInfo> = {}): RegistryInfo {
  return {
    host: 'registry',
    port: 5000,
    user: 'admin',
    token: 'secret',
    network: '',
    ...overrides,
  };
}

function makeRequest(overrides: Partial<BuildRequest> = {}): BuildRequest {
  return {
    contextDir: '/tmp/build-ctx',
    dockerfile: 'Dockerfile',
    imageTag: 'p-test-abc123',
    registry: makeRegistry(),
    ...overrides,
  };
}

/** Helper: find sync calls for buildx create. */
function findBuildxCreateCall(): string[] | undefined {
  return mockExecFileSync.mock.calls
    .map((c: any) => c[1] as string[])
    .find((args: string[]) => args.includes('buildx') && args.includes('create'));
}

// Tests

describe('docker-build', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetBuilderStateForTesting();
    // Default: spawn returns a child that exits with code 0
    mockSpawn.mockImplementation(() => createMockChild(0));
    // Default: execFileSync returns successfully
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    // Reset mock config
    mockInsecure = true;
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
      await expect(buildAndPush(req)).rejects.toThrow('Invalid image tag format');
    });

    it('rejects image tag starting with dot', async () => {
      const req = makeRequest({ imageTag: '.hidden' });
      await expect(buildAndPush(req)).rejects.toThrow('Invalid image tag format');
    });

    it('rejects invalid network name', async () => {
      const req = makeRequest({ registry: makeRegistry({ network: 'bad network!' }) });
      await expect(buildAndPush(req)).rejects.toThrow('Invalid network name');
    });

    it('accepts valid inputs', async () => {
      const req = makeRequest();
      const result = await buildAndPush(req);
      expect(result.fullImage).toBe('registry:5000/plugin:p-test-abc123');
    });

    it('accepts valid network name', async () => {
      const req = makeRequest({ registry: makeRegistry({ network: 'my-compose_net' }) });
      const result = await buildAndPush(req);
      expect(result.fullImage).toBe('registry:5000/plugin:p-test-abc123');
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

    it('writes auth config with base64 credentials', async () => {
      await buildAndPush(makeRequest());

      const expectedAuth = Buffer.from('admin:secret').toString('base64');
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/tmp/build-ctx/.docker/config.json',
        JSON.stringify({
          auths: { 'registry:5000': { auth: expectedAuth } },
        }),
      );
    });
  });

  describe('build without network (default Docker networking)', () => {
    it('spawns docker buildx build --push --progress=plain with correct args', async () => {
      await buildAndPush(makeRequest());

      expect(mockSpawn).toHaveBeenCalledWith(
        'docker',
        [
          '--config', '/tmp/build-ctx/.docker',
          'buildx', 'build', '--push',
          '--progress', 'plain',
          '-f', '/tmp/build-ctx/Dockerfile',
          '-t', 'registry:5000/plugin:p-test-abc123',
          '/tmp/build-ctx',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    });

    it('does not create a buildx builder', async () => {
      await buildAndPush(makeRequest());

      // execFileSync is used for builder setup — should NOT be called
      // when there is no network
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('returns the full image reference', async () => {
      const result = await buildAndPush(makeRequest());
      expect(result).toEqual({ fullImage: 'registry:5000/plugin:p-test-abc123' });
    });
  });

  describe('persistent builder lifecycle', () => {
    it('creates buildx builder on first build with network', async () => {
      const req = makeRequest({ registry: makeRegistry({ network: 'my_net' }) });
      await buildAndPush(req);

      const createCall = findBuildxCreateCall();
      expect(createCall).toBeDefined();
      expect(createCall).toContain('--driver');
      expect(createCall).toContain('docker-container');
      expect(createCall).toContain('--driver-opt');
      expect(createCall).toContain('network=my_net');
    });

    it('includes --builder flag in build command', async () => {
      const req = makeRequest({ registry: makeRegistry({ network: 'compose_default' }) });
      await buildAndPush(req);

      const spawnArgs = mockSpawn.mock.calls[0][1];
      expect(spawnArgs).toContain('--builder');
      expect(spawnArgs).toContain('plugin-builder');
    });

    it('reuses builder on subsequent builds with same network', async () => {
      const req = makeRequest({ registry: makeRegistry({ network: 'my_net' }) });

      // First build — creates the builder
      await buildAndPush(req);
      const createCountAfterFirst = mockExecFileSync.mock.calls
        .filter((c: any) => (c[1] as string[]).includes('create')).length;
      expect(createCountAfterFirst).toBe(1);

      // Clear mock call history but keep builder state
      jest.clearAllMocks();
      mockSpawn.mockImplementation(() => createMockChild(0));
      mockExecFileSync.mockReturnValue(Buffer.from(''));

      // Second build — should reuse (inspect succeeds, no create)
      await buildAndPush(req);
      const createCountAfterSecond = mockExecFileSync.mock.calls
        .filter((c: any) => (c[1] as string[]).includes('create')).length;
      expect(createCountAfterSecond).toBe(0);
    });

    it('recreates builder when network changes', async () => {
      // First build on net1
      const req1 = makeRequest({ registry: makeRegistry({ network: 'net1' }) });
      await buildAndPush(req1);

      jest.clearAllMocks();
      mockSpawn.mockImplementation(() => createMockChild(0));
      mockExecFileSync.mockReturnValue(Buffer.from(''));

      // Second build on net2 — should recreate
      const req2 = makeRequest({ registry: makeRegistry({ network: 'net2' }) });
      await buildAndPush(req2);

      const createCall = findBuildxCreateCall();
      expect(createCall).toBeDefined();
      expect(createCall).toContain('network=net2');
    });

    it('recreates builder when health check fails', async () => {
      const req = makeRequest({ registry: makeRegistry({ network: 'my_net' }) });

      // First build — creates the builder
      await buildAndPush(req);

      jest.clearAllMocks();
      mockSpawn.mockImplementation(() => createMockChild(0));
      // Make inspect (health check) fail
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (Array.isArray(args) && args.includes('inspect')) {
          throw new Error('builder not found');
        }
        return Buffer.from('');
      });

      // Second build — inspect fails, should recreate
      await buildAndPush(req);
      const createCall = findBuildxCreateCall();
      expect(createCall).toBeDefined();
    });

    it('writes buildkitd.toml with insecure=true by default', async () => {
      const req = makeRequest({ registry: makeRegistry({ network: 'net1' }) });
      await buildAndPush(req);

      const tomlCall = mockWriteFileSync.mock.calls.find(
        (c: any) => String(c[0]).includes('buildkitd.toml'),
      );
      expect(tomlCall).toBeDefined();
      expect(tomlCall![1]).toContain('insecure = true');
    });

    it('writes buildkitd.toml with insecure=false when registry config insecure=false', async () => {
      mockInsecure = false;
      const req = makeRequest({ registry: makeRegistry({ network: 'net1' }) });
      await buildAndPush(req);

      const tomlCall = mockWriteFileSync.mock.calls.find(
        (c: any) => String(c[0]).includes('buildkitd.toml'),
      );
      expect(tomlCall).toBeDefined();
      expect(tomlCall![1]).toContain('insecure = false');
    });

    it('writes buildkitd.toml with default DNS nameservers', async () => {
      delete process.env.BUILDKIT_DNS_NAMESERVERS;
      const req = makeRequest({ registry: makeRegistry({ network: 'net1' }) });
      await buildAndPush(req);

      const tomlCall = mockWriteFileSync.mock.calls.find(
        (c: any) => String(c[0]).includes('buildkitd.toml'),
      );
      expect(tomlCall).toBeDefined();
      expect(tomlCall![1]).toContain('[dns]');
      expect(tomlCall![1]).toContain('"8.8.8.8"');
      expect(tomlCall![1]).toContain('"8.8.4.4"');
    });

    it('writes buildkitd.toml with custom DNS nameservers from env', async () => {
      process.env.BUILDKIT_DNS_NAMESERVERS = '1.1.1.1,9.9.9.9';
      const req = makeRequest({ registry: makeRegistry({ network: 'net1' }) });
      await buildAndPush(req);

      const tomlCall = mockWriteFileSync.mock.calls.find(
        (c: any) => String(c[0]).includes('buildkitd.toml'),
      );
      expect(tomlCall).toBeDefined();
      expect(tomlCall![1]).toContain('"1.1.1.1"');
      expect(tomlCall![1]).toContain('"9.9.9.9"');
      delete process.env.BUILDKIT_DNS_NAMESERVERS;
    });

    it('does not tear down builder after successful build', async () => {
      const req = makeRequest({ registry: makeRegistry({ network: 'net1' }) });
      await buildAndPush(req);

      // After create, there should be no 'rm' call (only the force-rm during setup cleanup)
      const syncCalls = mockExecFileSync.mock.calls.map((c: any) => c[1] as string[]);
      const rmCallsAfterCreate = syncCalls.slice(
        syncCalls.findIndex((a: string[]) => a.includes('create')) + 1,
      ).filter((a: string[]) => a.includes('rm'));
      expect(rmCallsAfterCreate).toHaveLength(0);
    });

    it('does not tear down builder after build failure', async () => {
      mockSpawn.mockImplementation(() => createMockChild(1));

      const req = makeRequest({ registry: makeRegistry({ network: 'net1' }) });
      await expect(buildAndPush(req)).rejects.toThrow('Docker build failed with exit code 1');

      // No teardown rm after create
      const syncCalls = mockExecFileSync.mock.calls.map((c: any) => c[1] as string[]);
      const rmCallsAfterCreate = syncCalls.slice(
        syncCalls.findIndex((a: string[]) => a.includes('create')) + 1,
      ).filter((a: string[]) => a.includes('rm'));
      expect(rmCallsAfterCreate).toHaveLength(0);
    });
  });

  describe('destroyBuilder', () => {
    it('removes builder when one is active', async () => {
      // Create a builder first
      const req = makeRequest({ registry: makeRegistry({ network: 'net1' }) });
      await buildAndPush(req);

      jest.clearAllMocks();
      mockExecFileSync.mockReturnValue(Buffer.from(''));

      destroyBuilder();

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
        ['buildx', 'rm', '--force', 'plugin-builder'],
        { stdio: 'ignore' },
      );
    });

    it('is a no-op when no builder is active', () => {
      destroyBuilder();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('allows new builder creation after destroy', async () => {
      const req = makeRequest({ registry: makeRegistry({ network: 'net1' }) });
      await buildAndPush(req);
      destroyBuilder();

      jest.clearAllMocks();
      mockSpawn.mockImplementation(() => createMockChild(0));
      mockExecFileSync.mockReturnValue(Buffer.from(''));

      // Should create a fresh builder
      await buildAndPush(req);
      const createCall = findBuildxCreateCall();
      expect(createCall).toBeDefined();
    });
  });

  describe('buildArgs handling', () => {
    it('includes --build-arg flags in docker command', async () => {
      const req = makeRequest({
        buildArgs: { PYTHON_VERSION: '3.12' },
      });
      await buildAndPush(req);

      const spawnArgs = mockSpawn.mock.calls[0][1];
      expect(spawnArgs).toContain('--build-arg');
      expect(spawnArgs).toContain('PYTHON_VERSION=3.12');
    });

    it('includes multiple --build-arg flags', async () => {
      const req = makeRequest({
        buildArgs: { PYTHON_VERSION: '3.12', NODE_ENV: 'production' },
      });
      await buildAndPush(req);

      const spawnArgs = mockSpawn.mock.calls[0][1];
      const buildArgFlags = spawnArgs.filter((a: string) => a === '--build-arg');
      expect(buildArgFlags).toHaveLength(2);
      expect(spawnArgs).toContain('PYTHON_VERSION=3.12');
      expect(spawnArgs).toContain('NODE_ENV=production');
    });

    it('skips --build-arg when buildArgs is empty', async () => {
      const req = makeRequest({ buildArgs: {} });
      await buildAndPush(req);

      const spawnArgs = mockSpawn.mock.calls[0][1];
      expect(spawnArgs).not.toContain('--build-arg');
    });

    it('skips --build-arg when buildArgs is undefined', async () => {
      const req = makeRequest();
      await buildAndPush(req);

      const spawnArgs = mockSpawn.mock.calls[0][1];
      expect(spawnArgs).not.toContain('--build-arg');
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
        'Docker build failed with exit code 1',
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

    it('handles stale builder cleanup gracefully', async () => {
      // First execFileSync (inspect) throws — means no stale builder
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args.includes('inspect')) throw new Error('builder not found');
        return Buffer.from('');
      });

      const req = makeRequest({ registry: makeRegistry({ network: 'net1' }) });
      // Should not throw — the error is caught internally
      await expect(buildAndPush(req)).resolves.toBeDefined();
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
});
