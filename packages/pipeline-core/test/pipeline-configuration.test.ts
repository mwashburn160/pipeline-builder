jest.mock('@mwashburn160/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import type { BuilderProps } from '../src/pipeline/pipeline-builder';
import { PipelineConfiguration } from '../src/pipeline/pipeline-configuration';

function validProps(overrides: Partial<BuilderProps> = {}): BuilderProps {
  return {
    project: 'my-project',
    organization: 'my-org',
    synth: {
      source: { type: 's3', options: { bucketName: 'my-bucket' } },
      plugin: { name: 'cdk-synth', version: '1.0.0' },
    },
    ...overrides,
  } as BuilderProps;
}

describe('PipelineConfiguration', () => {
  describe('validation', () => {
    it('creates a valid configuration', () => {
      const config = new PipelineConfiguration(validProps());
      expect(config.project).toBe('my_project');
      expect(config.organization).toBe('my_org');
    });

    it('throws when project is missing', () => {
      expect(() => new PipelineConfiguration(validProps({ project: '' }))).toThrow(
        'BuilderProps.project is required',
      );
    });

    it('throws when organization is missing', () => {
      expect(() => new PipelineConfiguration(validProps({ organization: '' }))).toThrow(
        'BuilderProps.organization is required',
      );
    });

    it('throws when synth.source is missing', () => {
      expect(
        () =>
          new PipelineConfiguration(
            validProps({
              synth: { plugin: { name: 'cdk-synth', version: '1.0.0' } } as any,
            }),
          ),
      ).toThrow('BuilderProps.synth.source is required');
    });

    it('throws when synth.plugin is missing', () => {
      expect(
        () =>
          new PipelineConfiguration(
            validProps({
              synth: { source: { type: 's3', options: { bucketName: 'b' } } } as any,
            }),
          ),
      ).toThrow('BuilderProps.synth.plugin is required');
    });

    it('throws for empty plugin name', () => {
      expect(
        () =>
          new PipelineConfiguration(
            validProps({
              synth: {
                source: { type: 's3', options: { bucketName: 'b' } },
                plugin: { name: '  ', version: '1.0.0' },
              },
            } as any),
          ),
      ).toThrow('plugin.name must be a non-empty string');
    });

    it('rejects pipeline names > 100 characters', () => {
      expect(
        () =>
          new PipelineConfiguration(
            validProps({ pipelineName: 'a'.repeat(101) } as any),
          ),
      ).toThrow('exceeds AWS maximum of 100 characters');
    });

    it('validates GitHub repo format (must contain /)', () => {
      expect(
        () =>
          new PipelineConfiguration(
            validProps({
              synth: {
                source: { type: 'github', options: { repo: 'invalid-repo' } },
                plugin: { name: 'cdk-synth', version: '1.0.0' },
              },
            } as any),
          ),
      ).toThrow('Expected format: "owner/repo"');
    });

    it('validates CodeStar repo format (must contain /)', () => {
      expect(
        () =>
          new PipelineConfiguration(
            validProps({
              synth: {
                source: { type: 'codestar', options: { repo: 'invalid-repo', connectionArn: 'arn:...' } },
                plugin: { name: 'cdk-synth', version: '1.0.0' },
              },
            } as any),
          ),
      ).toThrow('Expected format: "owner/repo"');
    });

    it('accepts valid GitHub repo format', () => {
      const config = new PipelineConfiguration(
        validProps({
          synth: {
            source: { type: 'github', options: { repo: 'owner/repo' } },
            plugin: { name: 'cdk-synth', version: '1.0.0' },
          },
        } as any),
      );
      expect(config.source.type).toBe('github');
    });

    it('rejects duplicate stage names', () => {
      expect(
        () =>
          new PipelineConfiguration(
            validProps({
              stages: [
                { stageName: 'build', steps: [{ plugin: { name: 'p1', version: '1' } }] },
                { stageName: 'build', steps: [{ plugin: { name: 'p2', version: '1' } }] },
              ],
            } as any),
          ),
      ).toThrow('Duplicate stage name: "build"');
    });

    it('rejects stages with empty steps', () => {
      expect(
        () =>
          new PipelineConfiguration(
            validProps({
              stages: [{ stageName: 'empty', steps: [] }],
            } as any),
          ),
      ).toThrow('must have at least one step');
    });
  });

  describe('sanitization', () => {
    it('replaces non-alphanumeric chars with underscores and lowercases', () => {
      const config = new PipelineConfiguration(
        validProps({ project: 'My-Project.v2', organization: 'My Org!' }),
      );
      expect(config.project).toBe('my_project_v2');
      expect(config.organization).toBe('my_org_');
    });

    it('generates pipeline name from org and project', () => {
      const config = new PipelineConfiguration(validProps());
      expect(config.pipelineName).toBe('my_org-my_project-pipeline');
    });

    it('uses custom pipeline name when provided', () => {
      const config = new PipelineConfiguration(
        validProps({ pipelineName: 'custom-name' } as any),
      );
      expect(config.pipelineName).toBe('custom-name');
    });
  });

  describe('metadata merging', () => {
    it('merges global → defaults → synth metadata', () => {
      const config = new PipelineConfiguration(
        validProps({
          global: { GLOBAL_KEY: 'global' },
          defaults: { metadata: { DEFAULT_KEY: 'default', GLOBAL_KEY: 'overridden' } },
          synth: {
            source: { type: 's3', options: { bucketName: 'b' } },
            plugin: { name: 'cdk-synth', version: '1.0.0' },
            metadata: { SYNTH_KEY: 'synth', DEFAULT_KEY: 'synth-override' },
          },
        } as any),
      );

      expect(config.metadata.merged).toEqual(
        expect.objectContaining({
          GLOBAL_KEY: 'overridden',
          DEFAULT_KEY: 'synth-override',
          SYNTH_KEY: 'synth',
        }),
      );
    });
  });

  describe('source option extraction', () => {
    it('getS3Options applies defaults', () => {
      const config = new PipelineConfiguration(validProps());
      const s3 = config.getS3Options();

      expect(s3.bucketName).toBe('my-bucket');
      expect(s3.objectKey).toBe('source.zip');
      expect(s3.trigger).toBe('NONE');
    });

    it('getS3Options throws for non-S3 source', () => {
      const config = new PipelineConfiguration(
        validProps({
          synth: {
            source: { type: 'github', options: { repo: 'owner/repo' } },
            plugin: { name: 'cdk-synth', version: '1.0.0' },
          },
        } as any),
      );

      expect(() => config.getS3Options()).toThrow('Source type is not S3');
    });

    it('getGitHubOptions applies defaults', () => {
      const config = new PipelineConfiguration(
        validProps({
          synth: {
            source: { type: 'github', options: { repo: 'owner/repo' } },
            plugin: { name: 'cdk-synth', version: '1.0.0' },
          },
        } as any),
      );
      const gh = config.getGitHubOptions();

      expect(gh.repo).toBe('owner/repo');
      expect(gh.branch).toBe('main');
      expect(gh.trigger).toBe('NONE');
    });

    it('getCodeStarOptions applies defaults', () => {
      const config = new PipelineConfiguration(
        validProps({
          synth: {
            source: { type: 'codestar', options: { repo: 'owner/repo', connectionArn: 'arn:aws:codestar:...' } },
            plugin: { name: 'cdk-synth', version: '1.0.0' },
          },
        } as any),
      );
      const cs = config.getCodeStarOptions();

      expect(cs.repo).toBe('owner/repo');
      expect(cs.branch).toBe('main');
      expect(cs.trigger).toBe('NONE');
      expect(cs.codeBuildCloneOutput).toBe(false);
    });
  });
});
