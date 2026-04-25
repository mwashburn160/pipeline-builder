// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { hashId, hashAccountInArn } from '../src/helpers/mask-helpers';

describe('hashId', () => {
  it('returns a deterministic 12-char hex hash by default', () => {
    const hash = hashId('123456789012');
    expect(hash).toHaveLength(12);
    expect(hash).toMatch(/^[a-f0-9]+$/);
    // Same input always produces same output
    expect(hashId('123456789012')).toBe(hash);
  });

  it('returns different hashes for different inputs', () => {
    expect(hashId('123456789012')).not.toBe(hashId('987654321098'));
  });

  it('supports custom length', () => {
    expect(hashId('123456789012', 8)).toHaveLength(8);
    expect(hashId('123456789012', 20)).toHaveLength(20);
  });

  it('does not contain the original value', () => {
    expect(hashId('123456789012')).not.toContain('1234');
  });
});

describe('hashAccountInArn', () => {
  it('hashes the account segment of a CodePipeline ARN', () => {
    const result = hashAccountInArn('arn:aws:codepipeline:us-east-1:123456789012:my-pipeline');
    const parts = result.split(':');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('arn');
    expect(parts[3]).toBe('us-east-1');
    expect(parts[4]).toHaveLength(12);
    expect(parts[4]).not.toBe('123456789012'); // account is hashed
    expect(parts[5]).toBe('my-pipeline'); // resource preserved
  });

  it('is deterministic — same ARN always produces same hash', () => {
    const arn = 'arn:aws:codepipeline:us-east-1:123456789012:my-pipeline';
    expect(hashAccountInArn(arn)).toBe(hashAccountInArn(arn));
  });

  it('produces different hashes for different accounts', () => {
    const arn1 = 'arn:aws:codepipeline:us-east-1:123456789012:my-pipeline';
    const arn2 = 'arn:aws:codepipeline:us-east-1:987654321098:my-pipeline';
    expect(hashAccountInArn(arn1)).not.toBe(hashAccountInArn(arn2));
  });

  it('returns the original string if not a valid ARN', () => {
    expect(hashAccountInArn('not-an-arn')).toBe('not-an-arn');
    expect(hashAccountInArn('arn:aws:s3')).toBe('arn:aws:s3');
  });
});
