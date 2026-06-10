// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  asInt,
  metadataForCodePipeline,
  metadataForCodeBuildStep,
  metadataForShellStep,
  metadataForBuildEnvironment,
  networkConfigFromMetadata,
  parsePipelineVariables,
  roleConfigFromMetadata,
  securityGroupConfigFromMetadata,
} from '../src/core/metadata-builder.js';
import { MetadataKeys } from '../src/core/pipeline-types.js';

describe('metadataForCodePipeline', () => {
  it('should extract boolean keys from metadata', () => {
    const metadata = {
      'aws:cdk:pipelines:codepipeline:selfmutation': true,
      'aws:cdk:pipelines:codepipeline:crossaccountkeys': 'true',
      'aws:cdk:pipelines:codepipeline:dockerenabledforsynth': false,
    };
    const config = metadataForCodePipeline(metadata);
    expect(config).toEqual({
      selfMutation: true,
      crossAccountKeys: true,
      dockerEnabledForSynth: false,
    });
  });

  it('should extract passthrough keys from metadata', () => {
    const metadata = {
      'aws:cdk:pipelines:codepipeline:pipelinename': 'my-pipeline',
    };
    const config = metadataForCodePipeline(metadata);
    expect(config).toEqual({ pipelineName: 'my-pipeline' });
  });

  it('should return empty object for no matching metadata', () => {
    const config = metadataForCodePipeline({});
    expect(config).toEqual({});
  });

  it('should skip metadata keys not in namespace', () => {
    const metadata = {
      'unknown:key': 'value',
      'aws:cdk:custom:key': 'value2',
    };
    const config = metadataForCodePipeline(metadata);
    expect(config).toEqual({});
  });
});

describe('metadataForCodeBuildStep', () => {
  it('should extract CodeBuildStep passthrough keys', () => {
    const metadata = {
      'aws:cdk:pipelines:codebuildstep:projectname': 'MyProject',
      'aws:cdk:pipelines:codebuildstep:timeout': 30,
    };
    const config = metadataForCodeBuildStep(metadata);
    expect(config).toEqual({ projectName: 'MyProject', timeout: 30 });
  });
});

describe('metadataForShellStep', () => {
  it('should extract ShellStep passthrough keys', () => {
    const metadata = {
      'aws:cdk:pipelines:shellstep:primaryoutputdirectory': 'dist',
    };
    const config = metadataForShellStep(metadata);
    expect(config).toEqual({ primaryOutputDirectory: 'dist' });
  });
});

describe('metadataForBuildEnvironment', () => {
  it('should extract BuildEnvironment boolean and passthrough keys', () => {
    const metadata = {
      'aws:cdk:codebuild:buildenvironment:privileged': true,
      'aws:cdk:codebuild:buildenvironment:computetype': 'LARGE',
    };
    const config = metadataForBuildEnvironment(metadata);
    expect(config).toEqual({ privileged: true, computeType: 'LARGE' });
  });

  it('should coerce string "true" to boolean for privileged', () => {
    const metadata = {
      'aws:cdk:codebuild:buildenvironment:privileged': 'true',
    };
    const config = metadataForBuildEnvironment(metadata);
    expect(config).toEqual({ privileged: true });
  });

  it('should coerce string "false" to boolean for privileged', () => {
    const metadata = {
      'aws:cdk:codebuild:buildenvironment:privileged': 'false',
    };
    const config = metadataForBuildEnvironment(metadata);
    expect(config).toEqual({ privileged: false });
  });
});

describe('networkConfigFromMetadata', () => {
  it('builds a subnetIds config (inferred variant)', () => {
    const config = networkConfigFromMetadata({
      [MetadataKeys.NETWORK_VPC_ID]: 'vpc-123',
      [MetadataKeys.NETWORK_SUBNET_IDS]: 'subnet-a,subnet-b',
    });
    expect(config).toEqual({
      type: 'subnetIds',
      options: { vpcId: 'vpc-123', subnetIds: ['subnet-a', 'subnet-b'] },
    });
  });

  it('builds a vpcLookup config from tags', () => {
    const config = networkConfigFromMetadata({
      [MetadataKeys.NETWORK_TAGS]: '{"Environment":"prod"}',
      [MetadataKeys.NETWORK_SUBNET_TYPE]: 'PRIVATE_WITH_EGRESS',
    });
    expect(config).toEqual({
      type: 'vpcLookup',
      options: { tags: { Environment: 'prod' }, subnetType: 'PRIVATE_WITH_EGRESS' },
    });
  });

  it('returns undefined with no network metadata', () => {
    expect(networkConfigFromMetadata({})).toBeUndefined();
  });
});

describe('roleConfigFromMetadata', () => {
  it('builds a roleArn config (inferred variant)', () => {
    const config = roleConfigFromMetadata({
      [MetadataKeys.ROLE_ARN]: 'arn:aws:iam::111:role/r',
      [MetadataKeys.ROLE_MUTABLE]: 'false',
    });
    expect(config).toEqual({
      type: 'roleArn',
      options: { roleArn: 'arn:aws:iam::111:role/r', mutable: false },
    });
  });

  it('returns undefined with no role metadata', () => {
    expect(roleConfigFromMetadata({})).toBeUndefined();
  });
});

describe('securityGroupConfigFromMetadata', () => {
  it('builds a securityGroupIds config (inferred variant)', () => {
    const config = securityGroupConfigFromMetadata({
      [MetadataKeys.SECURITY_GROUP_IDS]: 'sg-1,sg-2',
    });
    expect(config).toEqual({
      type: 'securityGroupIds',
      options: { securityGroupIds: ['sg-1', 'sg-2'] },
    });
  });

  it('builds a securityGroupLookup config', () => {
    const config = securityGroupConfigFromMetadata({
      [MetadataKeys.SECURITY_GROUP_NAME]: 'build-sg',
      [MetadataKeys.SECURITY_GROUP_VPC_ID]: 'vpc-9',
    });
    expect(config).toEqual({
      type: 'securityGroupLookup',
      options: { securityGroupName: 'build-sg', vpcId: 'vpc-9' },
    });
  });

  it('returns undefined with no security-group metadata', () => {
    expect(securityGroupConfigFromMetadata({})).toBeUndefined();
  });
});

describe('asInt', () => {
  it('coerces positive integers from string or number', () => {
    expect(asInt('30')).toBe(30);
    expect(asInt(7)).toBe(7);
  });

  it('rejects non-positive, fractional, and invalid values', () => {
    expect(asInt('0')).toBeUndefined();
    expect(asInt('-5')).toBeUndefined();
    expect(asInt('1.5')).toBeUndefined();
    expect(asInt('abc')).toBeUndefined();
    expect(asInt(undefined)).toBeUndefined();
    expect(asInt('')).toBeUndefined();
  });
});

describe('parsePipelineVariables', () => {
  it('parses a JSON array of variable specs', () => {
    const specs = parsePipelineVariables(
      '[{"name":"ENV","default":"prod","description":"target env"},{"name":"REGION"}]',
    );
    expect(specs).toEqual([
      { name: 'ENV', defaultValue: 'prod', description: 'target env' },
      { name: 'REGION' },
    ]);
  });

  it('accepts an already-parsed array (defaultValue alias)', () => {
    const specs = parsePipelineVariables([{ name: 'ENV', defaultValue: 'prod' }]);
    expect(specs).toEqual([{ name: 'ENV', defaultValue: 'prod' }]);
  });

  it('parses a compact name=default comma list', () => {
    const specs = parsePipelineVariables('ENV=prod,REGION=us-east-1,FLAG');
    expect(specs).toEqual([
      { name: 'ENV', defaultValue: 'prod' },
      { name: 'REGION', defaultValue: 'us-east-1' },
      { name: 'FLAG' },
    ]);
  });

  it('skips entries without a name and handles empty/malformed input', () => {
    expect(parsePipelineVariables(undefined)).toEqual([]);
    expect(parsePipelineVariables('')).toEqual([]);
    expect(parsePipelineVariables('[{"default":"x"}]')).toEqual([]);
    expect(parsePipelineVariables('[not json')).toEqual([{ name: '[not json' }]);
  });
});
