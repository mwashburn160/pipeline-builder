import { TriggerType, MetadataKeys } from '../src/core/pipeline-types';

describe('TriggerType', () => {
  it('should define NONE', () => {
    expect(TriggerType.NONE).toBe('NONE');
  });

  it('should define AUTO', () => {
    expect(TriggerType.AUTO).toBe('AUTO');
  });
});

describe('MetadataKeys', () => {
  it('should have correct CodePipeline namespace keys', () => {
    expect(MetadataKeys.SELF_MUTATION).toBe('aws:cdk:pipelines:codepipeline:selfmutation');
    expect(MetadataKeys.CROSS_ACCOUNT_KEYS).toBe('aws:cdk:pipelines:codepipeline:crossaccountkeys');
    expect(MetadataKeys.PIPELINE_NAME).toBe('aws:cdk:pipelines:codepipeline:pipelinename');
  });

  it('should have correct CodeBuildStep namespace keys', () => {
    expect(MetadataKeys.COMMANDS).toBe('aws:cdk:pipelines:codebuildstep:commands');
    expect(MetadataKeys.INSTALL_COMMANDS).toBe('aws:cdk:pipelines:codebuildstep:installcommands');
    expect(MetadataKeys.PROJECT_NAME).toBe('aws:cdk:pipelines:codebuildstep:projectname');
  });

  it('should have correct BuildEnvironment namespace keys', () => {
    expect(MetadataKeys.PRIVILEGED).toBe('aws:cdk:codebuild:buildenvironment:privileged');
    expect(MetadataKeys.COMPUTE_TYPE).toBe('aws:cdk:codebuild:buildenvironment:computetype');
  });

  it('should have correct Network namespace keys', () => {
    expect(MetadataKeys.NETWORK_TYPE).toBe('aws:cdk:ec2:network:type');
    expect(MetadataKeys.NETWORK_VPC_ID).toBe('aws:cdk:ec2:network:vpcid');
  });

  it('should have correct Role namespace keys', () => {
    expect(MetadataKeys.ROLE_TYPE).toBe('aws:cdk:iam:role:type');
    expect(MetadataKeys.ROLE_ARN).toBe('aws:cdk:iam:role:roleArn');
  });

  it('should all be lowercase except for the object keys', () => {
    for (const [, value] of Object.entries(MetadataKeys)) {
      // MetadataKeys values should be lowercase (aws:cdk:... format)
      // except ROLE_ARN which has roleArn
      if (value !== MetadataKeys.ROLE_ARN) {
        expect(value).toBe(value.toLowerCase());
      }
    }
  });
});
