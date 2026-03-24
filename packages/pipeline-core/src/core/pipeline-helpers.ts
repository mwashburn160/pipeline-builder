import { createLogger } from '@mwashburn160/api-core';
import type { Plugin } from '@mwashburn160/pipeline-data';
import { Duration, SecretValue } from 'aws-cdk-lib';
import { BuildEnvironmentVariableType, ComputeType as CDKComputeType } from 'aws-cdk-lib/aws-codebuild';
import { CodeBuildStep, ManualApprovalStep, ShellStep } from 'aws-cdk-lib/pipelines';
import type { ArtifactKey } from './artifact-manager';
import { metadataForShellStep, metadataForCodeBuildStep, metadataForBuildEnvironment } from './metadata-builder';
import { resolveNetwork } from './network';
import { PluginType, ComputeType, MetaDataType, CDK_METADATA_PREFIX } from './pipeline-types';
import { CoreConstants } from '../config/app-config';
import type { CodeBuildStepOptions, StepCustomization } from '../pipeline/step-types';

const log = createLogger('Helper');

/**
 * Merge multiple metadata objects into one. Later sources override earlier ones.
 */
export function merge(...sources: Array<Partial<MetaDataType>>): MetaDataType {
  return Object.assign({}, ...sources) as MetaDataType;
}

/**
 * Extract non-namespaced metadata keys as environment variable strings.
 * Keys starting with 'aws:cdk:' are reserved for CDK construct props
 * (processed by metadata extraction functions) and are excluded here.
 *
 * All values are converted to strings for CodeBuild compatibility.
 */
export function extractMetadataEnv(metadata: MetaDataType): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!key.startsWith(CDK_METADATA_PREFIX)) {
      env[key] = String(value);
    }
  }
  return env;
}

/**
 * Build environment variables from plugin config, merged metadata, and custom env.
 *
 * Merge order (last wins):
 *   1. plugin.env — plugin default env vars (lowest priority)
 *   2. non-namespaced metadata keys — e.g. PYTHON_VERSION, WORKDIR
 *   3. customEnv — per-step custom env vars (highest priority)
 */
const BOOTSTRAP_CMD = 'export WORKDIR=${WORKDIR:-./}; cd ${WORKDIR}';

function buildEnv(plugin: Plugin, metadata: MetaDataType, customEnv?: Record<string, string>): Record<string, string> {
  return {
    ...(plugin.env ?? {}),
    ...extractMetadataEnv(metadata),
    ...(customEnv ?? {}),
  };
}

/**
 * Wrap build commands based on failure behavior.
 * - 'fail' (default): No wrapping — commands fail the pipeline naturally.
 * - 'warn': Run commands with `set +e`, capture failures, log warnings, continue.
 * - 'ignore': Append `|| true` to each command — failures are silently swallowed.
 *
 * Only applied to build commands, not install commands (install failures should always stop the build).
 */
function wrapCommandsForFailureBehavior(commands: string[], behavior?: 'fail' | 'warn' | 'ignore'): string[] {
  if (!behavior || behavior === 'fail') return commands;

  if (behavior === 'ignore') {
    return commands.map(cmd => `${cmd} || true`);
  }

  // 'warn': run all commands, capture failures, but don't stop
  return [
    'set +e',
    '_STEP_EXIT=0',
    ...commands.map(cmd => `${cmd} || { echo "WARNING: Command failed with exit code $?"; _STEP_EXIT=1; }`),
    'set -e',
    'if [ "$_STEP_EXIT" -ne 0 ]; then echo "WARNING: One or more commands in this step failed"; fi',
  ];
}

/**
 * Build bootstrap-prefixed install and build commands from plugin config.
 * Each command list is prepended with a WORKDIR bootstrap that defaults to './'.
 * When custom commands are provided, they are injected before/after the plugin's commands.
 * Build commands are optionally wrapped by failureBehavior logic.
 */
function buildCommands(plugin: Plugin, custom?: StepCustomization, failureBehavior?: 'fail' | 'warn' | 'ignore'): { installCommands: string[]; commands: string[] } {
  const userCommands = [
    ...(custom?.preCommands ?? []),
    ...(plugin.commands?.length ? plugin.commands : []),
    ...(custom?.postCommands ?? []),
  ];

  return {
    installCommands: [
      BOOTSTRAP_CMD,
      ...(custom?.preInstallCommands ?? []),
      ...(plugin.installCommands ?? []),
      ...(custom?.postInstallCommands ?? []),
    ],
    commands: [BOOTSTRAP_CMD, ...wrapCommandsForFailureBehavior(userCommands, failureBehavior)],
  };
}

/**
 * Convert a plain env record to CodeBuild's environmentVariables format (PLAINTEXT).
 */
function toCodeBuildEnvVars(env: Record<string, string>): Record<string, { value: string }> {
  return Object.fromEntries(
    Object.entries(env).map(([name, value]) => [name, { value }]),
  );
}

/**
 * Build SECRETS_MANAGER-type environment variables from plugin secret declarations.
 * Uses naming convention: pipeline-builder/{orgId}/{secretName}
 * Each org manages these secrets in their own AWS Secrets Manager.
 */
const VALID_SECRET_NAME = /^[a-zA-Z0-9/_+=.@-]+$/;

function toSecretEnvVars(
  secrets: Array<{ name: string; required: boolean }>,
  orgId: string,
): Record<string, { value: string; type: BuildEnvironmentVariableType }> {
  return Object.fromEntries(
    secrets.map(({ name }) => {
      const secretPath = `${CoreConstants.SECRETS_PATH_PREFIX}/${orgId}/${name}`;
      if (!VALID_SECRET_NAME.test(secretPath)) {
        throw new Error(`Secret path "${secretPath}" contains invalid characters for AWS Secrets Manager`);
      }
      return [
        name,
        {
          value: secretPath,
          type: BuildEnvironmentVariableType.SECRETS_MANAGER,
        },
      ];
    }),
  );
}

/**
 * Create a CodeBuild step or Shell step based on plugin configuration.
 *
 * Metadata merge order (last wins):
 *   1. Step-level metadata (from options.metadata)
 *   2. Plugin metadata (from plugin.metadata in database)
 *
 * Environment merge order (last wins):
 *   1. Plugin env vars (from plugin.env)
 *   2. Custom env vars (from options.env)
 *   3. WORKDIR from merged metadata
 *
 * CDK prop spread order (last wins):
 *   programmatic defaults (input, commands, env, network) → metadata overrides
 *
 * This means metadata keys like `aws:cdk:pipelines:codebuildstep:commands`
 * will override the plugin-derived commands when explicitly set.
 */
export function createCodeBuildStep(options: CodeBuildStepOptions): ShellStep | CodeBuildStep | ManualApprovalStep {
  const {
    id, plugin, input, metadata, network, scope,
    preInstallCommands, postInstallCommands, preCommands, postCommands,
    env: customEnv, additionalInputs, timeout, failureBehavior,
    artifactManager, stageName, stageAlias, pluginAlias, orgId,
  } = options;

  const merged = merge(metadata ?? {}, plugin.metadata ?? {});

  // ManualApprovalStep: no commands, env, compute, or network — just id + optional comment
  if (plugin.pluginType === PluginType.MANUAL_APPROVAL_STEP) {
    return new ManualApprovalStep(id, {
      comment: merged.APPROVAL_COMMENT as string | undefined,
    });
  }

  log.debug('[CreateCodeBuildStep] Building step with merged metadata');

  // Warn about required secrets without orgId (can't resolve)
  const requiredSecrets = plugin.secrets?.filter(s => s.required) ?? [];
  if (requiredSecrets.length > 0 && !orgId) {
    log.warn(
      `Plugin "${plugin.name}" declares ${requiredSecrets.length} required secret(s) but no orgId is available. ` +
      `Secrets will not be injected: ${requiredSecrets.map(s => s.name).join(', ')}`,
    );
  }

  // Resolve plugin secrets as SECRETS_MANAGER env vars
  const secretEnvVars = (plugin.secrets?.length && orgId)
    ? toSecretEnvVars(plugin.secrets, orgId)
    : {};

  const env = buildEnv(plugin, merged, customEnv);

  const outputDir = plugin.primaryOutputDirectory;
  const ensureOutputDir = (outputDir && !outputDir.includes('*'))
    ? [`mkdir -p "${outputDir}" && touch "${outputDir}/.gitkeep"`]
    : [];

  const { installCommands, commands } = buildCommands(plugin, {
    preInstallCommands: [...ensureOutputDir, ...(preInstallCommands ?? [])],
    postInstallCommands, preCommands, postCommands,
  }, failureBehavior);

  const programmatic = { input, installCommands, commands };

  // Return ShellStep if plugin type is SHELL_STEP
  if (plugin.pluginType === PluginType.SHELL_STEP) {
    return new ShellStep(id, {
      ...programmatic,
      env,
      ...metadataForShellStep(merged),
    });
  }

  const computeType = getComputeType(
    plugin.computeType ?? options.defaultComputeType ?? 'SMALL',
  );

  const networkProps = network
    ? resolveNetwork(scope, options.uniqueId, network)
    : {};

  // Metadata spread last so it can override programmatic defaults
  const step = new CodeBuildStep(id, {
    ...programmatic,
    ...networkProps,
    ...(additionalInputs && { additionalInputs }),
    ...(timeout && { timeout: Duration.minutes(timeout) }),
    primaryOutputDirectory: plugin.primaryOutputDirectory ?? undefined,
    buildEnvironment: {
      computeType,
      environmentVariables: {
        ...toCodeBuildEnvVars(env),
        ...secretEnvVars,
      },
      ...metadataForBuildEnvironment(merged),
    },
    ...metadataForCodeBuildStep(merged),
  });

  // Register with artifact manager if primaryOutputDirectory is set
  if (plugin.primaryOutputDirectory && artifactManager && stageName) {
    const artifactKey: ArtifactKey = {
      stageName,
      stageAlias: stageAlias ?? `${stageName}-alias`,
      pluginName: plugin.name,
      pluginAlias: pluginAlias ?? `${plugin.name}-alias`,
      outputDirectory: plugin.primaryOutputDirectory,
    };
    artifactManager.add(artifactKey, step);
  }

  return step;
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

  const result = mapping[normalized];
  if (!result) {
    log.warn(`Unknown compute type "${input}", falling back to SMALL`);
    return CDKComputeType.SMALL;
  }
  return result;
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
