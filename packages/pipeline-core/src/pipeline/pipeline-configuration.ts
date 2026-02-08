import type { BuilderProps } from './pipeline-builder';
import type { CodeStarOptions, GitHubOptions, S3Options } from './source-types';
import { merge, replaceNonAlphanumeric } from '../core/pipeline-helpers';
import type { MetaDataType } from '../core/pipeline-types';
import { TriggerType } from '../core/pipeline-types';

/**
 * Validated and processed pipeline configuration (business logic layer).
 * This class handles all non-CDK logic: validation, sanitization, and metadata merging.
 * It can be tested independently without CDK dependencies.
 */
export class PipelineConfiguration {
  public readonly project: string;
  public readonly organization: string;
  public readonly pipelineName: string;
  public readonly mergedMetadata: MetaDataType;
  public readonly synthMetadata: MetaDataType;
  public readonly globalMetadata: MetaDataType;

  constructor(private readonly props: BuilderProps) {
    this.validateProps(props);

    // Sanitize project and organization names
    this.project = replaceNonAlphanumeric(props.project, '_').toLowerCase();
    this.organization = replaceNonAlphanumeric(props.organization, '_').toLowerCase();

    // Calculate pipeline name
    this.pipelineName = props.pipelineName ?? `${this.organization}-${this.project}-pipeline`;

    // Metadata merging: global → defaults → synth-specific
    this.globalMetadata = { ...(props.global ?? {}) };
    const withDefaults = merge(this.globalMetadata, props.defaults?.metadata ?? {});
    this.mergedMetadata = merge(withDefaults, props.synth.metadata ?? {});
    this.synthMetadata = props.synth.metadata ?? {};
  }

  /**
   * Validates BuilderProps to ensure all required fields are present.
   * Throws an error with detailed messages if validation fails.
   */
  private validateProps(props: BuilderProps): void {
    const errors: string[] = [];

    if (!props.project) {
      errors.push('BuilderProps.project is required');
    }

    if (!props.organization) {
      errors.push('BuilderProps.organization is required');
    }

    if (!props.synth?.source) {
      errors.push('BuilderProps.synth.source is required');
    }

    if (!props.synth?.plugin) {
      errors.push('BuilderProps.synth.plugin is required');
    }

    if (errors.length > 0) {
      throw new Error(
        'Pipeline configuration validation failed:\n' +
        errors.map(e => `  - ${e}`).join('\n'),
      );
    }
  }

  /**
   * Validates GitHub repository format
   * @throws Error if format is invalid
   */
  validateGitHubRepo(repo: string): void {
    if (!repo.includes('/')) {
      throw new Error(
        `Invalid GitHub repository format: "${repo}". ` +
        'Expected format: "owner/repo"',
      );
    }
  }

  /**
   * Gets the source configuration
   */
  getSource(): BuilderProps['synth']['source'] {
    return this.props.synth.source;
  }

  /**
   * Gets the plugin configuration
   */
  getPlugin(): BuilderProps['synth']['plugin'] {
    return this.props.synth.plugin;
  }

  /**
   * Gets the network configuration
   */
  getNetwork(): BuilderProps['synth']['network'] {
    return this.props.synth.network;
  }

  /**
   * Gets the defaults configuration
   */
  getDefaults(): BuilderProps['defaults'] {
    return this.props.defaults;
  }

  /**
   * Extracts S3 source options with defaults applied
   */
  getS3Options(): Required<Pick<S3Options, 'bucketName' | 'objectKey' | 'trigger'>> & Omit<S3Options, 'bucketName' | 'objectKey' | 'trigger'> {
    const source = this.getSource();
    if (source.type !== 's3') {
      throw new Error('Source type is not S3');
    }

    return {
      ...source.options,
      objectKey: source.options.objectKey ?? 'source.zip',
      trigger: source.options.trigger ?? TriggerType.NONE,
    };
  }

  /**
   * Extracts GitHub source options with defaults applied
   */
  getGitHubOptions(): Required<Pick<GitHubOptions, 'repo' | 'branch' | 'trigger'>> & Omit<GitHubOptions, 'repo' | 'branch' | 'trigger'> {
    const source = this.getSource();
    if (source.type !== 'github') {
      throw new Error('Source type is not GitHub');
    }

    return {
      ...source.options,
      branch: source.options.branch ?? 'main',
      trigger: source.options.trigger ?? TriggerType.NONE,
    };
  }

  /**
   * Extracts CodeStar source options with defaults applied
   */
  getCodeStarOptions(): Required<Pick<CodeStarOptions, 'repo' | 'branch' | 'trigger' | 'codeBuildCloneOutput' | 'connectionArn'>> {
    const source = this.getSource();
    if (source.type !== 'codestar') {
      throw new Error('Source type is not CodeStar');
    }

    return {
      ...source.options,
      branch: source.options.branch ?? 'main',
      trigger: source.options.trigger ?? TriggerType.NONE,
      codeBuildCloneOutput: source.options.codeBuildCloneOutput ?? false,
    };
  }
}
