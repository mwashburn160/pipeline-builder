// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import type { Plugin } from '@pipeline-builder/pipeline-data';
import { Duration, SecretValue, Stack } from 'aws-cdk-lib';
import { BuildEnvironmentVariableType, BuildSpec, ComputeType as CDKComputeType, LinuxBuildImage, type IBuildImage } from 'aws-cdk-lib/aws-codebuild';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { CodeBuildStep, ManualApprovalStep, ShellStep } from 'aws-cdk-lib/pipelines';
import type { Construct } from 'constructs';
import { type ArtifactKey } from './artifact-manager.js';
import { metadataForShellStep, metadataForCodeBuildStep, metadataForBuildEnvironment, networkConfigFromMetadata } from './metadata-builder.js';
import { STEP_BOOTSTRAP_CMD, extractMetadataEnv, merge, wrapCommandsForFailureBehavior } from './metadata-helpers.js';
import { resolveNetwork } from './network.js';
import { PluginType, ComputeType, type MetaDataType } from './pipeline-types.js';
import { pluginArtifactAlias } from './plugin-contract.js';
import { SECURITY_REPORT_KEY_ENV, SECURITY_REPORT_SECRET_LEAF, SECURITY_REPORT_UPLOAD_ENV } from './security-reports.js';
import { CURATED_SELF_MUTATION_IMAGE } from './self-mutation.js';
import { PLUGIN_IMAGE_REPOSITORY_RE } from './step-manifest.js';
import { Config, CoreConstants } from '../config/app-config.js';
import type { CodeBuildStepOptions, StepCustomization } from '../pipeline/step-types.js';
import { resolvePluginTemplates } from '../template/plugin-resolver.js';

const log = createLogger('pipeline-helpers');

/**
 * Build environment variables from plugin config, merged metadata, and custom env.
 *
 * Merge order (last wins):
 *   1. plugin.env — plugin default env vars (lowest priority)
 *   2. non-namespaced metadata keys — e.g. PYTHON_VERSION, WORKDIR
 *   3. customEnv — per-step custom env vars (highest priority)
 */
function buildEnv(plugin: Plugin, metadata: MetaDataType, customEnv?: Record<string, string>): Record<string, string> {
  return {
    ...(plugin.env ?? {}),
    ...extractMetadataEnv(metadata),
    ...(customEnv ?? {}),
  };
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
      STEP_BOOTSTRAP_CMD,
      ...(custom?.preInstallCommands ?? []),
      ...(plugin.installCommands ?? []),
      ...(custom?.postInstallCommands ?? []),
    ],
    commands: [STEP_BOOTSTRAP_CMD, ...wrapCommandsForFailureBehavior(userCommands, failureBehavior)],
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

/**
 * Secrets Manager leaf holding the org's REGISTRY credential — the
 * `registry:push`-scoped service-account key CodeBuild presents as Basic auth to
 * pipeline-image-registry. Deliberately NOT `platform`: that secret holds
 * the org's full-privilege automation credential, and a build container has no
 * business being able to call the API with it.
 * Provisioned by `pipeline-manager infra store-token --scope registry:push`.
 */
const REGISTRY_CREDENTIAL_SECRET = 'registry-push';

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
 * In-cluster / local registry hostnames that AWS CodeBuild (out-of-cluster)
 * cannot resolve. Baking one of these into a CodeBuild image URI guarantees a
 * `BUILD_CONTAINER_UNABLE_TO_PULL_IMAGE` failure at build time, so we fail the
 * synth fast instead — with a message that says how to fix it.
 */
const UNREACHABLE_PULL_HOSTS = new Set(['registry', 'localhost', '127.0.0.1', '::1', '0.0.0.0']);

/** Kubernetes / mDNS suffixes that only resolve inside the cluster/LAN. */
const UNREACHABLE_HOST_SUFFIXES = ['.svc', '.svc.cluster.local', '.local'];

/**
 * Reduce a registry host value to its bare hostname for the reachability check:
 * strip IPv6 brackets and any `:port` suffix (an operator may put host+port in
 * one field), so `registry:5000` / `[::1]:5000` are still recognized.
 */
function bareHostname(rawHost: string): string {
  let h = rawHost.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end !== -1) return h.slice(1, end); // [::1]:5000 -> ::1
  }
  // Strip a trailing :port only for non-IPv6 values (IPv6 contains '::' or >1 ':').
  if (h.includes(':') && (h.match(/:/g)?.length ?? 0) === 1) h = h.split(':')[0];
  return h;
}

/** True when CodeBuild (out-of-cluster) could not resolve this registry host. */
function isUnreachablePullHost(rawHost: string): boolean {
  const h = bareHostname(rawHost);
  if (h === '') return true; // no host → malformed URI
  if (UNREACHABLE_PULL_HOSTS.has(h)) return true;
  return UNREACHABLE_HOST_SUFFIXES.some((s) => h.endsWith(s));
}

/**
 * Resolve the external (out-of-cluster) registry pull host + `:port` suffix for
 * a CodeBuild image URI, and fail fast if it resolved to an in-cluster/local
 * default that CodeBuild can't reach.
 *
 * Prefers `pullHost`/`pullPort` (the public endpoint CodeBuild can resolve) and
 * falls back to `host`/`port` for single-host deploys. pipeline-manager bakes
 * the right pull host into the synth automatically from the platform URL it
 * deploys against (`props.registry`); this guard catches the case where neither
 * that nor `IMAGE_REGISTRY_PULL_HOST`/`PLATFORM_BASE_URL` was supplied.
 *
 * Escape hatch: `ALLOW_INCLUSTER_PULL_HOST=true` (e.g. CodeBuild in a VPC whose
 * private DNS genuinely resolves the in-cluster name).
 */
function resolveExternalPullTarget(
  registry: { host?: string; port?: number; pullHost?: string; pullPort?: number },
): { host: string; portPart: string } {
  const host = registry.pullHost || registry.host || '';
  const port = registry.pullPort ?? registry.port;
  if (process.env.ALLOW_INCLUSTER_PULL_HOST !== 'true' && isUnreachablePullHost(host)) {
    throw new Error(
      `Registry pull host resolved to '${host}', which AWS CodeBuild cannot reach — it is the ` +
      'in-cluster/local default. The synthesized pipeline would fail at build time with ' +
      'BUILD_CONTAINER_UNABLE_TO_PULL_IMAGE. Set the platform\'s public host via ' +
      'IMAGE_REGISTRY_PULL_HOST or PLATFORM_BASE_URL before deploying — pipeline-manager bakes ' +
      'this in automatically from the platform URL it deploys against. ' +
      'Set ALLOW_INCLUSTER_PULL_HOST=true to bypass (in-VPC private DNS).',
    );
  }
  const portPart = port && port !== 80 && port !== 443 ? `:${port}` : '';
  return { host, portPart };
}

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
 *      image pointing at `<registry-host>:<port>/<ns>/<name>@<imageDigest>`
 *      where `<ns>` is `system` or `org-<orgId>`. Pinned BY DIGEST — the one
 *      the plugin service verified against its signing key before returning
 *      this record — never by the mutable `:<version>` tag, which anyone
 *      holding the org's registry push credential could re-point. A plugin
 *      that needs an image but carries no digest is refused (throws): running
 *      an unverified image is worse than a failed synth. CodeBuild authenticates by
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
      'CodeBuild will run on the default build image and won\'t have the plugin\'s baked tools.',
    );
    return undefined;
  }

  // No digest ⇒ the plugin service never signed an image for this row (or the
  // record didn't come from `/plugins/lookup`). Fail the synth rather than fall
  // back to the tag.
  if (!plugin.imageDigest || !/^sha256:[0-9a-f]{64}$/.test(plugin.imageDigest)) {
    throw new Error(
      `Plugin "${plugin.name}:${plugin.version}" has buildType=${plugin.buildType} but no signed image digest. ` +
      'Rebuild the plugin (re-upload it) so the platform can build, sign and record its image.',
    );
  }

  // The repository comes from lookup: `public/<publisher>/<name>` for a
  // listed plugin (the read-only copy every org may pull), `org-<id>/<name>`
  // for the org's own. Never derived here from the record's owner — a listing's
  // image doesn't live in its publisher's namespace.
  const repository = (plugin as Plugin & { imageRepository?: string | null }).imageRepository;
  if (!repository || !PLUGIN_IMAGE_REPOSITORY_RE.test(repository)) {
    throw new Error(
      `Plugin "${plugin.name}:${plugin.version}" has no image repository from the plugin lookup. ` +
      'Resolve plugins through the platform (`pipeline-manager pipeline synth` / the lookup custom resource).',
    );
  }

  let registry;
  try {
    registry = Config.get('registry');
  } catch {
    // Config namespace not loaded (e.g., unit tests without full config).
    log.warn(
      `Plugin "${plugin.name}:${plugin.version}" needs the registry config but it's not loaded — ` +
      'CodeBuild will fall back to the default build image. ' +
      'Set IMAGE_REGISTRY_HOST + IMAGE_REGISTRY_PORT in pipeline-manager\'s environment.',
    );
    return undefined;
  }

  if (!registry?.host) {
    log.warn(
      `Plugin "${plugin.name}:${plugin.version}" needs IMAGE_REGISTRY_HOST but it's empty — ` +
      'CodeBuild will fall back to the default build image. ' +
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

  // Compose the image URI from the lookup's repository, pinned by digest.
  // The token service grants pull on `public/*` to every authenticated
  // identity and on `org-<id>/*` to that org (and its teams).
  // Use the external pull host/port: this image URI is consumed by AWS
  // CodeBuild (out-of-cluster), which can't resolve the in-cluster
  // `registry:5000` ClusterIP. Fall back to `host`/`port` for single-host /
  // in-cluster-only deploys where no separate pull host is configured.
  const { host: pullHost, portPart } = resolveExternalPullTarget(registry);
  const imageUri = `${pullHost}${portPart}/${repository}@${plugin.imageDigest}`;

  // CodeBuild reads `pipeline-builder/<orgId>/registry-push` and sends its
  // `username`/`password` fields as HTTP Basic to the registry. The registry
  // challenges with a Bearer realm pointing at pipeline-image-registry's
  // `/token` endpoint; the Docker client forwards those creds, image-registry
  // exchanges the opaque `pb_sa_…` key for a short-lived token, and a registry
  // token scoped to the org is issued.
  //
  // This is the REGISTRY-ONLY credential, not the org's full-privilege
  // platform one: its exchanged token carries the single `registry:push` scope
  // and no API permissions at all, so a CodeBuild job that leaks it can move
  // images inside this org's namespace and nothing else. The plugin-lookup
  // Lambda keeps reading `.../platform` — it calls the ordinary API, which no
  // single scope covers.
  // Provision it with: pipeline-manager infra store-token --scope registry:push
  const stack = Stack.of(scope);
  const secretName = CoreConstants.secretPath(orgId, REGISTRY_CREDENTIAL_SECRET);
  // CDK construct IDs allow only [A-Za-z0-9_-]; sanitize the secret name.
  const secretConstructId = `RegistryCreds_${secretName.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const credentialsSecret = (stack.node.tryFindChild(secretConstructId) as Secret | undefined)
    ?? Secret.fromSecretNameV2(stack, secretConstructId, secretName);

  return LinuxBuildImage.fromDockerRegistry(imageUri, {
    secretsManagerCredentials: credentialsSecret,
  });
}

/** The managed toolchain's build-image plugin name and its (system-org) image repository. */
export const BOOTSTRAP_PLUGIN_NAME = 'pipeline-bootstrap';
export const BOOTSTRAP_IMAGE_REPOSITORY = `system/${BOOTSTRAP_PLUGIN_NAME}`;

/**
 * The default CodeBuild image — every action without a plugin-baked image (the
 * pipeline-wide `codeBuildDefaults`, a plugin-less step, asset publishing) —
 * pinned to the resolved toolchain release's `pipeline-bootstrap` image.
 *
 * Exactly the path a system plugin's image takes ({@link resolvePluginImage}):
 * `<external pull host>/system/pipeline-bootstrap@<signed digest>` with the
 * org's `registry-push` secret as the pull credential. There is no env-driven
 * image, no tag pull and no curated fallback: the bootstrap is resolved from
 * the platform (`pipeline-manager`'s `resolveBootstrapImage`, D2) and anything
 * short of a pinned, pullable image fails the synth.
 */
export function resolveDefaultBuildImage(scope: Construct, orgId: string | undefined, bootstrap: Plugin): IBuildImage {
  const fail = (why: string): never => {
    throw new Error(
      `BOOTSTRAP_IMAGE_UNRESOLVED: the default build image can't be pinned — ${why}. ` +
      'Synthesize through `pipeline-manager pipeline synth/deploy` (or pass `--toolchain-file` with `--local-spec`).',
    );
  };
  if (!bootstrap || bootstrap.name !== BOOTSTRAP_PLUGIN_NAME) {
    fail(`resolvedBootstrap is "${bootstrap?.name ?? 'missing'}", not ${BOOTSTRAP_PLUGIN_NAME}`);
  }
  const repository = (bootstrap as Plugin & { imageRepository?: string | null }).imageRepository;
  if (repository !== BOOTSTRAP_IMAGE_REPOSITORY) {
    fail(`${BOOTSTRAP_PLUGIN_NAME}:${bootstrap.version} has image repository "${repository ?? 'none'}", not ${BOOTSTRAP_IMAGE_REPOSITORY}`);
  }
  if (!orgId) fail('the pipeline has no orgId (the registry pull credential is per org)');
  // Throws on a missing/malformed digest and an unreachable pull host.
  const image = resolvePluginImage(scope, { ...bootstrap, buildType: 'prebuilt' }, orgId);
  if (!image) fail('the registry config is not loaded (IMAGE_REGISTRY_HOST / the platform URL)');
  return image as IBuildImage;
}

/**
 * The AWS curated image self-mutation runs on (D10): it only needs Node and the
 * pinned CDK CLI, and a curated image keeps a defective toolchain release
 * recoverable. Curated ⇒ `fromCodeBuildImageId` (CODEBUILD pull credentials —
 * `fromDockerRegistry` would set SERVICE_ROLE, which CFN rejects for a curated image).
 */
export const curatedSelfMutationImage = (): IBuildImage => LinuxBuildImage.fromCodeBuildImageId(CURATED_SELF_MUTATION_IMAGE);

/**
 * Create a CodeBuild step or Shell step based on plugin configuration.
 *
 * Metadata merge order (last wins):
 *   1. Plugin metadata (from plugin.metadata in database) — the plugin
 *      author's baked-in defaults
 *   2. Step-level metadata (from options.metadata) — the pipeline author's
 *      per-step overrides, which are more specific and must win
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
    id, input, metadata, network, scope,
    preInstallCommands, postInstallCommands, preCommands, postCommands,
    env: customEnv, additionalInputs, timeout, failureBehavior,
    artifactManager, stageName, stageAlias, pluginAlias, orgId, pipelineScope,
  } = options;

  // Resolve {{ ... }} templates in plugin spec fields against the pipeline scope.
  // Every call goes through the resolver — plugins without template tokens are
  // a no-op fast path inside resolvePluginTemplates().
  const plugin = resolvePluginTemplates(options.plugin, pipelineScope);

  // Per-step metadata (the pipeline author's overrides, e.g. JAVA_VERSION=25)
  // must win over the plugin's catalog `metadata` defaults, so it goes LAST.
  // Reversing these silently dropped per-step overrides for any plugin that
  // ships non-empty catalog metadata (plugins that carry defaults under `env`
  // instead — like java-corretto — were unaffected, which masked this).
  const merged = merge(plugin.metadata ?? {}, metadata ?? {});

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

  // Resolve plugin secrets as SECRETS_MANAGER env vars — only REQUIRED ones.
  // CodeBuild treats a SECRETS_MANAGER env var as MANDATORY: it fails the build
  // at DOWNLOAD_SOURCE ("ResourceNotFoundException: can't find the specified
  // secret") if the secret is absent. Auto-wiring an OPTIONAL secret
  // (`required: false`, e.g. NVD_API_KEY / SEMGREP_APP_TOKEN) the operator hasn't
  // created would therefore break every build — the exact opposite of "optional".
  // Optional secrets are left for the plugin to read only where the operator has
  // provisioned them (out-of-band env/secret), not force-injected here.
  const secretEnvVars = (requiredSecrets.length && orgId)
    ? toSecretEnvVars(requiredSecrets, orgId)
    : {};

  const env = buildEnv(plugin, merged, customEnv);

  // Security-report upload (opt-in): inject the org's reporting:ingest-scoped
  // key — never the full platform credential — as a SECRETS_MANAGER variable.
  // CDK grants the step role read on exactly that secret. See core/security-reports.ts.
  const reportUpload = env[SECURITY_REPORT_UPLOAD_ENV] === 'true';
  if (reportUpload && !orgId) {
    log.warn(`Step "${id}" sets ${SECURITY_REPORT_UPLOAD_ENV}=true but no orgId is available — the upload key cannot be injected and the upload will fail.`);
  }
  const reportKeyEnvVar: Record<string, { value: string; type: BuildEnvironmentVariableType }> = reportUpload && orgId
    ? {
      [SECURITY_REPORT_KEY_ENV]: {
        value: `${CoreConstants.secretPath(orgId, SECURITY_REPORT_SECRET_LEAF)}:password`,
        type: BuildEnvironmentVariableType.SECRETS_MANAGER,
      },
    }
    : {};

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

  // Step network: explicit step config wins, else this step's `ec2:network` metadata.
  const resolvedNetwork = network ?? networkConfigFromMetadata(merged);
  const networkProps = resolvedNetwork
    ? resolveNetwork(scope, options.uniqueId, resolvedNetwork)
    : {};

  // Metadata spread last so it can override programmatic defaults.
  // NOTE: Caching is supported via two metadata paths:
  //   1. MetadataKeys.CACHE ('aws:cdk:pipelines:codebuildstep:cache') — passed directly
  //      as the CodeBuildStep `cache` prop (expects a codebuild.Cache object).
  //   2. MetadataKeys.PARTIAL_BUILD_SPEC ('aws:cdk:pipelines:codebuildstep:partialbuildspec')
  //      — passed as `partialBuildSpec`, which can include a `cache:` section for
  //      S3 or local caching (e.g., BuildSpec.fromObject({ cache: { paths: [...] } })).
  // Per-step buildEnvironment overrides from metadata (aws:cdk:codebuild:buildenvironment:*).
  // A metadata-provided computeType is a raw passthrough, so normalize it through
  // getComputeType — otherwise a friendly value like "LARGE" reaches CodeBuild verbatim
  // and fails with "Invalid compute type provided" (it needs BUILD_GENERAL1_LARGE).
  const rawMetaBuildEnv = metadataForBuildEnvironment(merged);
  const metaBuildEnv = typeof rawMetaBuildEnv.computeType === 'string'
    ? { ...rawMetaBuildEnv, computeType: getComputeType(rawMetaBuildEnv.computeType) }
    : rawMetaBuildEnv;

  const step = new CodeBuildStep(id, {
    ...programmatic,
    ...networkProps,
    ...(additionalInputs && { additionalInputs }),
    ...(timeout && { timeout: Duration.minutes(timeout) }),
    env: actionEnv,
    primaryOutputDirectory: plugin.primaryOutputDirectory ?? undefined,
    // Pin the buildspec shell to POSIX /bin/sh so execution is identical to
    // CodeBuild's default and portable across minimal base images (no bash
    // dependency). Plugin specs are authored POSIX-clean to match — no bash-only
    // `[[ ]]`, arrays, `read -ra <<<`, or `source`/`nvm use`/`sdk use`. A
    // plugin-supplied partialBuildSpec (none today) would override this via the
    // metadata spread below and must then set `env.shell` itself.
    partialBuildSpec: BuildSpec.fromObject({ env: { shell: '/bin/sh' } }),
    buildEnvironment: {
      computeType,
      buildImage: pluginBuildImage ?? defaultBuildImageOrThrow(options),
      environmentVariables: {
        ...toCodeBuildEnvVars(env),
        ...secretEnvVars,
        ...reportKeyEnvVar,
      },
      ...metaBuildEnv,
    },
    ...metadataForCodeBuildStep(merged),
  });

  // Register with artifact manager if primaryOutputDirectory is set
  if (plugin.primaryOutputDirectory && artifactManager && stageName) {
    const artifactKey: ArtifactKey = {
      stageName,
      stageAlias: stageAlias ?? `${stageName}-alias`,
      pluginName: plugin.name,
      pluginAlias: pluginAlias ?? pluginArtifactAlias(plugin),
      outputDirectory: plugin.primaryOutputDirectory,
    };
    artifactManager.add(artifactKey, step);
  }

  return step;
}

/**
 * The default image a plugin-less CodeBuild step runs on. It is resolved once
 * per pipeline from `resolvedBootstrap` and handed down; a step without one
 * has no image to run on, so the synth stops rather than let CodeBuild pick
 * its own.
 */
function defaultBuildImageOrThrow(options: CodeBuildStepOptions): IBuildImage {
  if (options.defaultBuildImage) return options.defaultBuildImage;
  throw new Error(
    `BOOTSTRAP_IMAGE_UNRESOLVED: step "${options.id}" (plugin "${options.plugin.name}") has no plugin image and no default build image. ` +
    'Pass `defaultBuildImage` (PipelineBuilder resolves it from `resolvedBootstrap`).',
  );
}

/**
 * Convert string or ComputeType enum to CDK ComputeType
 */
export function getComputeType(input: string | CDKComputeType = 'SMALL'): CDKComputeType {
  // If already a CDK ComputeType, return as-is
  if (typeof input !== 'string') {
    return input;
  }

  // Already a native CodeBuild ComputeType (e.g. "BUILD_GENERAL1_LARGE")? Accept as-is
  // so both friendly (LARGE) and native values round-trip without falling back to SMALL.
  if ((Object.values(CDKComputeType) as string[]).includes(input)) {
    return input as CDKComputeType;
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
 * Unwrap a SecretValue | string into a plain string.
 * When a SecretValue is provided (e.g. from Secrets Manager), calls unsafeUnwrap()
 * to extract the underlying value.
 */
export function unwrapSecret(value: SecretValue | string): string {
  return typeof value === 'string' ? value : value.unsafeUnwrap();
}
