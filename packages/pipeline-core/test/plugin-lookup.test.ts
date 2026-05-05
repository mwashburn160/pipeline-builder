// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Mock CDK and heavy dependencies before imports
const mockNodejsFunction = jest.fn().mockImplementation(() => ({
  addToRolePolicy: jest.fn(),
}));
const mockLogGroup = jest.fn();
const mockProvider = jest.fn().mockImplementation(() => ({
  serviceToken: 'arn:aws:lambda:us-east-1:123456789:function:provider',
}));
const mockCustomResource = jest.fn().mockImplementation(() => ({
  getAttString: jest.fn().mockReturnValue('unresolved-token'),
}));

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  AccessModifier: { PUBLIC: 'public', PRIVATE: 'private' },
  ComputeType: { SMALL: 'SMALL', MEDIUM: 'MEDIUM', LARGE: 'LARGE', X2_LARGE: 'X2_LARGE' },
  PluginType: { CODE_BUILD_STEP: 'CodeBuildStep', SHELL_STEP: 'ShellStep', MANUAL_APPROVAL_STEP: 'ManualApprovalStep' },
}));

jest.mock('aws-cdk-lib/aws-codebuild', () => ({
  BuildEnvironmentVariableType: { PLAINTEXT: 'PLAINTEXT', SECRETS_MANAGER: 'SECRETS_MANAGER', PARAMETER_STORE: 'PARAMETER_STORE' },
  ComputeType: { SMALL: 'BUILD_GENERAL1_SMALL', MEDIUM: 'BUILD_GENERAL1_MEDIUM', LARGE: 'BUILD_GENERAL1_LARGE', X2_LARGE: 'BUILD_GENERAL1_2XLARGE' },
  LinuxBuildImage: { STANDARD_7_0: 'aws/codebuild/standard:7.0' },
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
  Runtime: { NODEJS_24_X: 'nodejs24.x' },
  Architecture: { ARM_64: 'arm64' },
}));

jest.mock('aws-cdk-lib/aws-lambda-nodejs', () => ({
  NodejsFunction: mockNodejsFunction,
}));

// LogGroup needs both the constructor stub AND the static `fromLogGroupName`
// adopt-or-pass-through method (used for collision-resilient log group
// references — see plugin-lookup.ts header).
const mockLogGroupFromName = jest.fn().mockImplementation((_scope: unknown, _id: unknown, name: string) => ({
  logGroupName: name,
  logGroupArn: `arn:aws:logs:us-east-1:123456789:log-group:${name}`,
}));
(mockLogGroup as unknown as { fromLogGroupName: typeof mockLogGroupFromName }).fromLogGroupName = mockLogGroupFromName;

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
import { UniqueId } from '../src/core/id-generator';
import { PluginLookup } from '../src/pipeline/plugin-lookup';

// Minimal mock scope
const mockScope = {} as any;

function createUniqueId(): UniqueId {
  return new UniqueId();
}

describe('PluginLookup', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, CREDENTIALS_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789:secret:test-AbCdEf' };

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
        orgId: 'test-org',
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
        orgId: 'test-org',
        project: '',
        platformUrl: 'https://api.example.com',
        uniqueId: createUniqueId(),
      })).toThrow('Both organization and project are required');
    });
  });

  describe('credential security', () => {
    it('should not embed plaintext credentials in Lambda environment', () => {
      new PluginLookup(mockScope, 'TestLookup', {
        organization: 'my-org',
        orgId: 'test-org',
        project: 'my-project',
        platformUrl: 'https://api.example.com',
        uniqueId: createUniqueId(),
      });

      const callArgs = mockNodejsFunction.mock.calls[0][2];
      const env = callArgs.environment || {};
      expect(env).not.toHaveProperty('PLATFORM_EMAIL');
      expect(env).not.toHaveProperty('PLATFORM_PASSWORD');
      expect(env).not.toHaveProperty('PLATFORM_BASE_URL');
    });

    it('should grant Secrets Manager read access via IAM policy', () => {
      new PluginLookup(mockScope, 'TestLookup', {
        organization: 'my-org',
        orgId: 'test-org',
        project: 'my-project',
        platformUrl: 'https://api.example.com',
        uniqueId: createUniqueId(),
      });

      // The mock NodejsFunction should have addToRolePolicy called
      const fnInstance = mockNodejsFunction.mock.results[0].value;
      expect(fnInstance.addToRolePolicy).toHaveBeenCalled();
    });
  });

  describe('plugin()', () => {
    it('should return fallback when token is unresolved during synth', () => {
      (Token.isUnresolved as jest.Mock).mockReturnValue(true);

      const lookup = new PluginLookup(mockScope, 'TestLookup', {
        organization: 'my-org',
        orgId: 'test-org',
        project: 'my-project',
        platformUrl: 'https://api.example.com',
        uniqueId: createUniqueId(),
      });

      const result = lookup.plugin('nodejs-build');

      expect(result.name).toBe('fallback');
      expect(result.primaryOutputDirectory).toBe('cdk.out');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toContain('FALLBACK');
    });

    it('should normalize string plugin to PluginOptions', () => {
      (Token.isUnresolved as jest.Mock).mockReturnValue(true);

      const lookup = new PluginLookup(mockScope, 'TestLookup', {
        organization: 'my-org',
        orgId: 'test-org',
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
        orgId: 'test-org',
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
        orgId: 'test-org',
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
        orgId: 'test-org',
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
        orgId: 'test-org',
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
        orgId: 'test-org',
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
        orgId: 'test-org',
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
        orgId: 'test-org',
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

    it('should enable minification and exclude AWS SDK from bundle', () => {
      new PluginLookup(mockScope, 'TestLookup', {
        organization: 'my-org',
        orgId: 'test-org',
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
            sourceMap: false,
            target: 'es2022',
            externalModules: ['@aws-sdk/*'],
          }),
        }),
      );
    });
  });
});
