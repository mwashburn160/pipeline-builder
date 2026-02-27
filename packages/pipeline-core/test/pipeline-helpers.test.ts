// Mock heavy dependencies to avoid open handles from CDK/Winston in test workers
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
}));
jest.mock('aws-cdk-lib/pipelines', () => ({
  CodeBuildStep: jest.fn(),
  ShellStep: jest.fn(),
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
