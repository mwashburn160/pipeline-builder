import { MetadataBuilder } from '../src/core/metadata-builder';

describe('MetadataBuilder', () => {
  describe('from', () => {
    it('should create builder from metadata', () => {
      const builder = MetadataBuilder.from({});
      expect(builder).toBeInstanceOf(MetadataBuilder);
    });
  });

  describe('forCodePipeline', () => {
    it('should extract boolean keys from metadata', () => {
      const metadata = {
        'aws:cdk:pipelines:codepipeline:selfmutation': true,
        'aws:cdk:pipelines:codepipeline:crossaccountkeys': 'true',
        'aws:cdk:pipelines:codepipeline:dockerenabledforsynth': false,
      };
      const config = MetadataBuilder.from(metadata).forCodePipeline();
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
      const config = MetadataBuilder.from(metadata).forCodePipeline();
      expect(config).toEqual({ pipelineName: 'my-pipeline' });
    });

    it('should return empty object for no matching metadata', () => {
      const config = MetadataBuilder.from({}).forCodePipeline();
      expect(config).toEqual({});
    });
  });

  describe('forCodeBuildStep', () => {
    it('should extract CodeBuildStep passthrough keys', () => {
      const metadata = {
        'aws:cdk:pipelines:codebuildstep:projectname': 'MyProject',
        'aws:cdk:pipelines:codebuildstep:timeout': 30,
      };
      const config = MetadataBuilder.from(metadata).forCodeBuildStep();
      expect(config).toEqual({ projectName: 'MyProject', timeout: 30 });
    });
  });

  describe('forShellStep', () => {
    it('should extract ShellStep passthrough keys', () => {
      const metadata = {
        'aws:cdk:pipelines:shellstep:primaryoutputdirectory': 'dist',
      };
      const config = MetadataBuilder.from(metadata).forShellStep();
      expect(config).toEqual({ primaryOutputDirectory: 'dist' });
    });
  });

  describe('forBuildEnvironment', () => {
    it('should extract BuildEnvironment boolean and passthrough keys', () => {
      const metadata = {
        'aws:cdk:codebuild:buildenvironment:privileged': true,
        'aws:cdk:codebuild:buildenvironment:computetype': 'LARGE',
      };
      const config = MetadataBuilder.from(metadata).forBuildEnvironment();
      expect(config).toEqual({ privileged: true, computeType: 'LARGE' });
    });

    it('should coerce string "true" to boolean for privileged', () => {
      const metadata = {
        'aws:cdk:codebuild:buildenvironment:privileged': 'true',
      };
      const config = MetadataBuilder.from(metadata).forBuildEnvironment();
      expect(config).toEqual({ privileged: true });
    });

    it('should coerce string "false" to boolean for privileged', () => {
      const metadata = {
        'aws:cdk:codebuild:buildenvironment:privileged': 'false',
      };
      const config = MetadataBuilder.from(metadata).forBuildEnvironment();
      expect(config).toEqual({ privileged: false });
    });
  });

  describe('ignores unknown metadata keys', () => {
    it('should skip metadata keys not in namespace', () => {
      const metadata = {
        'unknown:key': 'value',
        'aws:cdk:custom:key': 'value2',
      };
      const config = MetadataBuilder.from(metadata).forCodePipeline();
      expect(config).toEqual({});
    });
  });
});
