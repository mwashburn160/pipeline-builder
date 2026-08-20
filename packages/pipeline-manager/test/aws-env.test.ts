// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.unstable_mockModule('../src/utils/output-utils.js', () => ({
  printWarning: jest.fn(),
}));

const { resolveAwsRegion, applyAwsProfile } = await import('../src/utils/aws-env.js');
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
    (printWarning as jest.Mock).mockReset();
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
