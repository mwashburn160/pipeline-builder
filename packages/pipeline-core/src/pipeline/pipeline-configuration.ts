import type { BuilderProps } from './pipeline-builder';
import type { CodeStarOptions, GitHubOptions, S3Options } from './source-types';
import type { PluginOptions, StageOptions, StepCustomization } from './step-types';
import type { CodeBuildDefaults, NetworkConfig } from '../core/network-types';
import { merge, replaceNonAlphanumeric } from '../core/pipeline-helpers';
import type { MetaDataType, SourceType } from '../core/pipeline-types';
import { TriggerType } from '../core/pipeline-types';

/**
 * Validated and processed pipeline configuration (business logic layer).
 * This class handles all non-CDK logic: validation, sanitization, and metadata merging.
 * It can be tested independently without CDK dependencies.
 *
 * ## Metadata merge chain (last wins)
 *
 * 1. `BuilderProps.global` — base metadata inherited by all steps
 * 2. `BuilderProps.defaults.metadata` — pipeline-level CodeBuild defaults metadata
 * 3. `BuilderProps.synth.metadata` or `StageStepOptions.metadata` — per-step metadata
 * 4. `plugin.metadata` — plugin's own metadata (merged in `createCodeBuildStep`)
 * 5. `MetadataBuilder.forXxx()` — extracted CDK props spread last into construct calls
 *
 * Steps 1–3 are merged here into `this.metadata.merged`.
 * Step 4 happens in `createCodeBuildStep` via `merge(metadata, plugin.metadata)`.
 * Step 5 is spread last in the CDK constructor call, giving metadata full override authority.
 */
export class PipelineConfiguration {
  public readonly project: string;
  public readonly organization: string;
  public readonly pipelineName: string;
  public readonly metadata: {
    readonly global: MetaDataType;
    readonly synth: MetaDataType;
    readonly merged: MetaDataType;
  };
  public readonly source: SourceType;
  public readonly plugin: PluginOptions;
  public readonly network: NetworkConfig | undefined;
  public readonly defaults: CodeBuildDefaults | undefined;
  public readonly synthCustomization: StepCustomization;
  public readonly stages: StageOptions[] | undefined;

  constructor(props: BuilderProps) {
    this.validateProps(props);

    // Sanitize project and organization names
    this.project = replaceNonAlphanumeric(props.project, '_').toLowerCase();
    this.organization = replaceNonAlphanumeric(props.organization, '_').toLowerCase();

    // Calculate pipeline name
    this.pipelineName = props.pipelineName ?? `${this.organization}-${this.project}-pipeline`;

    // Metadata merging: global → defaults → synth-specific
    const global = { ...(props.global ?? {}) };
    const withDefaults = merge(global, props.defaults?.metadata ?? {});
    this.metadata = {
      global,
      synth: props.synth.metadata ?? {},
      merged: merge(withDefaults, props.synth.metadata ?? {}),
    };

    // Expose synth/builder properties directly
    this.source = props.synth.source;
    this.plugin = props.synth.plugin;
    this.network = props.synth.network;
    this.defaults = props.defaults;
    this.synthCustomization = {
      preInstallCommands: props.synth.preInstallCommands,
      postInstallCommands: props.synth.postInstallCommands,
      preCommands: props.synth.preCommands,
      postCommands: props.synth.postCommands,
      env: props.synth.env,
    };
    this.stages = props.stages;
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
    } else if (!props.synth.plugin.name?.trim()) {
      errors.push('BuilderProps.synth.plugin.name must be a non-empty string');
    }

    // Validate repo format for GitHub and CodeStar sources (both use "owner/repo")
    const sourceType = props.synth?.source?.type;
    if (sourceType === 'github' || sourceType === 'codestar') {
      const repo = props.synth.source.options.repo;
      if (repo && !repo.includes('/')) {
        errors.push(`Invalid ${sourceType} repository format: "${repo}". Expected format: "owner/repo"`);
      }
    }

    // Validate pipeline name length (AWS max 100 characters)
    const MAX_PIPELINE_NAME_LENGTH = 100;
    const pipelineName = props.pipelineName
      ?? `${replaceNonAlphanumeric(props.organization ?? '', '_').toLowerCase()}-${replaceNonAlphanumeric(props.project ?? '', '_').toLowerCase()}-pipeline`;
    if (pipelineName.length > MAX_PIPELINE_NAME_LENGTH) {
      errors.push(`Pipeline name "${pipelineName}" exceeds AWS maximum of ${MAX_PIPELINE_NAME_LENGTH} characters (${pipelineName.length})`);
    }

    // Validate stages
    if (props.stages) {
      const stageNames = new Set<string>();
      for (const stage of props.stages) {
        if (!stage.stageName?.trim()) {
          errors.push('Each stage must have a non-empty stageName');
        } else if (stageNames.has(stage.stageName)) {
          errors.push(`Duplicate stage name: "${stage.stageName}"`);
        } else {
          stageNames.add(stage.stageName);
        }
        if (!stage.steps?.length) {
          errors.push(`Stage "${stage.stageName ?? '(unnamed)'}" must have at least one step`);
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(
        'Pipeline configuration validation failed:\n' +
        errors.map(e => `  - ${e}`).join('\n'),
      );
    }
  }

  /**
   * Extracts S3 source options with defaults applied
   */
  getS3Options(): Required<Pick<S3Options, 'bucketName' | 'objectKey' | 'trigger'>> & Omit<S3Options, 'bucketName' | 'objectKey' | 'trigger'> {
    const source = this.source;
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
    const source = this.source;
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
    const source = this.source;
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
