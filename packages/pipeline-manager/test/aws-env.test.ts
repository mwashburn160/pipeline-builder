// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';

jest.unstable_mockModule('../src/utils/output-utils.js', () => ({
  printWarning: jest.fn(),
}));

const { resolveAwsRegion, applyAwsProfile, resolveDeployRegion } = await import('../src/utils/aws-env.js');
const { printWarning } = await import('../src/utils/output-utils.js');

describe('resolveAwsRegion', () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.AWS_REGION; delete process.env.CDK_DEFAULT_REGION; });
  afterEach(() => { process.env = { ...saved }; });

  it('prefers the explicit override', () => {
    process.env.AWS_REGION = 'eu-west-1';
    expect(resolveAwsRegion('us-west-2')).toBe('us-west-2');
  });
  it('falls back AWS_REGION → CDK_DEFAULT_REGION → us-east-1', () => {
    expect(resolveAwsRegion()).toBe('us-east-1');
    process.env.CDK_DEFAULT_REGION = 'ap-south-1';
    expect(resolveAwsRegion()).toBe('ap-south-1');
    process.env.AWS_REGION = 'eu-central-1';
    expect(resolveAwsRegion()).toBe('eu-central-1');
  });
});

describe('applyAwsProfile', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.AWS_PROFILE; delete process.env.AWS_ACCESS_KEY_ID;
    (printWarning as jest.Mock<AnyFn>).mockReset();
  });
  afterEach(() => { process.env = { ...saved }; });

  it('sets AWS_PROFILE when no ambient creds/profile exist', () => {
    applyAwsProfile('prod');
    expect(process.env.AWS_PROFILE).toBe('prod');
    expect(printWarning).not.toHaveBeenCalled();
  });
  it('does not clobber ambient AWS_PROFILE, and warns for a non-default override', () => {
    process.env.AWS_PROFILE = 'ambient';
    applyAwsProfile('prod');
    expect(process.env.AWS_PROFILE).toBe('ambient');
    expect(printWarning).toHaveBeenCalledTimes(1);
  });
  it('yields to ambient env credentials (AWS_ACCESS_KEY_ID wins)', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIA...';
    applyAwsProfile('prod');
    expect(process.env.AWS_PROFILE).toBeUndefined();
    expect(printWarning).toHaveBeenCalledTimes(1);
  });
  it('is a no-op with no profile', () => {
    applyAwsProfile(undefined);
    expect(process.env.AWS_PROFILE).toBeUndefined();
    expect(printWarning).not.toHaveBeenCalled();
  });
});

describe('resolveDeployRegion', () => {
  const VARS = ['AWS_REGION', 'AWS_DEFAULT_REGION', 'CDK_DEFAULT_REGION'] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const v of VARS) { saved[v] = process.env[v]; delete process.env[v]; } });
  afterEach(() => { for (const v of VARS) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]; } });

  it('reads the PROFILE region when nothing else is set (resolveAwsRegion said us-east-1 here)', async () => {
    const reader = jest.fn(async (_profile?: string) => 'eu-west-2');
    await expect(resolveDeployRegion(undefined, 'work', reader)).resolves.toBe('eu-west-2');
    expect(reader).toHaveBeenCalledWith('work');
    expect(resolveAwsRegion()).toBe('us-east-1'); // the old answer, for contrast
  });
  it('precedence: --region > AWS_REGION > AWS_DEFAULT_REGION > CDK_DEFAULT_REGION > profile > us-east-1', async () => {
    const reader = jest.fn(async (_profile?: string) => 'from-profile');
    process.env.CDK_DEFAULT_REGION = 'cdk';
    process.env.AWS_DEFAULT_REGION = 'default';
    process.env.AWS_REGION = 'env';
    await expect(resolveDeployRegion('flag', undefined, reader)).resolves.toBe('flag');
    await expect(resolveDeployRegion(undefined, undefined, reader)).resolves.toBe('env');
    delete process.env.AWS_REGION;
    await expect(resolveDeployRegion(undefined, undefined, reader)).resolves.toBe('default');
    delete process.env.AWS_DEFAULT_REGION;
    await expect(resolveDeployRegion(undefined, undefined, reader)).resolves.toBe('cdk');
    delete process.env.CDK_DEFAULT_REGION;
    await expect(resolveDeployRegion(undefined, undefined, reader)).resolves.toBe('from-profile');
    await expect(resolveDeployRegion(undefined, undefined, async () => undefined)).resolves.toBe('us-east-1');
  });
});
