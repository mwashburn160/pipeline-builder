// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Mock dependencies before imports
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { readFileSync as realReadFileSync } from 'node:fs';
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockExistsSync = jest.fn<AnyFn>();
const mockReadFileSync = jest.fn<AnyFn>();
const mockYamlParse = jest.fn<AnyFn>();

// A transitively-imported module (cli.constants) reads package.json from `fs`
// at load time. Pass those reads through to the real fs so module init works;
// individual tests override the mock with mockReturnValue/mockImplementation.
const passthroughPackageJson = (...args: unknown[]): unknown => {
  const first = args[0];
  const asStr = first instanceof URL ? first.href : String(first);
  if (asStr.includes('package.json')) {
    return realReadFileSync(args[0] as never, args[1] as never);
  }
  return undefined;
};
mockReadFileSync.mockImplementation(passthroughPackageJson as never);

// `statSync`/`mkdtempSync`/… are not used by config-loader itself, but mocking a
// core module replaces it for the WHOLE graph pulled in by the import below
// (api-core's service-keys reads a key file with statSync), so the stub has to
// carry every name that graph imports or the ESM link step fails.
const fsStub = {
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  statSync: jest.fn(() => ({ isFile: () => false, mode: 0o600, size: 0 })),
  mkdtempSync: jest.fn(() => '/tmp/pm-test'),
  writeFileSync: jest.fn<AnyFn>(),
  rmSync: jest.fn<AnyFn>(),
  mkdirSync: jest.fn<AnyFn>(),
};
jest.unstable_mockModule('fs', () => ({ __esModule: true, ...fsStub, default: fsStub }));
jest.unstable_mockModule('node:fs', () => ({ __esModule: true, ...fsStub, default: fsStub }));

jest.unstable_mockModule('yaml', () => ({
  __esModule: true,
  parse: mockYamlParse,
  default: { parse: mockYamlParse },
}));

const { getConfig, getApiConfig, getConfigWithOptions } = await import('../src/utils/config-loader.js');

// Environment helpers
const ENV_KEYS = [
  'PLATFORM_TOKEN', 'PLATFORM_BASE_URL', 'CLI_CONFIG_PATH',
  'TLS_REJECT_UNAUTHORIZED', 'UPLOAD_TIMEOUT', 'DEBUG', 'NODE_ENV',
] as const;

let savedEnv: Record<string, string | undefined>;

// Tests

describe('config.loader', () => {
  beforeEach(() => {
    // Save env
    savedEnv = {};
    ENV_KEYS.forEach((k) => { savedEnv[k] = process.env[k]; });

    // Reset mock implementations (but NOT restoreAllMocks — that un-does jest.mock auto-mocks)
    jest.resetAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore env
    Object.entries(savedEnv).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
  });

  describe('getConfig', () => {
    it('should return config with token from env', () => {
      process.env.PLATFORM_TOKEN = 'my-token';
      mockExistsSync.mockReturnValue(false);

      const config = getConfig();

      expect(config.auth.token).toBe('my-token');
      expect(config.api.baseUrl).toBe('https://localhost:8443');
    });

    it('should throw when there is neither a PLATFORM_TOKEN nor a stored session', () => {
      delete process.env.PLATFORM_TOKEN;
      mockExistsSync.mockReturnValue(false);

      expect(() => getConfig()).toThrow('pipeline-manager auth login');
    });

    it('falls back to the session `auth login` stored for this platform', () => {
      delete process.env.PLATFORM_TOKEN;
      process.env.PLATFORM_BASE_URL = 'https://api.example.com';
      mockExistsSync.mockReturnValue(false);
      // The credential store reads its own file through the same mocked `fs`.
      mockReadFileSync.mockImplementation(((p: unknown) => {
        if (String(p).includes('credentials.json')) {
          return JSON.stringify({
            version: 1,
            sessions: {
              'https://api.example.com': {
                accessToken: 'stored.session.jwt',
                expiresAt: Date.now() + 600_000,
                savedAt: new Date().toISOString(),
              },
            },
          });
        }
        return passthroughPackageJson(p);
      }) as never);

      expect(getConfig().auth.token).toBe('stored.session.jwt');
    });

    it('ignores a stored session whose access token has expired', () => {
      delete process.env.PLATFORM_TOKEN;
      process.env.PLATFORM_BASE_URL = 'https://api.example.com';
      mockExistsSync.mockReturnValue(false);
      mockReadFileSync.mockImplementation(((p: unknown) => {
        if (String(p).includes('credentials.json')) {
          return JSON.stringify({
            version: 1,
            sessions: {
              'https://api.example.com': { accessToken: 'stale.jwt', expiresAt: Date.now() - 1, savedAt: '' },
            },
          });
        }
        return passthroughPackageJson(p);
      }) as never);

      expect(() => getConfig()).toThrow('pipeline-manager auth login');
    });

    it('should throw when PLATFORM_TOKEN is empty', () => {
      process.env.PLATFORM_TOKEN = '   ';
      mockExistsSync.mockReturnValue(false);

      expect(() => getConfig()).toThrow('PLATFORM_TOKEN must be a non-empty string');
    });

    it('should use PLATFORM_BASE_URL from env', () => {
      process.env.PLATFORM_TOKEN = 'tok';
      process.env.PLATFORM_BASE_URL = 'https://api.example.com';
      // Use a config file so getConfig() creates a fresh api object
      // (avoids mutating the module-level defaultConfig via shallow copy)
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('');
      mockYamlParse.mockReturnValue({ api: {} });

      const config = getConfig();
      expect(config.api.baseUrl).toBe('https://api.example.com');
    });

    it('should merge config from YAML file', () => {
      process.env.PLATFORM_TOKEN = 'tok';
      process.env.CLI_CONFIG_PATH = '/custom/config.yml';
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('api:\n  baseUrl: https://custom.api');
      mockYamlParse.mockReturnValue({ api: { baseUrl: 'https://custom.api' } });

      const config = getConfig();
      expect(config.api.baseUrl).toBe('https://custom.api');
    });

    it('should ignore auth section in config file', () => {
      process.env.PLATFORM_TOKEN = 'tok';
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('');
      mockYamlParse.mockReturnValue({ api: {}, auth: { token: 'file-token' } });

      const config = getConfig();
      expect(config.auth.token).toBe('tok');
    });

    it('should handle TLS_REJECT_UNAUTHORIZED=0', () => {
      process.env.PLATFORM_TOKEN = 'tok';
      process.env.TLS_REJECT_UNAUTHORIZED = '0';
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('');
      mockYamlParse.mockReturnValue({ api: {} });

      const config = getConfig();
      expect(config.api.rejectUnauthorized).toBe(false);
    });

    it('should handle valid UPLOAD_TIMEOUT', () => {
      process.env.PLATFORM_TOKEN = 'tok';
      process.env.UPLOAD_TIMEOUT = '60000';
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('');
      mockYamlParse.mockReturnValue({ api: {} });

      const config = getConfig();
      expect(config.api.uploadTimeout).toBe(60000);
    });

    it('should ignore invalid UPLOAD_TIMEOUT', () => {
      process.env.PLATFORM_TOKEN = 'tok';
      process.env.UPLOAD_TIMEOUT = 'not-a-number';
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('');
      mockYamlParse.mockReturnValue({ api: {} });

      const config = getConfig();
      expect(config.api.uploadTimeout).toBeUndefined();
    });

    it('should fall back to defaults when config file fails to parse', () => {
      process.env.PLATFORM_TOKEN = 'tok';
      delete process.env.PLATFORM_BASE_URL;
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('');
      mockYamlParse.mockImplementation(() => { throw new Error('parse error'); });

      const config = getConfig();
      expect(config.api.baseUrl).toBe('https://localhost:8443');
    });
  });

  // The token-optional slice used by the pre-auth login step (ensurePlatformToken).
  describe('getApiConfig', () => {
    it('resolves the base URL WITHOUT requiring PLATFORM_TOKEN', () => {
      delete process.env.PLATFORM_TOKEN;
      process.env.PLATFORM_BASE_URL = 'https://api.example.com';
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('');
      mockYamlParse.mockReturnValue({ api: {} });

      // getConfig() would throw here — getApiConfig() must not.
      const config = getApiConfig();
      expect(config.api.baseUrl).toBe('https://api.example.com');
      expect((config as { auth?: unknown }).auth).toBeUndefined();
    });

    it('does not throw when PLATFORM_TOKEN is missing (unlike getConfig)', () => {
      delete process.env.PLATFORM_TOKEN;
      mockExistsSync.mockReturnValue(false);

      expect(() => getApiConfig()).not.toThrow();
      expect(() => getConfig()).toThrow('pipeline-manager auth login');
    });

    it('honors TLS_REJECT_UNAUTHORIZED=0 without a token', () => {
      delete process.env.PLATFORM_TOKEN;
      process.env.TLS_REJECT_UNAUTHORIZED = '0';
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('');
      mockYamlParse.mockReturnValue({ api: {} });

      expect(getApiConfig().api.rejectUnauthorized).toBe(false);
    });
  });

  // getConfigWithOptions is the chokepoint every authenticated command flows its
  // Bearer JWT through — the --no-verify-ssl SSL-disable path must refuse in prod.
  describe('getConfigWithOptions (--no-verify-ssl guard)', () => {
    beforeEach(() => {
      process.env.PLATFORM_TOKEN = 'tok';
      mockExistsSync.mockReturnValue(false);
    });

    it('disables SSL when verifySsl:false in non-production', () => {
      process.env.NODE_ENV = 'development';
      expect(getConfigWithOptions({ verifySsl: false }).api.rejectUnauthorized).toBe(false);
    });

    it('THROWS when verifySsl:false in production (never returns an SSL-disabled config)', () => {
      process.env.NODE_ENV = 'production';
      expect(() => getConfigWithOptions({ verifySsl: false })).toThrow(/production/i);
    });

    it('leaves SSL enabled (no throw) when verifySsl is not false, even in production', () => {
      process.env.NODE_ENV = 'production';
      expect(getConfigWithOptions({}).api.rejectUnauthorized).toBe(true);
      expect(getConfigWithOptions({ verifySsl: true }).api.rejectUnauthorized).toBe(true);
    });
  });

});
