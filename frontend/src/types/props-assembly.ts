/**
 * Assembles mutable FormBuilderState (UI) into readonly BuilderProps (API)
 * for pipeline create/update requests. Each helper converts one section of
 * the form state, filtering out empty/default values so the API payload
 * contains only explicitly configured fields.
 */

import type { BuilderProps } from '@/types';
import {
  FormBuilderState,
  FormNetworkConfig,
  FormSecurityGroupConfig,
  FormPluginOptions,
  MetadataEntry,
  EnvEntry,
  TagEntry,
} from './form-types';
import { validateFormState } from './props-validation';
import { parseArtifactKeyString } from './props-parsing';

/**
 * Converts MetadataEntry[] into a typed record, coercing values based on each entry's type.
 * Entries with blank keys are filtered out. Returns undefined if no entries remain.
 */
function assembleMetadata(entries: MetadataEntry[]): Record<string, string | boolean | number> | undefined {
  const filtered = entries.filter((e) => e.key.trim());
  if (filtered.length === 0) return undefined;
  const result: Record<string, string | boolean | number> = {};
  for (const entry of filtered) {
    switch (entry.type) {
      case 'number': result[entry.key] = Number(entry.value) || 0; break;
      case 'boolean': result[entry.key] = entry.value === 'true'; break;
      default: result[entry.key] = entry.value;
    }
  }
  return result;
}

/**
 * Converts the form's network fields into the API's typed network config object.
 * Only includes fields relevant to the selected networkType variant.
 * @param networkType - The selected variant: 'none', 'subnetIds', 'vpcId', or 'vpcLookup'.
 * @param network - The superset form network config.
 * @returns The assembled network config, or undefined if networkType is 'none'.
 */
function assembleNetworkConfig(
  networkType: string,
  network: FormNetworkConfig,
): Record<string, unknown> | undefined {
  if (networkType === 'none') return undefined;

  switch (networkType) {
    case 'subnetIds':
      return {
        type: 'subnetIds',
        options: {
          vpcId: network.vpcId,
          subnetIds: network.subnetIds.filter(Boolean),
          ...(network.securityGroupIds.filter(Boolean).length > 0 && {
            securityGroupIds: network.securityGroupIds.filter(Boolean),
          }),
        },
      };
    case 'vpcId':
      return {
        type: 'vpcId',
        options: {
          vpcId: network.vpcId,
          ...(network.subnetType && { subnetType: network.subnetType }),
          ...(network.availabilityZones.filter(Boolean).length > 0 && {
            availabilityZones: network.availabilityZones.filter(Boolean),
          }),
          ...(network.subnetGroupName && { subnetGroupName: network.subnetGroupName }),
          ...(network.securityGroupIds.filter(Boolean).length > 0 && {
            securityGroupIds: network.securityGroupIds.filter(Boolean),
          }),
        },
      };
    case 'vpcLookup': {
      const tags: Record<string, string> = {};
      for (const t of network.tags.filter((t: TagEntry) => t.key.trim())) {
        tags[t.key] = t.value;
      }
      return {
        type: 'vpcLookup',
        options: {
          tags,
          ...(network.vpcName && { vpcName: network.vpcName }),
          ...(network.region && { region: network.region }),
          ...(network.subnetType && { subnetType: network.subnetType }),
          ...(network.availabilityZones.filter(Boolean).length > 0 && {
            availabilityZones: network.availabilityZones.filter(Boolean),
          }),
          ...(network.subnetGroupName && { subnetGroupName: network.subnetGroupName }),
          ...(network.securityGroupIds.filter(Boolean).length > 0 && {
            securityGroupIds: network.securityGroupIds.filter(Boolean),
          }),
        },
      };
    }
    default:
      return undefined;
  }
}

/**
 * Converts the form's security group fields into the API's typed security group config.
 * @param sgType - The selected variant: 'none', 'securityGroupIds', or 'securityGroupLookup'.
 * @param sg - The superset form security group config.
 * @returns The assembled security group config, or undefined if sgType is 'none'.
 */
function assembleSecurityGroupConfig(
  sgType: string,
  sg: FormSecurityGroupConfig,
): Record<string, unknown> | undefined {
  if (sgType === 'none') return undefined;
  switch (sgType) {
    case 'securityGroupIds':
      return { type: 'securityGroupIds', options: { securityGroupIds: sg.securityGroupIds.filter(Boolean), mutable: sg.mutable } };
    case 'securityGroupLookup':
      return { type: 'securityGroupLookup', options: { securityGroupName: sg.securityGroupName, vpcId: sg.vpcId } };
    default:
      return undefined;
  }
}

/**
 * Converts a FormPluginFilter into an API filter object, coercing boolean string fields.
 * Returns undefined if all filter fields are empty.
 */
function assemblePluginFilter(filter: FormPluginOptions['filter']): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  if (filter.id) result.id = filter.id;
  if (filter.orgId) result.orgId = filter.orgId;
  if (filter.accessModifier) result.accessModifier = filter.accessModifier;
  if (filter.isDefault) result.isDefault = filter.isDefault === 'true';
  if (filter.isActive) result.isActive = filter.isActive === 'true';
  if (filter.name) result.name = filter.name;
  if (filter.version) result.version = filter.version;
  if (filter.imageTag) result.imageTag = filter.imageTag;
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Assembles a FormPluginOptions into the API plugin object, including filter and metadata
 * only when they contain non-empty values.
 */
function assemblePluginOptions(plugin: FormPluginOptions): Record<string, unknown> {
  const result: Record<string, unknown> = { name: plugin.name };
  if (plugin.alias) result.alias = plugin.alias;
  const filter = assemblePluginFilter(plugin.filter);
  if (filter) result.filter = filter;
  const meta = assembleMetadata(plugin.metadata);
  if (meta) result.metadata = meta;
  return result;
}

/**
 * Converts EnvEntry[] into a string-to-string record for a step's environment variables.
 * Entries with blank keys are filtered out. Returns undefined if no entries remain.
 */
function assembleEnv(entries: EnvEntry[]): Record<string, string> | undefined {
  const filtered = entries.filter((e) => e.key.trim());
  if (filtered.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const entry of filtered) result[entry.key] = entry.value;
  return result;
}

/**
 * Assembles a complete FormBuilderState into a BuilderProps payload for the API.
 * Validates the form state first (unless skipped) and returns field-level errors
 * if validation fails.
 *
 * @param state - The current form builder state to assemble.
 * @param options.skipValidation - When true, bypass validation (useful for draft saves).
 * @returns `props` containing the assembled BuilderProps (or null on validation failure)
 *          and `errors` mapping field paths to error messages.
 */
export function assembleBuilderProps(
  state: FormBuilderState,
  { skipValidation = false }: { skipValidation?: boolean } = {},
): { props: BuilderProps | null; errors: Record<string, string> } {
  if (!skipValidation) {
    const errors = validateFormState(state);
    if (Object.keys(errors).length > 0) return { props: null, errors };
  }

  // Build source
  let source: Record<string, unknown> | undefined;
  switch (state.synth.sourceType) {
    case 's3':
      source = {
        type: 's3',
        options: {
          bucketName: state.synth.s3.bucketName,
          ...(state.synth.s3.objectKey && { objectKey: state.synth.s3.objectKey }),
          ...(state.synth.s3.trigger !== 'NONE' && { trigger: state.synth.s3.trigger }),
          ...(state.synth.s3.trigger === 'SCHEDULE' && state.synth.s3.schedule && { schedule: state.synth.s3.schedule }),
        },
      };
      break;
    case 'github':
      source = {
        type: 'github',
        options: {
          repo: state.synth.github.repo,
          ...(state.synth.github.branch && { branch: state.synth.github.branch }),
          ...(state.synth.github.token && { token: state.synth.github.token }),
          ...(state.synth.github.trigger !== 'NONE' && { trigger: state.synth.github.trigger }),
          ...(state.synth.github.trigger === 'SCHEDULE' && state.synth.github.schedule && { schedule: state.synth.github.schedule }),
        },
      };
      break;
    case 'codestar':
      source = {
        type: 'codestar',
        options: {
          repo: state.synth.codestar.repo,
          connectionArn: state.synth.codestar.connectionArn,
          ...(state.synth.codestar.branch && { branch: state.synth.codestar.branch }),
          ...(state.synth.codestar.trigger !== 'NONE' && { trigger: state.synth.codestar.trigger }),
          ...(state.synth.codestar.trigger === 'SCHEDULE' && state.synth.codestar.schedule && { schedule: state.synth.codestar.schedule }),
          ...(state.synth.codestar.codeBuildCloneOutput && { codeBuildCloneOutput: true }),
        },
      };
      break;
    case 'codecommit':
      source = {
        type: 'codecommit',
        options: {
          repositoryName: state.synth.codecommit.repositoryName,
          ...(state.synth.codecommit.branch && { branch: state.synth.codecommit.branch }),
          ...(state.synth.codecommit.trigger !== 'NONE' && { trigger: state.synth.codecommit.trigger }),
          ...(state.synth.codecommit.trigger === 'SCHEDULE' && state.synth.codecommit.schedule && { schedule: state.synth.codecommit.schedule }),
        },
      };
      break;
  }

  // Synth
  const synthNetwork = assembleNetworkConfig(state.synth.networkType, state.synth.network);
  const synthMeta = assembleMetadata(state.synth.metadata);
  const synthEnv = assembleEnv(state.synth.env);
  const synth: Record<string, unknown> = {
    source,
    plugin: assemblePluginOptions(state.synth.plugin),
    ...(synthMeta && { metadata: synthMeta }),
    ...(synthNetwork && { network: synthNetwork }),
    ...(state.synth.installCommands.commands.filter(Boolean).length > 0 && {
      [state.synth.installCommands.position === 'pre' ? 'preInstallCommands' : 'postInstallCommands']: state.synth.installCommands.commands.filter(Boolean),
    }),
    ...(state.synth.buildCommands.commands.filter(Boolean).length > 0 && {
      [state.synth.buildCommands.position === 'pre' ? 'preCommands' : 'postCommands']: state.synth.buildCommands.commands.filter(Boolean),
    }),
    ...(synthEnv && { env: synthEnv }),
  };

  // Defaults
  let defaults: Record<string, unknown> | undefined;
  if (state.defaults.enabled) {
    const defaultsNetwork = assembleNetworkConfig(state.defaults.networkType, state.defaults.network);
    const defaultsSG = assembleSecurityGroupConfig(state.defaults.securityGroupType, state.defaults.securityGroup);
    const defaultsMeta = assembleMetadata(state.defaults.metadata);
    if (defaultsNetwork || defaultsSG || defaultsMeta) {
      defaults = {
        ...(defaultsNetwork && { network: defaultsNetwork }),
        ...(defaultsSG && { securityGroups: defaultsSG }),
        ...(defaultsMeta && { metadata: defaultsMeta }),
      };
    }
  }

  // Role
  let role: Record<string, unknown> | undefined;
  if (state.role.type !== 'none') {
    switch (state.role.type) {
      case 'roleArn':
        role = { type: 'roleArn', options: { roleArn: state.role.roleArn, mutable: state.role.mutable } };
        break;
      case 'roleName':
        role = { type: 'roleName', options: { roleName: state.role.roleName, mutable: state.role.mutable } };
        break;
      case 'codeBuildDefault':
        role = { type: 'codeBuildDefault', options: { ...(state.role.roleName && { roleName: state.role.roleName }) } };
        break;
      case 'oidc': {
        const oidcOptions: Record<string, unknown> = {};
        if (state.role.oidcProviderArn) {
          oidcOptions.providerArn = state.role.oidcProviderArn;
        } else if (state.role.oidcIssuer) {
          oidcOptions.issuer = state.role.oidcIssuer;
          if (state.role.oidcClientIds) {
            oidcOptions.clientIds = state.role.oidcClientIds.split(',').map(s => s.trim()).filter(Boolean);
          }
        }
        if (state.role.oidcConditions) {
          const conditions: Record<string, string> = {};
          state.role.oidcConditions.split('\n').forEach(line => {
            const [key, ...rest] = line.split('=');
            if (key?.trim() && rest.length) conditions[key.trim()] = rest.join('=').trim();
          });
          if (Object.keys(conditions).length) oidcOptions.conditions = conditions;
        }
        if (state.role.roleName) oidcOptions.roleName = state.role.roleName;
        if (state.role.oidcDescription) oidcOptions.description = state.role.oidcDescription;
        role = { type: 'oidc', options: oidcOptions };
        break;
      }
    }
  }

  // Global metadata
  const globalMeta = assembleMetadata(state.global);

  // Stages
  let stages: Record<string, unknown>[] | undefined;
  if (state.stages.length > 0) {
    stages = state.stages.map((stage) => ({
      stageName: stage.stageName,
      ...(stage.alias && { alias: stage.alias }),
      steps: stage.steps.map((step) => {
        const stepNetwork = assembleNetworkConfig(step.networkType, step.network);
        const stepMeta = assembleMetadata(step.metadata);
        const stepEnv = assembleEnv(step.env);
        const additionalInputs = step.additionalInputArtifacts.filter((a) => a.key.trim());
        return {
          plugin: assemblePluginOptions(step.plugin),
          ...(stepMeta && { metadata: stepMeta }),
          ...(stepNetwork && { network: stepNetwork }),
          ...(step.installCommands.commands.filter(Boolean).length > 0 && {
            [step.installCommands.position === 'pre' ? 'preInstallCommands' : 'postInstallCommands']: step.installCommands.commands.filter(Boolean),
          }),
          ...(step.buildCommands.commands.filter(Boolean).length > 0 && {
            [step.buildCommands.position === 'pre' ? 'preCommands' : 'postCommands']: step.buildCommands.commands.filter(Boolean),
          }),
          ...(stepEnv && { env: stepEnv }),
          ...(step.position === 'post' && { position: 'post' }),
          ...(step.inputArtifact && { inputArtifact: parseArtifactKeyString(step.inputArtifact) }),
          ...(additionalInputs.length > 0 && {
            additionalInputArtifacts: additionalInputs.map((a) => ({
              artifact: parseArtifactKeyString(a.key),
              ...(a.path.trim() && { directory: a.path.trim() }),
            })),
          }),
          ...(step.timeout.trim() && { timeout: parseInt(step.timeout, 10) }),
          ...(step.failureBehavior !== 'fail' && { failureBehavior: step.failureBehavior }),
        };
      }),
    }));
  }

  const props: BuilderProps = {
    project: state.project.trim(),
    organization: state.organization.trim(),
    ...(state.pipelineName && { pipelineName: state.pipelineName }),
    ...(globalMeta && { global: globalMeta }),
    ...(defaults && { defaults }),
    ...(role && { role }),
    synth,
    ...(stages && stages.length > 0 && { stages }),
  };

  return { props, errors: {} };
}
