// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  resolveAccount,
  resolveRegion,
  buildBootstrapCommand,
} from '../src/commands/bootstrap';

// Environment save / restore
const ENV_KEYS = [
  'AWS_ACCOUNT_ID',
  'CDK_DEFAULT_ACCOUNT',
  'AWS_REGION',
  'CDK_DEFAULT_REGION',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  ENV_KEYS.forEach((k) => {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  });
});

afterEach(() => {
  Object.entries(savedEnv).forEach(([k, v]) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
});

// resolveAccount
describe('resolveAccount', () => {
  it('should return the option value when provided', () => {
    expect(resolveAccount('111111111111')).toBe('111111111111');
  });

  it('should prefer option value over env vars', () => {
    process.env.AWS_ACCOUNT_ID = '222222222222';
    expect(resolveAccount('111111111111')).toBe('111111111111');
  });

  it('should fall back to AWS_ACCOUNT_ID env var', () => {
    process.env.AWS_ACCOUNT_ID = '222222222222';
    expect(resolveAccount()).toBe('222222222222');
  });

  it('should fall back to CDK_DEFAULT_ACCOUNT env var', () => {
    process.env.CDK_DEFAULT_ACCOUNT = '333333333333';
    expect(resolveAccount()).toBe('333333333333');
  });

  it('should prefer AWS_ACCOUNT_ID over CDK_DEFAULT_ACCOUNT', () => {
    process.env.AWS_ACCOUNT_ID = '222222222222';
    process.env.CDK_DEFAULT_ACCOUNT = '333333333333';
    expect(resolveAccount()).toBe('222222222222');
  });

  it('should return undefined when nothing is set', () => {
    expect(resolveAccount()).toBeUndefined();
  });
});

// resolveRegion
describe('resolveRegion', () => {
  it('should return the option value when provided', () => {
    expect(resolveRegion('us-west-2')).toBe('us-west-2');
  });

  it('should prefer option value over env vars', () => {
    process.env.AWS_REGION = 'eu-west-1';
    expect(resolveRegion('us-west-2')).toBe('us-west-2');
  });

  it('should fall back to AWS_REGION env var', () => {
    process.env.AWS_REGION = 'eu-west-1';
    expect(resolveRegion()).toBe('eu-west-1');
  });

  it('should fall back to CDK_DEFAULT_REGION env var', () => {
    process.env.CDK_DEFAULT_REGION = 'ap-southeast-1';
    expect(resolveRegion()).toBe('ap-southeast-1');
  });

  it('should prefer AWS_REGION over CDK_DEFAULT_REGION', () => {
    process.env.AWS_REGION = 'eu-west-1';
    process.env.CDK_DEFAULT_REGION = 'ap-southeast-1';
    expect(resolveRegion()).toBe('eu-west-1');
  });

  it('should return undefined when nothing is set', () => {
    expect(resolveRegion()).toBeUndefined();
  });
});

// buildBootstrapCommand
describe('buildBootstrapCommand', () => {
  it('should build minimal command with account and region', () => {
    const cmd = buildBootstrapCommand({
      account: '123456789012',
      region: 'us-east-1',
    });
    expect(cmd).toBe('cdk bootstrap aws://123456789012/us-east-1');
  });

  it('should include --profile when provided', () => {
    const cmd = buildBootstrapCommand({
      account: '123456789012',
      region: 'us-east-1',
      profile: 'production',
    });
    expect(cmd).toBe('cdk bootstrap aws://123456789012/us-east-1 --profile=production');
  });

  it('should include --qualifier when provided', () => {
    const cmd = buildBootstrapCommand({
      account: '123456789012',
      region: 'us-east-1',
      qualifier: 'myapp',
    });
    expect(cmd).toBe('cdk bootstrap aws://123456789012/us-east-1 --qualifier=myapp');
  });

  it('should include --trust when provided', () => {
    const cmd = buildBootstrapCommand({
      account: '123456789012',
      region: 'us-east-1',
      trust: '111111111111,222222222222',
    });
    expect(cmd).toBe('cdk bootstrap aws://123456789012/us-east-1 --trust=111111111111,222222222222');
  });

  it('should include --cloudformation-execution-policies when provided', () => {
    const cmd = buildBootstrapCommand({
      account: '123456789012',
      region: 'us-east-1',
      cloudformationExecutionPolicies: 'arn:aws:iam::policy/AdministratorAccess',
    });
    expect(cmd).toBe(
      'cdk bootstrap aws://123456789012/us-east-1 --cloudformation-execution-policies=arn:aws:iam::policy/AdministratorAccess',
    );
  });

  it('should combine all options', () => {
    const cmd = buildBootstrapCommand({
      account: '123456789012',
      region: 'us-east-1',
      profile: 'prod',
      qualifier: 'myapp',
      trust: '999999999999',
      cloudformationExecutionPolicies: 'arn:aws:iam::policy/PowerUserAccess',
    });
    expect(cmd).toBe(
      'cdk bootstrap aws://123456789012/us-east-1 --profile=prod --qualifier=myapp --trust=999999999999 --cloudformation-execution-policies=arn:aws:iam::policy/PowerUserAccess',
    );
  });

  it('should not include optional flags when undefined', () => {
    const cmd = buildBootstrapCommand({
      account: '123456789012',
      region: 'eu-west-1',
      profile: undefined,
      qualifier: undefined,
      trust: undefined,
      cloudformationExecutionPolicies: undefined,
    });
    expect(cmd).toBe('cdk bootstrap aws://123456789012/eu-west-1');
  });
});
