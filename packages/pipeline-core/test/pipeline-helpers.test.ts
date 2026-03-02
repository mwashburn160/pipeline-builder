// Mock heavy dependencies to avoid open handles from CDK/Winston in test workers
const mockCodeBuildStep = jest.fn();
const mockShellStep = jest.fn();
const mockManualApprovalStep = jest.fn();

jest.mock('@mwashburn160/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));
jest.mock('aws-cdk-lib', () => ({
  Duration: { minutes: jest.fn(), seconds: jest.fn() },
  SecretValue: { plainText: jest.fn((v: string) => v) },
}));
jest.mock('aws-cdk-lib/aws-codebuild', () => ({
  ComputeType: { SMALL: 'SMALL', MEDIUM: 'MEDIUM', LARGE: 'LARGE' },
  BuildEnvironmentVariableType: { PLAINTEXT: 'PLAINTEXT', SECRETS_MANAGER: 'SECRETS_MANAGER' },
}));
jest.mock('aws-cdk-lib/pipelines', () => ({
  CodeBuildStep: mockCodeBuildStep,
  ShellStep: mockShellStep,
  ManualApprovalStep: mockManualApprovalStep,
}));
jest.mock('aws-cdk-lib/aws-ec2', () => ({
  SubnetType: {
    PRIVATE_WITH_EGRESS: 'PRIVATE_WITH_EGRESS',
    PRIVATE_WITH_NAT: 'PRIVATE_WITH_NAT',
    PRIVATE_ISOLATED: 'PRIVATE_ISOLATED',
    PUBLIC: 'PUBLIC',
  },
  Vpc: { fromLookup: jest.fn() },
  SecurityGroup: { fromSecurityGroupId: jest.fn() },
  Subnet: { fromSubnetId: jest.fn() },
}));
jest.mock('constructs', () => ({ Construct: jest.fn() }));
jest.mock('../src/core/metadata-builder', () => ({
  MetadataBuilder: {
    from: jest.fn(() => ({
      forCodeBuildStep: jest.fn(() => ({})),
      forShellStep: jest.fn(() => ({})),
      forBuildEnvironment: jest.fn(() => ({})),
    })),
  },
}));
jest.mock('../src/core/network', () => ({
  resolveNetwork: jest.fn(() => ({})),
}));

import { merge, replaceNonAlphanumeric, extractMetadataEnv } from '../src/core/pipeline-helpers';

describe('merge', () => {
  it('should merge multiple metadata objects', () => {
    const a = { key1: 'val1' };
    const b = { key2: 'val2' };
    expect(merge(a, b)).toEqual({ key1: 'val1', key2: 'val2' });
  });

  it('should override earlier values with later ones', () => {
    const a = { key: 'old' };
    const b = { key: 'new' };
    expect(merge(a, b)).toEqual({ key: 'new' });
  });

  it('should handle empty objects', () => {
    expect(merge({}, {})).toEqual({});
  });

  it('should handle single source', () => {
    expect(merge({ key: 'val' })).toEqual({ key: 'val' });
  });

  it('should handle three or more sources', () => {
    const result = merge({ a: 1 }, { b: 2 }, { c: 3 });
    expect(result).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('should not mutate original objects', () => {
    const a = { key: 'val' };
    const b = { key: 'new' };
    merge(a, b);
    expect(a.key).toBe('val');
  });
});

describe('replaceNonAlphanumeric', () => {
  it('should replace non-alphanumeric characters with underscore by default', () => {
    expect(replaceNonAlphanumeric('hello-world')).toBe('hello_world');
    expect(replaceNonAlphanumeric('my.plugin')).toBe('my_plugin');
  });

  it('should replace with custom value', () => {
    expect(replaceNonAlphanumeric('hello-world', '-')).toBe('hello-world');
    expect(replaceNonAlphanumeric('a/b/c', '.')).toBe('a.b.c');
  });

  it('should replace spaces and special characters', () => {
    expect(replaceNonAlphanumeric('hello world!')).toBe('hello_world_');
    expect(replaceNonAlphanumeric('a@b#c$d')).toBe('a_b_c_d');
  });

  it('should leave alphanumeric characters unchanged', () => {
    expect(replaceNonAlphanumeric('abc123')).toBe('abc123');
    expect(replaceNonAlphanumeric('ABC123')).toBe('ABC123');
  });

  it('should handle empty string', () => {
    expect(replaceNonAlphanumeric('')).toBe('');
  });
});

describe('extractMetadataEnv', () => {
  it('should extract non-namespaced keys as string env vars', () => {
    const metadata = {
      PYTHON_VERSION: '3.12',
      WORKDIR: './',
      NODE_ENV: 'production',
    };
    expect(extractMetadataEnv(metadata)).toEqual({
      PYTHON_VERSION: '3.12',
      WORKDIR: './',
      NODE_ENV: 'production',
    });
  });

  it('should exclude aws:cdk: prefixed keys', () => {
    const metadata = {
      'PYTHON_VERSION': '3.12',
      'aws:cdk:pipelines:codepipeline:selfmutation': true,
      'aws:cdk:codebuild:buildenvironment:privileged': true,
    };
    expect(extractMetadataEnv(metadata)).toEqual({
      PYTHON_VERSION: '3.12',
    });
  });

  it('should convert boolean values to strings', () => {
    const metadata = { ENABLE_CACHE: true, VERBOSE: false };
    expect(extractMetadataEnv(metadata)).toEqual({
      ENABLE_CACHE: 'true',
      VERBOSE: 'false',
    });
  });

  it('should convert number values to strings', () => {
    const metadata = { MAX_RETRIES: 3, TIMEOUT: 300 };
    expect(extractMetadataEnv(metadata)).toEqual({
      MAX_RETRIES: '3',
      TIMEOUT: '300',
    });
  });

  it('should return empty object for empty metadata', () => {
    expect(extractMetadataEnv({})).toEqual({});
  });

  it('should return empty object when all keys are namespaced', () => {
    const metadata = {
      'aws:cdk:pipelines:codepipeline:selfmutation': true,
      'aws:cdk:codebuild:buildenvironment:computetype': 'MEDIUM',
    };
    expect(extractMetadataEnv(metadata)).toEqual({});
  });

  it('should handle mixed namespaced and non-namespaced keys', () => {
    const metadata = {
      'PYTHON_VERSION': '3.11',
      'WORKDIR': './src',
      'aws:cdk:pipelines:codepipeline:selfmutation': true,
      'ENABLE_CACHE': true,
    };
    expect(extractMetadataEnv(metadata)).toEqual({
      PYTHON_VERSION: '3.11',
      WORKDIR: './src',
      ENABLE_CACHE: 'true',
    });
  });
});

/**
 * Tests for the VALID_SECRET_NAME regex used in toSecretEnvVars (Fix 15).
 * The regex validates AWS Secrets Manager secret path characters.
 * The actual function is private, so we test the pattern directly.
 */
describe('VALID_SECRET_NAME pattern (Fix 15 — secret path validation)', () => {
  // This matches the regex defined in pipeline-helpers.ts
  const VALID_SECRET_NAME = /^[a-zA-Z0-9/_+=.@-]+$/;

  function validateSecretPath(orgId: string, name: string): void {
    const secretPath = `pipeline-builder/${orgId}/${name}`;
    if (!VALID_SECRET_NAME.test(secretPath)) {
      throw new Error(`Secret path "${secretPath}" contains invalid characters for AWS Secrets Manager`);
    }
  }

  it('should accept valid secret names', () => {
    expect(() => validateSecretPath('org-123', 'MY_SECRET')).not.toThrow();
    expect(() => validateSecretPath('org-123', 'db-password')).not.toThrow();
    expect(() => validateSecretPath('org-123', 'api_key.v2')).not.toThrow();
    expect(() => validateSecretPath('org-123', 'token@service')).not.toThrow();
  });

  it('should reject secret names containing spaces', () => {
    expect(() => validateSecretPath('org-123', 'my secret')).toThrow(
      /invalid characters for AWS Secrets Manager/,
    );
  });

  it('should reject secret names containing quotes', () => {
    expect(() => validateSecretPath('org-123', 'my"secret')).toThrow(
      /invalid characters for AWS Secrets Manager/,
    );
  });

  it('should reject secret names containing single quotes', () => {
    expect(() => validateSecretPath('org-123', "my'secret")).toThrow(
      /invalid characters for AWS Secrets Manager/,
    );
  });

  it('should reject secret names with shell-unsafe characters', () => {
    expect(() => validateSecretPath('org-123', 'secret;rm -rf /')).toThrow(
      /invalid characters for AWS Secrets Manager/,
    );
  });

  it('should include the offending path in the error message', () => {
    expect(() => validateSecretPath('my-org', 'bad secret')).toThrow(
      'Secret path "pipeline-builder/my-org/bad secret" contains invalid characters for AWS Secrets Manager',
    );
  });
});
