// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import type { Plugin } from '@pipeline-builder/pipeline-data';
import { Duration, SecretValue, Stack } from 'aws-cdk-lib';
import { BuildEnvironmentVariableType, ComputeType as CDKComputeType, LinuxBuildImage, IBuildImage } from 'aws-cdk-lib/aws-codebuild';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { CodeBuildStep, ManualApprovalStep, ShellStep } from 'aws-cdk-lib/pipelines';
import type { Construct } from 'constructs';
import type { ArtifactKey } from './artifact-manager';
import { metadataForShellStep, metadataForCodeBuildStep, metadataForBuildEnvironment } from './metadata-builder';
import { resolveNetwork } from './network';
import { PluginType, ComputeType, MetaDataType, CDK_METADATA_PREFIX } from './pipeline-types';
import { Config, CoreConstants } from '../config/app-config';
import type { CodeBuildStepOptions, StepCustomization } from '../pipeline/step-types';
import { resolvePluginTemplates } from '../template/plugin-resolver';

const log = createLogger('pipeline-helpers');

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
      const secretPath = CoreConstants.secretPath(orgId, name);
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
/**
 * Resolve the CodeBuild image to use for a plugin.
 *
 * Strategy:
 *   1. If the plugin sets `aws:cdk:codebuild:buildenvironment:buildImage`
 *      explicitly in metadata, the metadata-builder passthrough handles it
 *      (via `metadataForBuildEnvironment`). This function returns
 *      `undefined` and the metadata wins.
 *   2. Otherwise, if the plugin has a `name`+`version` AND the registry
 *      config is populated, build a `LinuxBuildImage.fromDockerRegistry()`
 *      image pointing at `<registry-host>:<port>/<ns>/<name>:<version>`
 *      where `<ns>` is `system` or `org-<orgId>`. CodeBuild authenticates by
 *      sending the per-org platform Secret as Basic auth to
 *      `pipeline-image-registry`'s `/token` endpoint; the JWT in `password`
 *      resolves to a registry token scoped to the org.
 *   3. If `metadata_only`, return `undefined` so CodeBuild uses its default
 *      (`standard:7.0`).
 *
 * `scope` and `orgId` are required: the per-org platform Secret is named
 * `pipeline-builder/<orgId>/platform`, and `Secret.fromSecretNameV2()`
 * needs a Construct to anchor the imported secret to.
 */
export function resolvePluginImage(scope: Construct | undefined, plugin: Plugin, orgId?: string): IBuildImage | undefined {
  // `metadata_only` plugins legitimately have no image — their work runs
  // in the default CodeBuild image. Quiet skip.
  if (plugin.buildType === 'metadata_only') return undefined;

  // build_image / prebuilt plugins must have name + version (DB constraint
  // makes both NOT NULL). Defensive check in case a malformed row slips in.
  if (!plugin.name || !plugin.version) {
    log.warn(
      `Plugin "${plugin.name}" has buildType=${plugin.buildType} but missing name/version — ` +
      'CodeBuild will run on aws/codebuild/standard:7.0 and won\'t have the plugin\'s baked tools.',
    );
    return undefined;
  }

  let registry;
  try {
    registry = Config.get('registry');
  } catch {
    // Config namespace not loaded (e.g., unit tests without full config).
    log.warn(
      `Plugin "${plugin.name}:${plugin.version}" needs the registry config but it's not loaded — ` +
      'CodeBuild will fall back to aws/codebuild/standard:7.0. ' +
      'Set IMAGE_REGISTRY_HOST + IMAGE_REGISTRY_PORT in pipeline-manager\'s environment.',
    );
    return undefined;
  }

  if (!registry?.host) {
    log.warn(
      `Plugin "${plugin.name}:${plugin.version}" needs IMAGE_REGISTRY_HOST but it's empty — ` +
      'CodeBuild will fall back to aws/codebuild/standard:7.0. ' +
      'Set IMAGE_REGISTRY_HOST in pipeline-manager\'s environment to use the plugin image.',
    );
    return undefined;
  }
  if (!scope) {
    log.warn(`Plugin "${plugin.name}" image resolution skipped: no construct scope provided`);
    return undefined;
  }

  // Per-org auth requires orgId — the Secret is named per org.
  if (!orgId) {
    log.warn(
      `Plugin "${plugin.name}" image resolution skipped: orgId is required to ` +
      'resolve the per-org platform Secret used for CodeBuild Basic auth.',
    );
    return undefined;
  }

  // Compose the image URI. Namespace by ownership:
  //   - Plugins owned by the system org → `system/<name>:<version>`.
  //     pipeline-image-registry's token service grants pull on `system/*`
  //     to any authenticated org user (read-only catalog of shared plugins).
  //   - Plugins owned by a tenant org → `org-<orgId>/<name>:<version>`.
  //     The token service grants pull,push only to members of that org.
  // The plugin's own `orgId` (not the caller's) decides the namespace —
  // tenant pipelines pulling shared system plugins still get the `system/`
  // path because that's where the image actually lives.
  const portPart = registry.port && registry.port !== 80 && registry.port !== 443
    ? `:${registry.port}`
    : '';
  const SYSTEM_ORG_ID = 'system';
  const namespace = plugin.orgId === SYSTEM_ORG_ID
    ? 'system'
    : `org-${plugin.orgId}`;
  const imageUri = `${registry.host}${portPart}/${namespace}/${plugin.name}:${plugin.version}`;

  // CodeBuild reads `pipeline-builder/<orgId>/platform` and sends its
  // `username`/`password` fields as HTTP Basic to the registry. The
  // registry challenges with a Bearer realm pointing at
  // pipeline-image-registry's `/token` endpoint; the Docker client forwards
  // those creds, the password is verified as a platform JWT, and a registry
  // token scoped to the org is issued.
  //
  // Same Secret is read by the plugin-lookup Lambda (via the `password`
  // field) — one Secret serves both flows.
  const stack = Stack.of(scope);
  const secretName = CoreConstants.secretPath(orgId, 'platform');
  // CDK construct IDs allow only [A-Za-z0-9_-]; sanitize the secret name.
  const secretConstructId = `PlatformCreds_${secretName.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const credentialsSecret = (stack.node.tryFindChild(secretConstructId) as Secret | undefined)
    ?? Secret.fromSecretNameV2(stack, secretConstructId, secretName);

  return LinuxBuildImage.fromDockerRegistry(imageUri, {
    secretsManagerCredentials: credentialsSecret,
  });
}

/**
 * Resolve the fallback CodeBuild image for steps without a plugin-baked one.
 *
 * Reads `aws.codeBuild.defaultImage` (env: `CODEBUILD_DEFAULT_IMAGE`).
 * Default: `pipeline-bootstrap:1.0` — the local tag built by
 * `deploy/codebuild/bootstrap/Dockerfile`.
 *
 * - Bare tag (no `/`): auto-prefixed to
 *   `<registry-host>:<port>/library/<tag>` using the registry config,
 *   with the per-org platform Secret as Basic auth — same path
 *   `resolvePluginImage()` uses for plugin images. Needs `scope` + `orgId`.
 * - Fully-qualified registry URI (contains `/`): used as-is, no auth wired.
 * - Missing registry config or scope/orgId → falls back to
 *   `aws/codebuild/standard:7.0` with a warning, so synth never crashes
 *   on an under-configured environment.
 */
const STANDARD_7_0 = 'aws/codebuild/standard:7.0';
export function resolveDefaultBuildImage(scope?: Construct, orgId?: string): IBuildImage {
  let configured: string;
  try {
    configured = Config.get('aws').codeBuild.defaultImage;
  } catch {
    configured = STANDARD_7_0;
  }

  // Fully-qualified URI — operator owns it. No registry/Secret wiring.
  if (configured.includes('/')) {
    return LinuxBuildImage.fromDockerRegistry(configured);
  }

  // Bare tag → auto-prefix with the platform registry, mirroring
  // resolvePluginImage(). Bail to standard:7.0 (with a warning) at each
  // missing prerequisite so synth degrades gracefully on partially
  // configured environments instead of failing.
  let registry;
  try {
    registry = Config.get('registry');
  } catch {
    log.warn(
      `CODEBUILD_DEFAULT_IMAGE='${configured}' is a bare tag but registry config not loaded — ` +
      `falling back to ${STANDARD_7_0}. Set IMAGE_REGISTRY_HOST + IMAGE_REGISTRY_PORT.`,
    );
    return LinuxBuildImage.fromDockerRegistry(STANDARD_7_0);
  }
  if (!registry?.host) {
    log.warn(
      `CODEBUILD_DEFAULT_IMAGE='${configured}' is a bare tag but IMAGE_REGISTRY_HOST is empty — ` +
      `falling back to ${STANDARD_7_0}.`,
    );
    return LinuxBuildImage.fromDockerRegistry(STANDARD_7_0);
  }
  if (!scope || !orgId) {
    log.warn(
      `CODEBUILD_DEFAULT_IMAGE='${configured}' needs scope+orgId for Secret auth — ` +
      `falling back to ${STANDARD_7_0}. (Caller did not supply them.)`,
    );
    return LinuxBuildImage.fromDockerRegistry(STANDARD_7_0);
  }

  const portPart = registry.port && registry.port !== 80 && registry.port !== 443
    ? `:${registry.port}`
    : '';
  const imageUri = `${registry.host}${portPart}/library/${configured}`;

  // Same Secret as resolvePluginImage — per-org platform Secret, CodeBuild
  // sends it as Basic auth, image-registry verifies the JWT in `password`.
  const stack = Stack.of(scope);
  const secretName = CoreConstants.secretPath(orgId, 'platform');
  const secretConstructId = `PlatformCreds_${secretName.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const credentialsSecret = (stack.node.tryFindChild(secretConstructId) as Secret | undefined)
    ?? Secret.fromSecretNameV2(stack, secretConstructId, secretName);

  return LinuxBuildImage.fromDockerRegistry(imageUri, {
    secretsManagerCredentials: credentialsSecret,
  });
}

export function createCodeBuildStep(options: CodeBuildStepOptions): ShellStep | CodeBuildStep | ManualApprovalStep {
  const {
    id, input, metadata, network, scope,
    preInstallCommands, postInstallCommands, preCommands, postCommands,
    env: customEnv, additionalInputs, timeout, failureBehavior,
    artifactManager, stageName, stageAlias, pluginAlias, orgId, pipelineScope,
  } = options;

  // Resolve {{ ... }} templates in plugin spec fields against the pipeline scope.
  // Every call goes through the resolver — plugins without template tokens are
  // a no-op fast path inside resolvePluginTemplates().
  const plugin = resolvePluginTemplates(options.plugin, pipelineScope);

  const merged = merge(metadata ?? {}, plugin.metadata ?? {});

  // ManualApprovalStep: no commands, env, compute, or network — just id + optional comment
  if (plugin.pluginType === PluginType.MANUAL_APPROVAL_STEP) {
    return new ManualApprovalStep(id, {
      comment: typeof merged.APPROVAL_COMMENT === 'string' ? merged.APPROVAL_COMMENT : undefined,
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

  // CodePipeline resolved variables — must be in CodeBuildStep.env (action-level),
  // not buildEnvironment.environmentVariables (project-level)
  const actionEnv: Record<string, string> = {
    PIPELINE_EXECUTION_ID: '#{codepipeline.PipelineExecutionId}',
  };

  const outputDir = plugin.primaryOutputDirectory;
  const ensureOutputDir = (outputDir && !outputDir.includes('*'))
    ? [`mkdir -p "${outputDir}" && touch "${outputDir}/.gitkeep"`]
    : [];

  const { installCommands, commands } = buildCommands(plugin, {
    preInstallCommands: [...ensureOutputDir, ...(preInstallCommands ?? [])],
    postInstallCommands,
    preCommands,
    postCommands,
  }, failureBehavior);

  const programmatic = { input, installCommands, commands };

  // Resolve the plugin's runtime image. CodeBuild defaults to
  // `aws/codebuild/standard:7.0` when no `buildImage` is set — that's the
  // AWS-managed Ubuntu image and DOES NOT have any plugin-baked tools
  // (pipeline-manager, snyk, terraform, etc.). Wiring the plugin's image
  // here means CodeBuild pulls from our private registry and the tools
  // installed in the plugin's Dockerfile are actually available.
  const pluginBuildImage = resolvePluginImage(scope, plugin, orgId);

  // ShellStep branch.
  // ShellStep itself doesn't accept `buildEnvironment`/`buildImage`. CDK
  // pipelines wraps ShellSteps in a default CodeBuild action that runs on
  // `aws/codebuild/standard:7.0` — which won't have the plugin's tools.
  //
  // So when a SHELL_STEP plugin DOES have an image (because its author
  // baked tools into a Dockerfile), we PROMOTE it to a CodeBuildStep with
  // the resolved image. The plugin author's intent ("use my baked tools")
  // is preserved without forcing them to change pluginType.
  //
  // When the plugin has no image (or registry isn't configured), we keep
  // the original ShellStep — it's lighter weight and the default
  // CodeBuild image is fine.
  if (plugin.pluginType === PluginType.SHELL_STEP) {
    if (!pluginBuildImage) {
      return new ShellStep(id, {
        ...programmatic,
        env: { ...env, ...actionEnv },
        ...metadataForShellStep(merged),
      });
    }
    log.debug(`[CreateCodeBuildStep] SHELL_STEP plugin "${plugin.name}" has a registry image — promoting to CodeBuildStep so the plugin image is actually used`);
    // Fall through to the CodeBuildStep path below.
  }

  const computeType = getComputeType(
    plugin.computeType ?? options.defaultComputeType ?? 'SMALL',
  );

  const networkProps = network
    ? resolveNetwork(scope, options.uniqueId, network)
    : {};

  // Metadata spread last so it can override programmatic defaults.
  // NOTE: Caching is supported via two metadata paths:
  //   1. MetadataKeys.CACHE ('aws:cdk:pipelines:codebuildstep:cache') — passed directly
  //      as the CodeBuildStep `cache` prop (expects a codebuild.Cache object).
  //   2. MetadataKeys.PARTIAL_BUILD_SPEC ('aws:cdk:pipelines:codebuildstep:partialbuildspec')
  //      — passed as `partialBuildSpec`, which can include a `cache:` section for
  //      S3 or local caching (e.g., BuildSpec.fromObject({ cache: { paths: [...] } })).
  const step = new CodeBuildStep(id, {
    ...programmatic,
    ...networkProps,
    ...(additionalInputs && { additionalInputs }),
    ...(timeout && { timeout: Duration.minutes(timeout) }),
    env: actionEnv,
    primaryOutputDirectory: plugin.primaryOutputDirectory ?? undefined,
    buildEnvironment: {
      computeType,
      buildImage: pluginBuildImage ?? resolveDefaultBuildImage(scope, orgId),
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
