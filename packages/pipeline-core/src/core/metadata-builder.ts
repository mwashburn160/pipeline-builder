import { buildConfigFromMetadata, Namespace } from './metadata';
import type { MetaDataType } from './pipeline-types';

/**
 * Fluent API builder for extracting configuration from metadata.
 * Provides a convenient interface for converting metadata into
 * CDK construct configuration objects.
 *
 * @example
 * ```typescript
 * const metadata: MetaDataType = {
 *   'aws:cdk:pipelines:codepipeline:selfmutation': true,
 *   'aws:cdk:codebuild:buildenvironment:privileged': 'true',
 * };
 *
 * const builder = new MetadataBuilder(metadata);
 *
 * const pipelineConfig = builder.forCodePipeline();
 * // { selfMutation: true }
 *
 * const buildEnvConfig = builder.forBuildEnvironment();
 * // { privileged: true }
 * ```
 */
export class MetadataBuilder {
  constructor(private readonly metadata: MetaDataType) {}

  /**
   * Builds configuration for CodePipeline construct
   * @returns Configuration object for CodePipeline props
   */
  forCodePipeline(): Record<string, any> {
    return buildConfigFromMetadata(this.metadata, Namespace.CODE_PIPELINE);
  }

  /**
   * Builds configuration for CodeBuildStep construct
   * @returns Configuration object for CodeBuildStep props
   */
  forCodeBuildStep(): Record<string, any> {
    return buildConfigFromMetadata(this.metadata, Namespace.CODE_BUILD_STEP);
  }

  /**
   * Builds configuration for ShellStep construct
   * @returns Configuration object for ShellStep props
   */
  forShellStep(): Record<string, any> {
    return buildConfigFromMetadata(this.metadata, Namespace.SHELL_STEP);
  }

  /**
   * Builds configuration for BuildEnvironment (used in CodeBuildStep)
   * @returns Configuration object for BuildEnvironment props
   */
  forBuildEnvironment(): Record<string, any> {
    return buildConfigFromMetadata(this.metadata, Namespace.BUILD_ENVIRONMENT);
  }

  /**
   * Builds configuration for a custom namespace
   * @param namespace - Custom namespace string
   * @returns Configuration object extracted from metadata
   */
  forNamespace(namespace: string): Record<string, any> {
    return buildConfigFromMetadata(this.metadata, namespace);
  }

  /**
   * Gets all configuration objects for common CDK constructs
   * @returns Object containing all common configurations
   */
  buildAll(): {
    codePipeline: Record<string, any>;
    codeBuildStep: Record<string, any>;
    shellStep: Record<string, any>;
    buildEnvironment: Record<string, any>;
  } {
    return {
      codePipeline: this.forCodePipeline(),
      codeBuildStep: this.forCodeBuildStep(),
      shellStep: this.forShellStep(),
      buildEnvironment: this.forBuildEnvironment(),
    };
  }

  /**
   * Checks if metadata is empty
   */
  isEmpty(): boolean {
    return Object.keys(this.metadata).length === 0;
  }

  /**
   * Gets the underlying metadata object
   */
  getMetadata(): MetaDataType {
    return { ...this.metadata };
  }

  /**
   * Creates a new MetadataBuilder with additional metadata merged in
   * @param additional - Additional metadata to merge
   * @returns New MetadataBuilder with merged metadata
   */
  merge(additional: MetaDataType): MetadataBuilder {
    return new MetadataBuilder({ ...this.metadata, ...additional });
  }

  /**
   * Static factory method to create a builder from metadata
   * @param metadata - The metadata object
   * @returns New MetadataBuilder instance
   */
  static from(metadata: MetaDataType): MetadataBuilder {
    return new MetadataBuilder(metadata);
  }

  /**
   * Static factory method to create an empty builder
   * @returns New MetadataBuilder with empty metadata
   */
  static empty(): MetadataBuilder {
    return new MetadataBuilder({});
  }
}
