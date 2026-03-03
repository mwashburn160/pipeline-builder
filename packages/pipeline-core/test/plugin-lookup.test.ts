// Mock CDK and heavy dependencies before imports
const mockNodejsFunction = jest.fn();
const mockLogGroup = jest.fn();
const mockProvider = jest.fn().mockImplementation(() => ({
  serviceToken: 'arn:aws:lambda:us-east-1:123456789:function:provider',
}));
const mockCustomResource = jest.fn().mockImplementation(() => ({
  getAttString: jest.fn().mockReturnValue('unresolved-token'),
}));

jest.mock('@mwashburn160/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.mock('aws-cdk-lib', () => ({
  CustomResource: mockCustomResource,
  Token: {
    isUnresolved: jest.fn().mockReturnValue(true),
  },
  Duration: {
    seconds: jest.fn((s: number) => ({ toSeconds: () => s })),
    minutes: jest.fn((m: number) => ({ toMinutes: () => m })),
  },
  RemovalPolicy: { DESTROY: 'DESTROY' },
}));

jest.mock('aws-cdk-lib/aws-lambda', () => ({
  Runtime: { NODEJS_22_X: 'nodejs22.x' },
  Architecture: { ARM_64: 'arm64' },
}));

jest.mock('aws-cdk-lib/aws-lambda-nodejs', () => ({
  NodejsFunction: mockNodejsFunction,
}));

jest.mock('aws-cdk-lib/aws-logs', () => ({
  LogGroup: mockLogGroup,
  RetentionDays: { ONE_WEEK: 7, ONE_MONTH: 30 },
}));

jest.mock('aws-cdk-lib/custom-resources', () => ({
  Provider: mockProvider,
}));

jest.mock('constructs', () => ({
  Construct: jest.fn(),
}));

import { Token } from 'aws-cdk-lib';
import { PluginLookup } from '../src/pipeline/plugin-lookup';
import { UniqueId } from '../src/core/id-generator';

// Minimal mock scope
const mockScope = {} as any;

function createUniqueId(): UniqueId {
  return new UniqueId();
}

describe('PluginLookup', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, PLATFORM_TOKEN: 'test-jwt-token' };

    // Reset the mock to return the provider shape
    mockProvider.mockImplementation(() => ({
      serviceToken: 'arn:aws:lambda:us-east-1:123456789:function:provider',
    }));

    // Default: Token.isUnresolved returns true (synth-time behavior)
    (Token.isUnresolved as jest.Mock).mockReturnValue(true);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('constructor', () => {
    it('should create construct with valid props', () => {
      expect(() => new PluginLookup(mockScope, 'TestLookup', {
        organization: 'my-org',
        project: 'my-project',
        platformUrl: 'https://api.example.com',
        uniqueId: createUniqueId(),
      })).not.toThrow();
    });

    it('should throw if organization is missing', () => {
      expect(() => new PluginLookup(mockScope, 'TestLookup', {
        organization: '',
        project: 'my-project',
        platformUrl: 'https://api.example.com',
        uniqueId: createUniqueId(),
      })).toThrow('Both organization and project are required');
    });

    it('should throw if project is missing', () => {
      expect(() => new PluginLookup(mockScope, 'TestLookup', {
        organization: 'my-org',
        project: '',
        platformUrl: 'https://api.example.com',
        uniqueId: createUniqueId(),
      })).toThrow('Both organization and project are required');
    });
  });

  describe('PLATFORM_TOKEN validation', () => {
    it('should throw if PLATFORM_TOKEN is not set', () => {
      delete process.env.PLATFORM_TOKEN;

      expect(() => new PluginLookup(mockScope, 'TestLookup', {
        organization: 'my-org',
        project: 'my-project',
        platformUrl: 'https://api.example.com',
        uniqueId: createUniqueId(),
      })).toThrow('PLATFORM_TOKEN environment variable is not set');
    });

    it('should throw if PLATFORM_TOKEN is empty string', () => {
      process.env.PLATFORM_TOKEN = '';

      expect(() => new PluginLookup(mockScope, 'TestLookup', {
        organization: 'my-org',
        project: 'my-project',
        platformUrl: 'https://api.example.com',
        uniqueId: createUniqueId(),
      })).toThrow('PLATFORM_TOKEN environment variable is not set');
    });

    it('should pass PLATFORM_TOKEN to Lambda environment', () => {
      process.env.PLATFORM_TOKEN = 'my-secret-jwt';

      new PluginLookup(mockScope, 'TestLookup', {
        organization: 'my-org',
        project: 'my-project',
        platformUrl: 'https://api.example.com',
        uniqueId: createUniqueId(),
      });

      expect(mockNodejsFunction).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.objectContaining({
          environment: { PLATFORM_TOKEN: 'my-secret-jwt' },
        }),
      );
    });

    it('should NOT pass PLATFORM_BASE_URL to Lambda environment', () => {
      new PluginLookup(mockScope, 'TestLookup', {
        organization: 'my-org',
        project: 'my-project',
        platformUrl: 'https://api.example.com',
        uniqueId: createUniqueId(),
      });

      const envArg = mockNodejsFunction.mock.calls[0][2].environment;
      expect(envArg).not.toHaveProperty('PLATFORM_BASE_URL');
    });
  });

  describe('plugin()', () => {
    it('should return fallback when token is unresolved during synth', () => {
      (Token.isUnresolved as jest.Mock).mockReturnValue(true);

      const lookup = new PluginLookup(mockScope, 'TestLookup', {
        organization: 'my-org',
        project: 'my-project',
        platformUrl: 'https://api.example.com',
        uniqueId: createUniqueId(),
      });

      const result = lookup.plugin('nodejs-build');

      expect(result.name).toBe('no_pluginname');
      expect(result.commands).toEqual([]);
    });

    it('should normalize string plugin to PluginOptions', () => {
      (Token.isUnresolved as jest.Mock).mockReturnValue(true);

      const lookup = new PluginLookup(mockScope, 'TestLookup', {
        organization: 'my-org',
        project: 'my-project',
        platformUrl: 'https://api.example.com',
        uniqueId: createUniqueId(),
      });

      lookup.plugin('my-plugin');

      // CustomResource should have been called with the normalized filter
      expect(mockCustomResource).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.objectContaining({
          properties: expect.objectContaining({
            pluginFilter: { name: 'my-plugin', isActive: true, isDefault: true },
          }),
        }),
      );
    });

    it('should use provided filter from PluginOptions', () => {
      (Token.isUnresolved as jest.Mock).mockReturnValue(true);

      const lookup = new PluginLookup(mockScope, 'TestLookup', {
        organization: 'my-org',
        project: 'my-project',
        platformUrl: 'https://api.example.com',
        uniqueId: createUniqueId(),
      });

      const customFilter = { name: 'my-plugin', version: '2.0.0', isActive: true };
      lookup.plugin({ name: 'my-plugin', filter: customFilter });

      expect(mockCustomResource).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.objectContaining({
          properties: expect.objectContaining({
            pluginFilter: customFilter,
          }),
        }),
      );
    });

    it('should pass platformUrl as baseURL to custom resource', () => {
      (Token.isUnresolved as jest.Mock).mockReturnValue(true);

      const lookup = new PluginLookup(mockScope, 'TestLookup', {
        organization: 'my-org',
        project: 'my-project',
        platformUrl: 'https://my-platform.example.com',
        uniqueId: createUniqueId(),
      });

      lookup.plugin('test-plugin');

      expect(mockCustomResource).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.objectContaining({
          properties: expect.objectContaining({
            baseURL: 'https://my-platform.example.com',
          }),
        }),
      );
    });

    it('should parse base64-encoded resolved plugin data', () => {
      const pluginData = {
        name: 'nodejs-build',
        version: '1.0.0',
        commands: ['npm ci'],
      };
      const encoded = Buffer.from(JSON.stringify(pluginData)).toString('base64');

      (Token.isUnresolved as jest.Mock).mockReturnValue(false);
      mockCustomResource.mockImplementation(() => ({
        getAttString: jest.fn().mockReturnValue(encoded),
      }));

      const lookup = new PluginLookup(mockScope, 'TestLookup', {
        organization: 'my-org',
        project: 'my-project',
        platformUrl: 'https://api.example.com',
        uniqueId: createUniqueId(),
      });

      const result = lookup.plugin('nodejs-build');

      expect(result.name).toBe('nodejs-build');
      expect(result.version).toBe('1.0.0');
      expect(result.commands).toEqual(['npm ci']);
    });

    it('should throw on invalid plugin data (missing name)', () => {
      const badData = { version: '1.0.0', commands: ['npm ci'] };
      const encoded = Buffer.from(JSON.stringify(badData)).toString('base64');

      (Token.isUnresolved as jest.Mock).mockReturnValue(false);
      mockCustomResource.mockImplementation(() => ({
        getAttString: jest.fn().mockReturnValue(encoded),
      }));

      const lookup = new PluginLookup(mockScope, 'TestLookup', {
        organization: 'my-org',
        project: 'my-project',
        platformUrl: 'https://api.example.com',
        uniqueId: createUniqueId(),
      });

      expect(() => lookup.plugin('nodejs-build')).toThrow('missing required fields');
    });

    it('should throw on invalid plugin data (missing commands)', () => {
      const badData = { name: 'nodejs-build', version: '1.0.0' };
      const encoded = Buffer.from(JSON.stringify(badData)).toString('base64');

      (Token.isUnresolved as jest.Mock).mockReturnValue(false);
      mockCustomResource.mockImplementation(() => ({
        getAttString: jest.fn().mockReturnValue(encoded),
      }));

      const lookup = new PluginLookup(mockScope, 'TestLookup', {
        organization: 'my-org',
        project: 'my-project',
        platformUrl: 'https://api.example.com',
        uniqueId: createUniqueId(),
      });

      expect(() => lookup.plugin('nodejs-build')).toThrow('missing required fields');
    });

    it('should throw on invalid base64 data', () => {
      (Token.isUnresolved as jest.Mock).mockReturnValue(false);
      mockCustomResource.mockImplementation(() => ({
        getAttString: jest.fn().mockReturnValue('not-valid-base64!!!'),
      }));

      const lookup = new PluginLookup(mockScope, 'TestLookup', {
        organization: 'my-org',
        project: 'my-project',
        platformUrl: 'https://api.example.com',
        uniqueId: createUniqueId(),
      });

      expect(() => lookup.plugin('nodejs-build')).toThrow('Failed to parse plugin');
    });
  });

  describe('Lambda function configuration', () => {
    it('should use ARM_64 architecture', () => {
      new PluginLookup(mockScope, 'TestLookup', {
        organization: 'my-org',
        project: 'my-project',
        platformUrl: 'https://api.example.com',
        uniqueId: createUniqueId(),
      });

      expect(mockNodejsFunction).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.objectContaining({
          architecture: 'arm64',
        }),
      );
    });

    it('should enable minification and source maps', () => {
      new PluginLookup(mockScope, 'TestLookup', {
        organization: 'my-org',
        project: 'my-project',
        platformUrl: 'https://api.example.com',
        uniqueId: createUniqueId(),
      });

      expect(mockNodejsFunction).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.objectContaining({
          bundling: expect.objectContaining({
            minify: true,
            sourceMap: true,
            target: 'es2022',
          }),
        }),
      );
    });
  });
});
