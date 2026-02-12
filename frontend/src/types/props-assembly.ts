/**
 * @module props-assembly
 * @description Converts FormBuilderState (UI) into BuilderProps (API) for create/update.
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

type AnyRecord = Record<string, unknown>;

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

function assemblePluginFilter(filter: FormPluginOptions['filter']): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  if (filter.id) result.id = filter.id;
  if (filter.orgId) result.orgId = filter.orgId;
  if (filter.accessModifier) result.accessModifier = filter.accessModifier;
  if (filter.isDefault) result.isDefault = filter.isDefault === 'true';
  if (filter.isActive) result.isActive = filter.isActive === 'true';
  if (filter.name) result.name = filter.name;
  if (filter.namePattern) result.namePattern = filter.namePattern;
  if (filter.version) result.version = filter.version;
  if (filter.versionMin || filter.versionMax) {
    result.versionRange = {
      ...(filter.versionMin && { min: filter.versionMin }),
      ...(filter.versionMax && { max: filter.versionMax }),
    };
  }
  if (filter.imageTag) result.imageTag = filter.imageTag;
  return Object.keys(result).length > 0 ? result : undefined;
}

function assemblePluginOptions(plugin: FormPluginOptions): Record<string, unknown> {
  const result: Record<string, unknown> = { name: plugin.name };
  if (plugin.alias) result.alias = plugin.alias;
  const filter = assemblePluginFilter(plugin.filter);
  if (filter) result.filter = filter;
  const meta = assembleMetadata(plugin.metadata);
  if (meta) result.metadata = meta;
  return result;
}

function assembleEnv(entries: EnvEntry[]): Record<string, string> | undefined {
  const filtered = entries.filter((e) => e.key.trim());
  if (filtered.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const entry of filtered) result[entry.key] = entry.value;
  return result;
}

/**
 * Assemble a FormBuilderState into BuilderProps.
 * Returns null if validation fails.
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
          ...(state.synth.codestar.codeBuildCloneOutput && { codeBuildCloneOutput: true }),
        },
      };
      break;
  }

  // Synth
  const synthNetwork = assembleNetworkConfig(state.synth.networkType, state.synth.network);
  const synthMeta = assembleMetadata(state.synth.metadata);
  const synth: Record<string, unknown> = {
    source,
    plugin: assemblePluginOptions(state.synth.plugin),
    ...(synthMeta && { metadata: synthMeta }),
    ...(synthNetwork && { network: synthNetwork }),
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
            additionalInputArtifacts: Object.fromEntries(
              additionalInputs.map((a) => [a.path, parseArtifactKeyString(a.key)])
            ),
          }),
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
