import { useReducer, useCallback, useState } from 'react';
import {
  FormBuilderState,
  FormNetworkConfig,
  FormSecurityGroupConfig,
  FormPluginOptions,
  FormStage,
  FormStep,
  MetadataEntry,
  EnvEntry,
  TagEntry,
  createInitialFormState,
  createEmptyNetworkConfig,
  createEmptyStep,
  createEmptyStage,
  createEmptyPlugin,
} from '@/types/form-types';
import { BuilderProps } from '@/types';

// ─── Action Types ──────────────────────────────────────────────

type Action =
  | { type: 'SET_CORE'; field: 'project' | 'organization' | 'pipelineName'; value: string }
  | { type: 'SET_GLOBAL_METADATA'; value: MetadataEntry[] }
  // Defaults
  | { type: 'SET_DEFAULTS_ENABLED'; value: boolean }
  | { type: 'SET_DEFAULTS_NETWORK_TYPE'; value: FormBuilderState['defaults']['networkType'] }
  | { type: 'SET_DEFAULTS_NETWORK'; value: FormNetworkConfig }
  | { type: 'SET_DEFAULTS_SG_TYPE'; value: FormBuilderState['defaults']['securityGroupType'] }
  | { type: 'SET_DEFAULTS_SG'; value: FormSecurityGroupConfig }
  | { type: 'SET_DEFAULTS_METADATA'; value: MetadataEntry[] }
  // Role
  | { type: 'SET_ROLE_TYPE'; value: FormBuilderState['role']['type'] }
  | { type: 'SET_ROLE_FIELD'; field: 'roleArn' | 'roleName'; value: string }
  | { type: 'SET_ROLE_MUTABLE'; value: boolean }
  // Synth source
  | { type: 'SET_SYNTH_SOURCE_TYPE'; value: FormBuilderState['synth']['sourceType'] }
  | { type: 'SET_SYNTH_S3'; field: string; value: string }
  | { type: 'SET_SYNTH_GITHUB'; field: string; value: string }
  | { type: 'SET_SYNTH_CODESTAR'; field: string; value: string | boolean }
  // Synth plugin, metadata, network
  | { type: 'SET_SYNTH_PLUGIN'; value: FormPluginOptions }
  | { type: 'SET_SYNTH_METADATA'; value: MetadataEntry[] }
  | { type: 'SET_SYNTH_NETWORK_TYPE'; value: FormBuilderState['synth']['networkType'] }
  | { type: 'SET_SYNTH_NETWORK'; value: FormNetworkConfig }
  // Stages
  | { type: 'ADD_STAGE' }
  | { type: 'REMOVE_STAGE'; index: number }
  | { type: 'SET_STAGE_FIELD'; index: number; field: 'stageName' | 'alias'; value: string }
  | { type: 'ADD_STEP'; stageIndex: number }
  | { type: 'REMOVE_STEP'; stageIndex: number; stepIndex: number }
  | { type: 'SET_STEP'; stageIndex: number; stepIndex: number; step: FormStep }
  // Reset
  | { type: 'RESET' };

// ─── Reducer ───────────────────────────────────────────────────

function formReducer(state: FormBuilderState, action: Action): FormBuilderState {
  switch (action.type) {
    case 'SET_CORE':
      return { ...state, [action.field]: action.value };

    case 'SET_GLOBAL_METADATA':
      return { ...state, global: action.value };

    // Defaults
    case 'SET_DEFAULTS_ENABLED':
      return { ...state, defaults: { ...state.defaults, enabled: action.value } };
    case 'SET_DEFAULTS_NETWORK_TYPE':
      return { ...state, defaults: { ...state.defaults, networkType: action.value } };
    case 'SET_DEFAULTS_NETWORK':
      return { ...state, defaults: { ...state.defaults, network: action.value } };
    case 'SET_DEFAULTS_SG_TYPE':
      return { ...state, defaults: { ...state.defaults, securityGroupType: action.value } };
    case 'SET_DEFAULTS_SG':
      return { ...state, defaults: { ...state.defaults, securityGroup: action.value } };
    case 'SET_DEFAULTS_METADATA':
      return { ...state, defaults: { ...state.defaults, metadata: action.value } };

    // Role
    case 'SET_ROLE_TYPE':
      return { ...state, role: { ...state.role, type: action.value } };
    case 'SET_ROLE_FIELD':
      return { ...state, role: { ...state.role, [action.field]: action.value } };
    case 'SET_ROLE_MUTABLE':
      return { ...state, role: { ...state.role, mutable: action.value } };

    // Synth source
    case 'SET_SYNTH_SOURCE_TYPE':
      return { ...state, synth: { ...state.synth, sourceType: action.value } };
    case 'SET_SYNTH_S3':
      return { ...state, synth: { ...state.synth, s3: { ...state.synth.s3, [action.field]: action.value } } };
    case 'SET_SYNTH_GITHUB':
      return { ...state, synth: { ...state.synth, github: { ...state.synth.github, [action.field]: action.value } } };
    case 'SET_SYNTH_CODESTAR':
      return { ...state, synth: { ...state.synth, codestar: { ...state.synth.codestar, [action.field]: action.value } } };

    // Synth plugin, metadata, network
    case 'SET_SYNTH_PLUGIN':
      return { ...state, synth: { ...state.synth, plugin: action.value } };
    case 'SET_SYNTH_METADATA':
      return { ...state, synth: { ...state.synth, metadata: action.value } };
    case 'SET_SYNTH_NETWORK_TYPE':
      return { ...state, synth: { ...state.synth, networkType: action.value } };
    case 'SET_SYNTH_NETWORK':
      return { ...state, synth: { ...state.synth, network: action.value } };

    // Stages
    case 'ADD_STAGE':
      return { ...state, stages: [...state.stages, createEmptyStage()] };
    case 'REMOVE_STAGE':
      return { ...state, stages: state.stages.filter((_, i) => i !== action.index) };
    case 'SET_STAGE_FIELD': {
      const stages = [...state.stages];
      stages[action.index] = { ...stages[action.index], [action.field]: action.value };
      return { ...state, stages };
    }
    case 'ADD_STEP': {
      const stages = [...state.stages];
      stages[action.stageIndex] = {
        ...stages[action.stageIndex],
        steps: [...stages[action.stageIndex].steps, createEmptyStep()],
      };
      return { ...state, stages };
    }
    case 'REMOVE_STEP': {
      const stages = [...state.stages];
      stages[action.stageIndex] = {
        ...stages[action.stageIndex],
        steps: stages[action.stageIndex].steps.filter((_, i) => i !== action.stepIndex),
      };
      return { ...state, stages };
    }
    case 'SET_STEP': {
      const stages = [...state.stages];
      const steps = [...stages[action.stageIndex].steps];
      steps[action.stepIndex] = action.step;
      stages[action.stageIndex] = { ...stages[action.stageIndex], steps };
      return { ...state, stages };
    }

    case 'RESET':
      return createInitialFormState();

    default:
      return state;
  }
}

// ─── Assembly Helpers ──────────────────────────────────────────

function assembleMetadata(entries: MetadataEntry[]): Record<string, string | boolean | number> | undefined {
  const filtered = entries.filter((e) => e.key.trim());
  if (filtered.length === 0) return undefined;
  const result: Record<string, string | boolean | number> = {};
  for (const entry of filtered) {
    switch (entry.type) {
      case 'number':
        result[entry.key] = Number(entry.value) || 0;
        break;
      case 'boolean':
        result[entry.key] = entry.value === 'true';
        break;
      default:
        result[entry.key] = entry.value;
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
      return {
        type: 'securityGroupIds',
        options: {
          securityGroupIds: sg.securityGroupIds.filter(Boolean),
          mutable: sg.mutable,
        },
      };
    case 'securityGroupLookup':
      return {
        type: 'securityGroupLookup',
        options: {
          securityGroupName: sg.securityGroupName,
          vpcId: sg.vpcId,
        },
      };
    default:
      return undefined;
  }
}

function assemblePluginFilter(filter: FormPluginOptions['filter']): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  // Common filter properties
  if (filter.id) result.id = filter.id;
  if (filter.orgId) result.orgId = filter.orgId;
  if (filter.accessModifier) result.accessModifier = filter.accessModifier;
  if (filter.isDefault) result.isDefault = filter.isDefault === 'true';
  if (filter.isActive) result.isActive = filter.isActive === 'true';
  // Plugin-specific filter properties
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
  for (const entry of filtered) {
    result[entry.key] = entry.value;
  }
  return result;
}

// ─── Main Assembly Function ────────────────────────────────────

function assembleBuilderPropsFromState(
  state: FormBuilderState,
): { props: BuilderProps | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  // Validate required core fields
  if (!state.project.trim()) errors['project'] = 'Project is required';
  if (!state.organization.trim()) errors['organization'] = 'Organization is required';

  // Build source config
  let source: Record<string, unknown> | undefined;
  switch (state.synth.sourceType) {
    case 's3':
      if (!state.synth.s3.bucketName.trim()) errors['synth.s3.bucketName'] = 'Bucket name is required';
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
      if (!state.synth.github.repo.trim()) errors['synth.github.repo'] = 'Repository is required';
      if (state.synth.github.repo && !state.synth.github.repo.includes('/')) {
        errors['synth.github.repo'] = 'Format: owner/repo';
      }
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
      if (!state.synth.codestar.repo.trim()) errors['synth.codestar.repo'] = 'Repository is required';
      if (!state.synth.codestar.connectionArn.trim()) errors['synth.codestar.connectionArn'] = 'Connection ARN is required';
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

  // Validate synth plugin
  if (!state.synth.plugin.name.trim()) errors['synth.plugin.name'] = 'Plugin name is required';

  // Build synth
  const synthNetwork = assembleNetworkConfig(state.synth.networkType, state.synth.network);
  const synthMeta = assembleMetadata(state.synth.metadata);
  const synth: Record<string, unknown> = {
    source,
    plugin: assemblePluginOptions(state.synth.plugin),
    ...(synthMeta && { metadata: synthMeta }),
    ...(synthNetwork && { network: synthNetwork }),
  };

  // Build defaults
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

  // Build role
  let role: Record<string, unknown> | undefined;
  if (state.role.type !== 'none') {
    switch (state.role.type) {
      case 'roleArn':
        if (!state.role.roleArn.trim()) errors['role.roleArn'] = 'Role ARN is required';
        role = { type: 'roleArn', options: { roleArn: state.role.roleArn, mutable: state.role.mutable } };
        break;
      case 'roleName':
        if (!state.role.roleName.trim()) errors['role.roleName'] = 'Role name is required';
        role = { type: 'roleName', options: { roleName: state.role.roleName, mutable: state.role.mutable } };
        break;
      case 'codeBuildDefault':
        role = { type: 'codeBuildDefault', options: { ...(state.role.roleName && { roleName: state.role.roleName }) } };
        break;
    }
  }

  // Build global metadata
  const globalMeta = assembleMetadata(state.global);

  // Build stages
  let stages: Record<string, unknown>[] | undefined;
  if (state.stages.length > 0) {
    stages = state.stages.map((stage, stageIdx) => {
      if (!stage.stageName.trim()) errors[`stages.${stageIdx}.stageName`] = 'Stage name is required';
      if (stage.steps.length === 0) errors[`stages.${stageIdx}.steps`] = 'Stage must have at least one step';

      return {
        stageName: stage.stageName,
        ...(stage.alias && { alias: stage.alias }),
        steps: stage.steps.map((step, stepIdx) => {
          if (!step.plugin.name.trim()) {
            errors[`stages.${stageIdx}.steps.${stepIdx}.plugin.name`] = 'Plugin name is required';
          }
          const stepNetwork = assembleNetworkConfig(step.networkType, step.network);
          const stepMeta = assembleMetadata(step.metadata);
          const stepEnv = assembleEnv(step.env);
          return {
            plugin: assemblePluginOptions(step.plugin),
            ...(stepMeta && { metadata: stepMeta }),
            ...(stepNetwork && { network: stepNetwork }),
            ...(step.preInstallCommands.filter(Boolean).length > 0 && { preInstallCommands: step.preInstallCommands.filter(Boolean) }),
            ...(step.postInstallCommands.filter(Boolean).length > 0 && { postInstallCommands: step.postInstallCommands.filter(Boolean) }),
            ...(step.preCommands.filter(Boolean).length > 0 && { preCommands: step.preCommands.filter(Boolean) }),
            ...(step.postCommands.filter(Boolean).length > 0 && { postCommands: step.postCommands.filter(Boolean) }),
            ...(stepEnv && { env: stepEnv }),
          };
        }),
      };
    });
  }

  // Check for errors
  if (Object.keys(errors).length > 0) {
    return { props: null, errors };
  }

  // Assemble final BuilderProps
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

// ─── Hook ──────────────────────────────────────────────────────

export function useFormBuilderState() {
  const [state, dispatch] = useReducer(formReducer, undefined, createInitialFormState);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  const assembleBuilderProps = useCallback((): BuilderProps | null => {
    const { props, errors } = assembleBuilderPropsFromState(state);
    setValidationErrors(errors);
    return props;
  }, [state]);

  const reset = useCallback(() => {
    dispatch({ type: 'RESET' });
    setValidationErrors({});
  }, []);

  return {
    state,
    dispatch,
    validationErrors,
    assembleBuilderProps,
    reset,
  };
}
