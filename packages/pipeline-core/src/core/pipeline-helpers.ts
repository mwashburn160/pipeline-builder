import { createLogger } from '@mwashburn160/api-core';
import { ComputeType as CDKComputeType } from 'aws-cdk-lib/aws-codebuild';
import { CodeBuildStep, ShellStep } from 'aws-cdk-lib/pipelines';
import { buildConfigFromMetadata, Namespace } from './metadata';
import { resolveNetwork } from './network';
import { PluginType, ComputeType, MetaDataType } from './pipeline-types';
import { Config } from '../config/app-config';
import { CodeBuildStepOptions } from '../pipeline/step-types';

const log = createLogger('Helper');

/**
 * Merge multiple metadata objects into one. Later sources override earlier ones.
 */
export function merge(...sources: Array<Partial<MetaDataType>>): MetaDataType {
  return Object.assign({}, ...sources) as MetaDataType;
}

/**
 * Create a CodeBuild step or Shell step based on plugin configuration.
 *
 * Spread order (last wins):
 *   programmatic defaults (input, commands, env, network) → metadata overrides
 *
 * This means metadata keys like `aws:cdk:pipelines:codebuildstep:commands`
 * will override the plugin-derived commands when explicitly set.
 */
export function createCodeBuildStep(options: CodeBuildStepOptions): ShellStep | CodeBuildStep {
  const { id, plugin, input, metadata, network, scope } = options;
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

  const programmatic = { input, installCommands, commands };

  // Return ShellStep if plugin type is SHELL_STEP
  if (plugin.pluginType === PluginType.SHELL_STEP) {
    return new ShellStep(id, {
      ...programmatic,
      env,
      ...buildConfigFromMetadata(merged, Namespace.SHELL_STEP),
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

  // Resolve network configuration into CDK props
  const networkProps = network
    ? resolveNetwork(scope, options.uniqueId, network)
    : {};

  // Return CodeBuildStep — metadata spread last so it can override programmatic defaults
  return new CodeBuildStep(id, {
    ...programmatic,
    ...networkProps,
    buildEnvironment: {
      computeType,
      environmentVariables,
      ...buildConfigFromMetadata(merged, Namespace.BUILD_ENVIRONMENT),
    },
    ...buildConfigFromMetadata(merged, Namespace.CODE_BUILD_STEP),
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
 * Replaces all characters that are not letters or numbers with the specified value
 * @param input - The string to process
 * @param replaceValue - The character(s) to replace non-alphanumeric characters with (default: '_')
 * @returns The string with non-alphanumeric characters replaced
 */
export function replaceNonAlphanumeric(input: string, replaceValue: string = '_'): string {
  return input.replace(/[^a-zA-Z0-9]/g, replaceValue);
}
