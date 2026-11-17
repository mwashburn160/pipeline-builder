// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** ARNs and endpoints must follow the region's partition, never a hard-coded `aws`. */

import { describe, it, expect } from '@jest/globals';
import { dnsSuffixForPartition, partitionForRegion } from '../src/util.js';

describe('partitionForRegion', () => {
  it.each([
    ['us-east-1', 'aws'],
    ['eu-west-2', 'aws'],
    ['cn-north-1', 'aws-cn'],
    ['cn-northwest-1', 'aws-cn'],
    ['us-gov-west-1', 'aws-us-gov'],
    ['us-iso-east-1', 'aws-iso'],
    ['us-isob-east-1', 'aws-iso-b'],
    [undefined, 'aws'],
  ])('%p -> %p', (region, partition) => {
    expect(partitionForRegion(region)).toBe(partition);
  });
});

describe('dnsSuffixForPartition', () => {
  it.each([
    ['aws', 'amazonaws.com'],
    ['aws-us-gov', 'amazonaws.com'],
    ['aws-cn', 'amazonaws.com.cn'],
    ['aws-iso', 'c2s.ic.gov'],
    ['aws-iso-b', 'sc2s.sgov.gov'],
  ])('%p -> %p', (partition, suffix) => {
    expect(dnsSuffixForPartition(partition)).toBe(suffix);
  });
});
