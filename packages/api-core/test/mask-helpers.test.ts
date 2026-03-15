import { maskId, maskAccountInArn } from '../src/helpers/mask-helpers';

describe('maskId', () => {
  it('masks middle characters of a 12-digit account', () => {
    expect(maskId('123456789012')).toBe('1234****9012');
  });

  it('masks a 20-character access key', () => {
    expect(maskId('AKIAIOSFODNN7EXAMPLE')).toBe('AKIA************MPLE');
  });

  it('returns **** for short strings', () => {
    expect(maskId('1234')).toBe('****');
    expect(maskId('12345678')).toBe('****');
  });

  it('returns **** for empty or missing input', () => {
    expect(maskId('')).toBe('****');
  });

  it('supports custom visible length', () => {
    expect(maskId('123456789012', 2)).toBe('12********12');
    expect(maskId('123456789012', 6)).toBe('****'); // nothing to mask, returns masked
  });
});

describe('maskAccountInArn', () => {
  it('masks the account segment of a CodePipeline ARN', () => {
    expect(maskAccountInArn('arn:aws:codepipeline:us-east-1:123456789012:my-pipeline'))
      .toBe('arn:aws:codepipeline:us-east-1:1234****9012:my-pipeline');
  });

  it('masks the account segment of a CodeBuild ARN', () => {
    expect(maskAccountInArn('arn:aws:codebuild:us-west-2:987654321098:project/my-build'))
      .toBe('arn:aws:codebuild:us-west-2:9876****1098:project/my-build');
  });

  it('returns the original string if not a valid ARN', () => {
    expect(maskAccountInArn('not-an-arn')).toBe('not-an-arn');
    expect(maskAccountInArn('arn:aws:s3')).toBe('arn:aws:s3');
  });
});
