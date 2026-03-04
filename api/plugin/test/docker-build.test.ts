/**
 * Tests for helpers/docker-build.
 *
 * Mocks child_process (execFile, execFileSync) and fs to verify
 * build command construction, input validation, and cleanup logic.
 */

// Mocks — must be defined before imports

const mockExecFile = jest.fn();
const mockExecFileSync = jest.fn();

jest.mock('child_process', () => ({
  execFile: mockExecFile,
  execFileSync: mockExecFileSync,
}));

jest.mock('util', () => ({
  promisify: (fn: Function) => fn,
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
    DOCKER_BUILD_TIMEOUT_MS: 300000,
  },
  Config: {
    get: (section: string) => {
      if (section === 'registry') return { insecure: mockInsecure };
      return {};
    },
  },
}));

import { buildAndPush, type BuildRequest, type RegistryInfo } from '../src/helpers/docker-build';

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

// Tests

describe('docker-build', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: execFile resolves successfully (promisified version)
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
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
    it('invokes docker buildx build --push with correct args', async () => {
      await buildAndPush(makeRequest());

      expect(mockExecFile).toHaveBeenCalledWith(
        'docker',
        [
          '--config', '/tmp/build-ctx/.docker',
          'buildx', 'build', '--push',
          '-f', '/tmp/build-ctx/Dockerfile',
          '-t', 'registry:5000/plugin:p-test-abc123',
          '/tmp/build-ctx',
        ],
        { timeout: 300_000 },
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

  describe('build with network (compose environment)', () => {
    it('creates buildx builder with docker-container driver', async () => {
      const req = makeRequest({ registry: makeRegistry({ network: 'my_net' }) });
      await buildAndPush(req);

      // Should call execFileSync for builder setup: inspect, rm, create
      const syncCalls = mockExecFileSync.mock.calls.map((c: any) => c[1]);

      // Look for the 'buildx create' call
      const createCall = syncCalls.find(
        (args: string[]) => args.includes('buildx') && args.includes('create'),
      );
      expect(createCall).toBeDefined();
      expect(createCall).toContain('--driver');
      expect(createCall).toContain('docker-container');
      expect(createCall).toContain('--driver-opt');
      expect(createCall).toContain('network=my_net');
    });

    it('includes --builder flag in build command', async () => {
      const req = makeRequest({ registry: makeRegistry({ network: 'compose_default' }) });
      await buildAndPush(req);

      const buildArgs = mockExecFile.mock.calls[0][1];
      expect(buildArgs).toContain('--builder');
      expect(buildArgs).toContain('plugin-builder');
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

    it('tears down builder after build (even on success)', async () => {
      const req = makeRequest({ registry: makeRegistry({ network: 'net1' }) });
      await buildAndPush(req);

      // Last execFileSync call should be builder removal (teardown)
      const syncCalls = mockExecFileSync.mock.calls;
      const lastCall = syncCalls[syncCalls.length - 1];
      expect(lastCall[1]).toEqual(
        expect.arrayContaining(['buildx', 'rm', 'plugin-builder']),
      );
    });

    it('tears down builder after build failure', async () => {
      mockExecFile.mockRejectedValue(new Error('Build failed'));

      const req = makeRequest({ registry: makeRegistry({ network: 'net1' }) });
      await expect(buildAndPush(req)).rejects.toThrow('Build failed');

      // Teardown should still happen
      const syncCalls = mockExecFileSync.mock.calls;
      const lastCall = syncCalls[syncCalls.length - 1];
      expect(lastCall[1]).toEqual(
        expect.arrayContaining(['buildx', 'rm', 'plugin-builder']),
      );
    });
  });

  describe('buildArgs handling', () => {
    it('includes --build-arg flags in docker command', async () => {
      const req = makeRequest({
        buildArgs: { PYTHON_VERSION: '3.12' },
      });
      await buildAndPush(req);

      const buildArgs = mockExecFile.mock.calls[0][1];
      expect(buildArgs).toContain('--build-arg');
      expect(buildArgs).toContain('PYTHON_VERSION=3.12');
    });

    it('includes multiple --build-arg flags', async () => {
      const req = makeRequest({
        buildArgs: { PYTHON_VERSION: '3.12', NODE_ENV: 'production' },
      });
      await buildAndPush(req);

      const buildArgs = mockExecFile.mock.calls[0][1];
      const buildArgFlags = buildArgs.filter((a: string) => a === '--build-arg');
      expect(buildArgFlags).toHaveLength(2);
      expect(buildArgs).toContain('PYTHON_VERSION=3.12');
      expect(buildArgs).toContain('NODE_ENV=production');
    });

    it('skips --build-arg when buildArgs is empty', async () => {
      const req = makeRequest({ buildArgs: {} });
      await buildAndPush(req);

      const buildArgs = mockExecFile.mock.calls[0][1];
      expect(buildArgs).not.toContain('--build-arg');
    });

    it('skips --build-arg when buildArgs is undefined', async () => {
      const req = makeRequest();
      await buildAndPush(req);

      const buildArgs = mockExecFile.mock.calls[0][1];
      expect(buildArgs).not.toContain('--build-arg');
    });

    it('places --build-arg flags before -f flag', async () => {
      const req = makeRequest({ buildArgs: { VERSION: '1.0' } });
      await buildAndPush(req);

      const args = mockExecFile.mock.calls[0][1];
      const buildArgIdx = args.indexOf('--build-arg');
      const fIdx = args.indexOf('-f');
      expect(buildArgIdx).toBeGreaterThan(-1);
      expect(buildArgIdx).toBeLessThan(fIdx);
    });
  });

  describe('error handling', () => {
    it('throws when Docker build fails', async () => {
      mockExecFile.mockRejectedValue(new Error('docker: build failed with exit code 1'));

      await expect(buildAndPush(makeRequest())).rejects.toThrow(
        'docker: build failed with exit code 1',
      );
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
});
