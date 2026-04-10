// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  metadataForCodePipeline,
  metadataForCodeBuildStep,
  metadataForShellStep,
  metadataForBuildEnvironment,
} from '../src/core/metadata-builder';

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
