import { createLogger } from '@mwashburn160/api-core';
import type { Plugin } from '@mwashburn160/pipeline-data';
import { SecretValue } from 'aws-cdk-lib';
import { ComputeType as CDKComputeType } from 'aws-cdk-lib/aws-codebuild';
import { CodeBuildStep, ShellStep } from 'aws-cdk-lib/pipelines';
import { MetadataBuilder } from './metadata-builder';
import { resolveNetwork } from './network';
import { PluginType, ComputeType, MetaDataType } from './pipeline-types';
import { CodeBuildStepOptions } from '../pipeline/step-types';

const log = createLogger('Helper');

/**
 * Merge multiple metadata objects into one. Later sources override earlier ones.
 */
export function merge(...sources: Array<Partial<MetaDataType>>): MetaDataType {
  return Object.assign({}, ...sources) as MetaDataType;
}

/**
 * Build environment variables from plugin config and merged metadata.
 * Adds WORKDIR from metadata if specified.
 */
function buildEnv(plugin: Plugin, metadata: MetaDataType): Record<string, string> {
  const env = { ...(plugin.env ?? {}) };
  if (metadata.WORKDIR) {
    env.WORKDIR = String(metadata.WORKDIR);
  }
  return env;
}

/**
 * Build bootstrap-prefixed install and build commands from plugin config.
 * Each command list is prepended with a WORKDIR bootstrap that defaults to './'.
 */
function buildCommands(plugin: Plugin): { installCommands: string[]; commands: string[] } {
  const bootstrap = 'export WORKDIR=${WORKDIR:-./}; cd ${WORKDIR}';
  return {
    installCommands: [bootstrap, ...(plugin.installCommands ?? [])],
    commands: [bootstrap, ...(plugin.commands ?? [''])],
  };
}

/**
 * Convert a plain env record to CodeBuild's environmentVariables format.
 */
function toCodeBuildEnvVars(env: Record<string, string>): Record<string, { value: string }> {
  return Object.fromEntries(
    Object.entries(env).map(([name, value]) => [name, { value }]),
  );
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

  const merged = merge(metadata ?? {}, plugin.metadata ?? {});
  const metadataBuilder = MetadataBuilder.from(merged);

  log.debug('[CreateCodeBuildStep] Building step with merged metadata');

  const env = buildEnv(plugin, merged);
  const { installCommands, commands } = buildCommands(plugin);
  const programmatic = { input, installCommands, commands };

  // Return ShellStep if plugin type is SHELL_STEP
  if (plugin.pluginType === PluginType.SHELL_STEP) {
    return new ShellStep(id, {
      ...programmatic,
      env,
      ...metadataBuilder.forShellStep(),
    });
  }

  const computeType = getComputeType(
    plugin.computeType ?? options.defaultComputeType ?? 'SMALL',
  );

  const networkProps = network
    ? resolveNetwork(scope, options.uniqueId, network)
    : {};

  // Metadata spread last so it can override programmatic defaults
  return new CodeBuildStep(id, {
    ...programmatic,
    ...networkProps,
    buildEnvironment: {
      computeType,
      environmentVariables: toCodeBuildEnvVars(env),
      ...metadataBuilder.forBuildEnvironment(),
    },
    ...metadataBuilder.forCodeBuildStep(),
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

/**
 * Unwrap a SecretValue | string into a plain string.
 * When a SecretValue is provided (e.g. from Secrets Manager), calls unsafeUnwrap()
 * to extract the underlying value.
 */
export function unwrapSecret(value: SecretValue | string): string {
  return typeof value === 'string' ? value : value.unsafeUnwrap();
}
