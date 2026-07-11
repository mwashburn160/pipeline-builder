// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the CDK security-group resolution layer
 * (src/core/security-group.ts): `resolveSecurityGroup` maps each
 * SecurityGroupConfig variant to real CDK ISecurityGroup references.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { App, Stack } from 'aws-cdk-lib';
import { apiCoreMock } from './helpers/mock-api-core.js';
import type { SecurityGroupConfig } from '../src/core/security-group-types.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { UniqueId } = await import('../src/core/id-generator.js');
const { resolveSecurityGroup } = await import('../src/core/security-group.js');
type UniqueId = InstanceType<typeof UniqueId>;

describe('resolveSecurityGroup', () => {
  let stack: Stack;
  let id: UniqueId;

  beforeEach(() => {
    // fromLookupByName requires a concrete account/region on the stack env.
    stack = new Stack(new App(), 'SgTestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    id = new UniqueId({ organization: 'acme', project: 'checkout' });
  });

  describe('securityGroupIds', () => {
    it('resolves each security group ID to a reference, preserving order', () => {
      const config: SecurityGroupConfig = {
        type: 'securityGroupIds',
        options: { securityGroupIds: ['sg-aaa', 'sg-bbb', 'sg-ccc'] },
      };

      const groups = resolveSecurityGroup(stack, id, config);

      expect(groups).toHaveLength(3);
      expect(groups.map(g => g.securityGroupId)).toEqual(['sg-aaa', 'sg-bbb', 'sg-ccc']);
    });

    it('returns a single reference for a single ID', () => {
      const config: SecurityGroupConfig = {
        type: 'securityGroupIds',
        options: { securityGroupIds: ['sg-only'], mutable: false },
      };

      const groups = resolveSecurityGroup(stack, id, config);

      expect(groups).toHaveLength(1);
      expect(groups[0].securityGroupId).toBe('sg-only');
    });
  });

  describe('securityGroupLookup', () => {
    it('resolves a name-based lookup to a single security group', () => {
      const config: SecurityGroupConfig = {
        type: 'securityGroupLookup',
        options: { securityGroupName: 'my-codebuild-sg', vpcId: 'vpc-0a1b2c3d' },
      };

      const groups = resolveSecurityGroup(stack, id, config);

      expect(groups).toHaveLength(1);
      expect(groups[0].securityGroupId).toBeDefined();
    });
  });

  it('throws on an unknown security group config type', () => {
    const bogus = { type: 'bogus', options: {} } as unknown as SecurityGroupConfig;
    expect(() => resolveSecurityGroup(stack, id, bogus)).toThrow(
      'Unknown security group config type: bogus',
    );
  });
});
