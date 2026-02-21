// ---------------------------------------------------------------------------
// Mock dependencies before imports
// ---------------------------------------------------------------------------
jest.mock('fs');
jest.mock('yaml');

import * as fs from 'fs';
import * as yaml from 'yaml';
import { getConfig, getToken, hasToken } from '../src/utils/config.loader';

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------
const ENV_KEYS = [
  'PLATFORM_TOKEN', 'PLATFORM_BASE_URL', 'CLI_CONFIG_PATH',
  'TLS_REJECT_UNAUTHORIZED', 'UPLOAD_TIMEOUT', 'DEBUG',
] as const;

let savedEnv: Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('config.loader', () => {
  beforeEach(() => {
    // Save env
    savedEnv = {};
    ENV_KEYS.forEach((k) => { savedEnv[k] = process.env[k]; });

    // Reset mock implementations (but NOT restoreAllMocks — that un-does jest.mock auto-mocks)
    jest.resetAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
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
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const config = getConfig();

      expect(config.auth.token).toBe('my-token');
      expect(config.api.baseUrl).toBe('https://localhost:8443');
    });

    it('should throw when PLATFORM_TOKEN is not set', () => {
      delete process.env.PLATFORM_TOKEN;
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      expect(() => getConfig()).toThrow('PLATFORM_TOKEN environment variable is required');
    });

    it('should throw when PLATFORM_TOKEN is empty', () => {
      process.env.PLATFORM_TOKEN = '   ';
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      expect(() => getConfig()).toThrow('PLATFORM_TOKEN must be a non-empty string');
    });

    it('should use PLATFORM_BASE_URL from env', () => {
      process.env.PLATFORM_TOKEN = 'tok';
      process.env.PLATFORM_BASE_URL = 'https://api.example.com';
      // Use a config file so getConfig() creates a fresh api object
      // (avoids mutating the module-level defaultConfig via shallow copy)
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue('');
      (yaml.parse as jest.Mock).mockReturnValue({ api: {} });

      const config = getConfig();
      expect(config.api.baseUrl).toBe('https://api.example.com');
    });

    it('should merge config from YAML file', () => {
      process.env.PLATFORM_TOKEN = 'tok';
      process.env.CLI_CONFIG_PATH = '/custom/config.yml';
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue('api:\n  baseUrl: https://custom.api');
      (yaml.parse as jest.Mock).mockReturnValue({ api: { baseUrl: 'https://custom.api' } });

      const config = getConfig();
      expect(config.api.baseUrl).toBe('https://custom.api');
    });

    it('should ignore auth section in config file', () => {
      process.env.PLATFORM_TOKEN = 'tok';
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue('');
      (yaml.parse as jest.Mock).mockReturnValue({ api: {}, auth: { token: 'file-token' } });

      const config = getConfig();
      expect(config.auth.token).toBe('tok');
    });

    it('should handle TLS_REJECT_UNAUTHORIZED=0', () => {
      process.env.PLATFORM_TOKEN = 'tok';
      process.env.TLS_REJECT_UNAUTHORIZED = '0';
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue('');
      (yaml.parse as jest.Mock).mockReturnValue({ api: {} });

      const config = getConfig();
      expect(config.api.rejectUnauthorized).toBe(false);
    });

    it('should handle valid UPLOAD_TIMEOUT', () => {
      process.env.PLATFORM_TOKEN = 'tok';
      process.env.UPLOAD_TIMEOUT = '60000';
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue('');
      (yaml.parse as jest.Mock).mockReturnValue({ api: {} });

      const config = getConfig();
      expect(config.api.uploadTimeout).toBe(60000);
    });

    it('should ignore invalid UPLOAD_TIMEOUT', () => {
      process.env.PLATFORM_TOKEN = 'tok';
      process.env.UPLOAD_TIMEOUT = 'not-a-number';
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue('');
      (yaml.parse as jest.Mock).mockReturnValue({ api: {} });

      const config = getConfig();
      expect(config.api.uploadTimeout).toBeUndefined();
    });

    it('should fall back to defaults when config file fails to parse', () => {
      process.env.PLATFORM_TOKEN = 'tok';
      delete process.env.PLATFORM_BASE_URL;
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue('');
      (yaml.parse as jest.Mock).mockImplementation(() => { throw new Error('parse error'); });

      const config = getConfig();
      expect(config.api.baseUrl).toBe('https://localhost:8443');
    });
  });

  describe('getToken', () => {
    it('should return token from env', () => {
      process.env.PLATFORM_TOKEN = 'test-token';
      expect(getToken()).toBe('test-token');
    });

    it('should throw when token is not set', () => {
      delete process.env.PLATFORM_TOKEN;
      expect(() => getToken()).toThrow('PLATFORM_TOKEN environment variable is required');
    });
  });

  describe('hasToken', () => {
    it('should return true when token is set', () => {
      process.env.PLATFORM_TOKEN = 'some-token';
      expect(hasToken()).toBe(true);
    });

    it('should return false when token is not set', () => {
      delete process.env.PLATFORM_TOKEN;
      expect(hasToken()).toBe(false);
    });

    it('should return false for empty string', () => {
      process.env.PLATFORM_TOKEN = '';
      expect(hasToken()).toBe(false);
    });
  });
});
