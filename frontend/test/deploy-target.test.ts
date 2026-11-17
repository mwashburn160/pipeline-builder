// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline detail page's "View stack in AWS" link puts the registry's
 * `region` into the URL HOST. The registry accepts any string there, so only a
 * real region code may produce a link.
 */

import { describe, it, expect } from '@jest/globals';
import { awsStackConsoleUrl, isAwsTarget } from '../src/lib/deploy-target';

describe('awsStackConsoleUrl', () => {
  it('links to the stack in the region it is deployed to', () => {
    expect(awsStackConsoleUrl('us-east-1', 'my stack')).toBe(
      'https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks?filteringText=my%20stack',
    );
    expect(awsStackConsoleUrl('us-gov-west-1', 's')).toMatch(/^https:\/\/us-gov-west-1\.console\.aws\.amazon\.com\//);
  });

  it('gives no link for a region that is not a region code', () => {
    for (const region of ['evil.example/x?', 'evil.example#', 'us-east-1.evil.example/', 'US-EAST-1', '', 'javascript:alert(1)//']) {
      expect(awsStackConsoleUrl(region, 'stack')).toBeNull();
    }
  });

  it('gives no link without a stack name or region', () => {
    expect(awsStackConsoleUrl('us-east-1', '')).toBeNull();
    expect(awsStackConsoleUrl(undefined, 'stack')).toBeNull();
  });
});

describe('isAwsTarget', () => {
  it('is true only for the AWS deploy targets', () => {
    expect(isAwsTarget('aws-ec2')).toBe(true);
    expect(isAwsTarget('aws-eks')).toBe(true);
    expect(isAwsTarget('local')).toBe(false);
    expect(isAwsTarget(undefined)).toBe(false);
  });
});
