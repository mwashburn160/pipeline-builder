import { ComputeType as CDKComputeType } from 'aws-cdk-lib/aws-codebuild';
import { CodeBuildStep, ShellStep } from 'aws-cdk-lib/pipelines';
import { createLogger } from './logger';
import { PluginType, ComputeType, MetaDataType, SourceType } from './pipeline-types';
import { Config, CoreConstants } from '../config/app-config';
import { CodeBuildStepOptions, CodeStarOptions, CodeStarSource, GitHubOptions, GitHubSource, PluginOptions, S3Options, S3Source, SynthOptions } from '../pipeline/pipeline-types';

const log = createLogger('Helper');

/**
 * Merge multiple metadata objects into one, with logging
 */
export function merge(...sources: Array<Partial<MetaDataType>>): MetaDataType {
  const merged = sources.reduce((acc, curr) => ({ ...acc, ...curr }), {}) as MetaDataType;
  return merged;
}

/**
 * Create a CodeBuild step or Shell step based on plugin configuration
 */
export function createCodeBuildStep(options: CodeBuildStepOptions): ShellStep | CodeBuildStep {
  const { id, plugin, input, metadata } = options;
  const config = Config.get();

  // Merge plugin metadata with provided metadata
  const merged = merge(metadata ?? {}, plugin.metadata ?? {});

  log.debug('[CreateCodeBuildStep] Building step with merged metadata');

  // Build environment variables
  const env = { ...(plugin.env ?? {}) };

  // Add WORKDIR if specified in metadata
  if (merged.WORKDIR) {
    env.WORKDIR = merged.WORKDIR as string;
  }

  // Setup bootstrap and commands
  const bootstrap = 'export WORKDIR=${WORKDIR:-./}; cd ${WORKDIR}';
  const installCommands = [bootstrap, ...(plugin.installCommands ?? [])];
  const commands = [bootstrap, ...(plugin.commands ?? [''])];

  const common = { input, installCommands, commands };

  // Return ShellStep if plugin type is SHELL_STEP
  if (plugin.pluginType === PluginType.SHELL_STEP) {
    return new ShellStep(id, {
      ...buildConfigFromMetadata(merged, 'pipelines:shellstep', {
        booleanKeys: ['isSource'],
        passthroughKeys: ['commands', 'consumedStackOutputs', 'dependencies', 'dependencyFileSets', 'env', 'envFromCfnOutputs', 'inputs', 'installCommands', 'outputs', 'primaryOutput'],
      }),
      ...common,
      env,
    });
  }

  // Convert env object to CodeBuild environment variables format
  const environmentVariables = Object.fromEntries(
    Object.entries(env).map(([name, value]) => [name, { value }]),
  );

  // Use compute type from plugin or default from config
  const computeType = getComputeType(
    plugin.computeType ?? config.aws.codeBuild.computeType,
  );

  // Return CodeBuildStep
  return new CodeBuildStep(id, {
    ...buildConfigFromMetadata(merged, 'pipelines:codebuildstep', {
      booleanKeys: ['isSource'],
      passthroughKeys: ['consumedStackOutputs', 'dependencies', 'dependencyFileSets', 'env', 'envFromCfnOutputs', 'grantPrincipal', 'inputs', 'outputs', 'project', 'actionRole', 'cache', 'fileSystemLocations', 'logging', 'partialBuildSpec', 'primaryOutput', 'projectName', 'role', 'rolePolicyStatements', 'securityGroups', 'subnetSelection', 'timeout', 'vpc'],
    }),
    ...common,
    buildEnvironment: {
      ...buildConfigFromMetadata(merged, 'codebuild:buildenvironment', {
        booleanKeys: ['privileged'],
        passthroughKeys: ['buildImage', 'certificate', 'dockerServer', 'fleet'],
      }),
      computeType,
      environmentVariables,
    },
  });
}

/**
 * Convert string or ComputeType enum to CDK ComputeType
 */
export function getComputeType(input: string | CDKComputeType = 'SMALL'): CDKComputeType {
  // If already a CDK ComputeType, return as-is
  if (typeof input !== 'string') {
    return input;
  }

  const normalized = input.toUpperCase() as ComputeType;

  const mapping: Record<ComputeType, CDKComputeType> = {
    [ComputeType.SMALL]: CDKComputeType.SMALL,
    [ComputeType.MEDIUM]: CDKComputeType.MEDIUM,
    [ComputeType.LARGE]: CDKComputeType.LARGE,
    [ComputeType.X2_LARGE]: CDKComputeType.X2_LARGE,
  };

  return mapping[normalized] ?? CDKComputeType.SMALL;
}

/**
 * Generate a custom AWS key with the standard prefix
 */
export function getCustomKey(prefix: string, key: string): string {
  return `${CoreConstants.CUSTOM_TAG_PREFIX}${prefix}:${key}`.toLowerCase();
}

/**
 * Check if a value represents true
 */
export function isTrue(value: any): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }
  return false;
}

/**
 * Build configuration object from metadata using a namespace
 * @param metadata - The metadata object to extract values from
 * @param namespace - The namespace prefix for keys
 * @param options - Configuration for boolean and passthrough keys
 * @returns Configuration object with extracted values
 */
export function buildConfigFromMetadata(
  metadata: MetaDataType,
  namespace: string,
  options: {
    booleanKeys?: readonly string[];
    passthroughKeys?: readonly string[];
  }): Record<string, any> {
  const { booleanKeys = [], passthroughKeys = [] } = options;

  return {
    ...Object.fromEntries(
      booleanKeys.map(key => [key, isTrue(metadata[getCustomKey(namespace, key)])]),
    ),
    ...Object.fromEntries(
      passthroughKeys.map(key => [key, metadata[getCustomKey(namespace, key)]]),
    ),
  };
}

export function parseStringToBoolean(str: string | null | undefined): boolean {
  if (!str) return false;

  const normalized = str.trim().toLowerCase();

  return ['true', '1', 'yes', 'y', 'on'].includes(normalized);
}

/**
 * Type guard to check if a source is an S3Source
 */
export function isS3Source(source: SourceType): source is S3Source {
  return source.type === 's3';
}

/**
 * Type guard to check if a source is a GitHubSource
 */
export function isGitHubSource(source: SourceType): source is GitHubSource {
  return source.type === 'github';
}

/**
 * Type guard to check if a source is a CodeStarSource
 */
export function isCodeStarSource(source: SourceType): source is CodeStarSource {
  return source.type === 'codestar';
}

/**
 * Validates S3Options for required fields and proper format
 * @throws Error if validation fails
 */
export function validateS3Options(options: S3Options): void {
  if (!options.bucketName) {
    throw new Error('S3Options.bucketName is required');
  }

  if (options.bucketName.length < 3 || options.bucketName.length > 63) {
    throw new Error(
      `Invalid S3 bucket name: "${options.bucketName}". ` +
      'Bucket names must be between 3 and 63 characters long.',
    );
  }

  // Basic bucket name validation (lowercase, numbers, hyphens, periods)
  const bucketNamePattern = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/;
  if (!bucketNamePattern.test(options.bucketName)) {
    throw new Error(
      `Invalid S3 bucket name: "${options.bucketName}". ` +
      'Bucket names can only contain lowercase letters, numbers, hyphens, and periods.',
    );
  }
}

/**
 * Validates GitHubOptions for required fields and proper format
 * @throws Error if validation fails
 */
export function validateGitHubOptions(options: GitHubOptions): void {
  if (!options.repo) {
    throw new Error('GitHubOptions.repo is required');
  }

  if (!options.repo.includes('/')) {
    throw new Error(
      `Invalid GitHub repository format: "${options.repo}". ` +
      'Expected format: "owner/repo"',
    );
  }

  const parts = options.repo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid GitHub repository format: "${options.repo}". ` +
      'Expected format: "owner/repo"',
    );
  }
}

/**
 * Validates CodeStarOptions for required fields and proper format
 * @throws Error if validation fails
 */
export function validateCodeStarOptions(options: CodeStarOptions): void {
  if (!options.repo) {
    throw new Error('CodeStarOptions.repo is required');
  }

  if (!options.connectionArn) {
    throw new Error('CodeStarOptions.connectionArn is required');
  }

  // Validate ARN format if it's a string
  if (typeof options.connectionArn === 'string') {
    const arnPattern = /^arn:aws:codestar-connections:[a-z0-9-]+:\d{12}:connection\/[a-z0-9-]+$/;
    if (!arnPattern.test(options.connectionArn)) {
      throw new Error(
        `Invalid CodeStar connection ARN: "${options.connectionArn}". ` +
        'Expected format: arn:aws:codestar-connections:region:account-id:connection/connection-id',
      );
    }
  }
}

/**
 * Validates PluginOptions for required fields
 * @throws Error if validation fails
 */
export function validatePluginOptions(options: PluginOptions): void {
  if (!options.name) {
    throw new Error('PluginOptions.name is required');
  }

  if (options.name.trim().length === 0) {
    throw new Error('PluginOptions.name cannot be empty or whitespace');
  }
}

/**
 * Validates SynthOptions for required fields
 * @throws Error if validation fails
 */
export function validateSynthOptions(options: SynthOptions): void {
  if (!options.source) {
    throw new Error('SynthOptions.source is required');
  }

  if (!options.plugin) {
    throw new Error('SynthOptions.plugin is required');
  }

  validatePluginOptions(options.plugin);

  // Validate source-specific options
  switch (options.source.type) {
    case 's3':
      validateS3Options(options.source.options);
      break;
    case 'github':
      validateGitHubOptions(options.source.options);
      break;
    case 'codestar':
      validateCodeStarOptions(options.source.options);
      break;
    default:
      const exhaustiveCheck: never = options.source;
      throw new Error(`Unknown source type: ${(exhaustiveCheck as any).type}`);
  }
}

/**
 * Replaces all characters that are not letters or numbers with the specified value
 * @param input - The string to process
 * @param replaceValue - The character(s) to replace non-alphanumeric characters with (default: '_')
 * @returns The string with non-alphanumeric characters replaced
 */
export function replaceNonAlphanumeric(input: string, replaceValue: string = '_'): string {
  return input.replace(/[^a-zA-Z0-9]/g, replaceValue);
}