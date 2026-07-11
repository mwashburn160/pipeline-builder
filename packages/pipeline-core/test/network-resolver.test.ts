// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the CDK network-resolution layer (src/core/network.ts):
 * `resolveNetwork` maps each NetworkConfig variant to real CDK vpc/subnet/
 * security-group references, and `networkConfigFromEnv` builds a config from
 * env vars. These emit real infrastructure references, so we assert on the
 * resolved structure directly.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { App, Stack } from 'aws-cdk-lib';
import { SubnetType } from 'aws-cdk-lib/aws-ec2';
import { apiCoreMock } from './helpers/mock-api-core.js';
import type { NetworkConfig } from '../src/core/network-types.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { UniqueId } = await import('../src/core/id-generator.js');
const { resolveNetwork, networkConfigFromEnv } = await import('../src/core/network.js');
type UniqueId = InstanceType<typeof UniqueId>;

// Vpc.fromLookup requires a concrete account/region on the stack env.
function newStack(): Stack {
  return new Stack(new App(), 'NetTestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
}

describe('resolveNetwork', () => {
  let stack: Stack;
  let id: UniqueId;

  beforeEach(() => {
    stack = newStack();
    id = new UniqueId({ organization: 'acme', project: 'checkout' });
  });

  describe('subnetIds', () => {
    it('resolves explicit subnet IDs into a subnet selection', () => {
      const network: NetworkConfig = {
        type: 'subnetIds',
        options: {
          vpcId: 'vpc-0a1b2c3d',
          subnetIds: ['subnet-aaa', 'subnet-bbb'],
        },
      };

      const resolved = resolveNetwork(stack, id, network);

      expect(resolved.vpc).toBeDefined();
      expect(resolved.subnetSelection.subnets).toHaveLength(2);
      expect(resolved.subnetSelection.subnets!.map(s => s.subnetId)).toEqual([
        'subnet-aaa',
        'subnet-bbb',
      ]);
      // No security group IDs → no securityGroups key on the result.
      expect(resolved.securityGroups).toBeUndefined();
    });

    it('attaches security groups when securityGroupIds are provided', () => {
      const network: NetworkConfig = {
        type: 'subnetIds',
        options: {
          vpcId: 'vpc-0a1b2c3d',
          subnetIds: ['subnet-aaa'],
          securityGroupIds: ['sg-111', 'sg-222'],
        },
      };

      const resolved = resolveNetwork(stack, id, network);

      expect(resolved.securityGroups).toHaveLength(2);
      expect(resolved.securityGroups!.map(sg => sg.securityGroupId)).toEqual([
        'sg-111',
        'sg-222',
      ]);
    });
  });

  describe('vpcId', () => {
    it('maps the default subnet type to PRIVATE_WITH_EGRESS', () => {
      const network: NetworkConfig = {
        type: 'vpcId',
        options: { vpcId: 'vpc-0a1b2c3d' },
      };

      const resolved = resolveNetwork(stack, id, network);

      expect(resolved.vpc).toBeDefined();
      expect(resolved.subnetSelection.subnetType).toBe(SubnetType.PRIVATE_WITH_EGRESS);
    });

    it('maps a named subnet type to the CDK enum and forwards AZ filters', () => {
      const network: NetworkConfig = {
        type: 'vpcId',
        options: {
          vpcId: 'vpc-0a1b2c3d',
          subnetType: 'PRIVATE_ISOLATED',
          availabilityZones: ['us-east-1a', 'us-east-1b'],
        },
      };

      const resolved = resolveNetwork(stack, id, network);

      expect(resolved.subnetSelection.subnetType).toBe(SubnetType.PRIVATE_ISOLATED);
      expect(resolved.subnetSelection.availabilityZones).toEqual(['us-east-1a', 'us-east-1b']);
    });
  });

  describe('vpcLookup', () => {
    it('looks up a VPC by tags and applies the default subnet selection', () => {
      const network: NetworkConfig = {
        type: 'vpcLookup',
        options: {
          tags: { Environment: 'production' },
          subnetType: 'PUBLIC',
        },
      };

      const resolved = resolveNetwork(stack, id, network);

      expect(resolved.vpc).toBeDefined();
      expect(resolved.subnetSelection.subnetType).toBe(SubnetType.PUBLIC);
    });
  });

  it('throws on an unknown network config type', () => {
    const bogus = { type: 'bogus', options: {} } as unknown as NetworkConfig;
    expect(() => resolveNetwork(stack, id, bogus)).toThrow('Unknown network config type: bogus');
  });
});

describe('networkConfigFromEnv', () => {
  const ENV_KEYS = ['PIPELINE_VPC_ID', 'PIPELINE_SUBNET_IDS', 'PIPELINE_SECURITY_GROUP_IDS'];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns undefined when required env vars are absent', () => {
    expect(networkConfigFromEnv()).toBeUndefined();
  });

  it('returns undefined when subnet IDs are missing', () => {
    process.env.PIPELINE_VPC_ID = 'vpc-abc';
    expect(networkConfigFromEnv()).toBeUndefined();
  });

  it('builds a subnetIds config from vpc + subnet env vars', () => {
    process.env.PIPELINE_VPC_ID = 'vpc-abc';
    process.env.PIPELINE_SUBNET_IDS = 'subnet-1, subnet-2 , subnet-3';

    const config = networkConfigFromEnv();

    expect(config).toEqual({
      type: 'subnetIds',
      options: { vpcId: 'vpc-abc', subnetIds: ['subnet-1', 'subnet-2', 'subnet-3'] },
    });
  });

  it('includes security group IDs when set', () => {
    process.env.PIPELINE_VPC_ID = 'vpc-abc';
    process.env.PIPELINE_SUBNET_IDS = 'subnet-1';
    process.env.PIPELINE_SECURITY_GROUP_IDS = 'sg-1,sg-2';

    const config = networkConfigFromEnv();

    expect(config).toEqual({
      type: 'subnetIds',
      options: { vpcId: 'vpc-abc', subnetIds: ['subnet-1'], securityGroupIds: ['sg-1', 'sg-2'] },
    });
  });
});
