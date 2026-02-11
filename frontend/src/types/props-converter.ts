/**
 * @module props-converter
 * @description Bidirectional conversion between BuilderProps (API) and FormBuilderState (UI).
 *
 * - propsToFormState:  BuilderProps → FormBuilderState  (for edit mode)
 * - assembleBuilderProps: FormBuilderState → BuilderProps (for create/update)
 * - validateFormState: FormBuilderState → validation errors
 */

import type { BuilderProps } from '@/types';
import {
  FormBuilderState,
  FormNetworkConfig,
  FormSecurityGroupConfig,
  FormPluginOptions,
  FormStep,
  MetadataEntry,
  EnvEntry,
  TagEntry,
  createInitialFormState,
  createEmptyNetworkConfig,
  createEmptyPlugin,
  createEmptyStep,
} from './form-types';

// ─── Shared Alias ──────────────────────────────────────────────

type AnyRecord = Record<string, unknown>;

// ═══════════════════════════════════════════════════════════════
//  PARSING (BuilderProps → FormBuilderState)
// ═══════════════════════════════════════════════════════════════

function parseMetadataEntries(obj: unknown): MetadataEntry[] {
  if (!obj || typeof obj !== 'object') return [];
  const entries: MetadataEntry[] = [];
  for (const [key, value] of Object.entries(obj as AnyRecord)) {
    const type = typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'string';
    entries.push({ key, value: String(value), type });
  }
  return entries;
}

function parseEnvEntries(obj: unknown): EnvEntry[] {
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj as AnyRecord).map(([key, value]) => ({ key, value: String(value) }));
}

function parsePluginOptions(obj: unknown): FormPluginOptions {
  if (!obj || typeof obj !== 'object') return createEmptyPlugin();
  const p = obj as AnyRecord;
  const filter = (p.filter as AnyRecord) || {};
  const versionRange = (filter.versionRange as AnyRecord) || {};
  return {
    name: String(p.name || ''),
    alias: String(p.alias || ''),
    filter: {
      id: String(filter.id || ''),
      orgId: String(filter.orgId || ''),
      accessModifier: String(filter.accessModifier || ''),
      isDefault: filter.isDefault !== undefined ? String(filter.isDefault) : '',
      isActive: filter.isActive !== undefined ? String(filter.isActive) : '',
      name: String(filter.name || ''),
      namePattern: String(filter.namePattern || ''),
      version: String(filter.version || ''),
      versionMin: String(versionRange.min || ''),
      versionMax: String(versionRange.max || ''),
      imageTag: String(filter.imageTag || ''),
    },
    metadata: parseMetadataEntries(p.metadata),
  };
}

function parseNetworkConfig(obj: unknown): { networkType: FormBuilderState['synth']['networkType']; network: FormNetworkConfig } {
  if (!obj || typeof obj !== 'object') return { networkType: 'none', network: createEmptyNetworkConfig() };
  const n = obj as AnyRecord;
  const networkType = String(n.type || 'none') as FormBuilderState['synth']['networkType'];
  const opts = (n.options as AnyRecord) || {};
  const tags = opts.tags as AnyRecord | undefined;
  return {
    networkType,
    network: {
      vpcId: String(opts.vpcId || ''),
      subnetIds: Array.isArray(opts.subnetIds) ? opts.subnetIds.map(String) : [],
      securityGroupIds: Array.isArray(opts.securityGroupIds) ? opts.securityGroupIds.map(String) : [],
      subnetType: String(opts.subnetType || 'PRIVATE_WITH_EGRESS'),
      availabilityZones: Array.isArray(opts.availabilityZones) ? opts.availabilityZones.map(String) : [],
      subnetGroupName: String(opts.subnetGroupName || ''),
      tags: tags ? Object.entries(tags).map(([key, value]) => ({ key, value: String(value) })) : [],
      vpcName: String(opts.vpcName || ''),
      region: String(opts.region || ''),
    },
  };
}

function parseSecurityGroupConfig(obj: unknown): { sgType: FormBuilderState['defaults']['securityGroupType']; sg: FormSecurityGroupConfig } {
  if (!obj || typeof obj !== 'object') return { sgType: 'none', sg: { securityGroupIds: [], mutable: true, securityGroupName: '', vpcId: '' } };
  const s = obj as AnyRecord;
  const sgType = String(s.type || 'none') as FormBuilderState['defaults']['securityGroupType'];
  const opts = (s.options as AnyRecord) || {};
  return {
    sgType,
    sg: {
      securityGroupIds: Array.isArray(opts.securityGroupIds) ? opts.securityGroupIds.map(String) : [],
      mutable: opts.mutable !== false,
      securityGroupName: String(opts.securityGroupName || ''),
      vpcId: String(opts.vpcId || ''),
    },
  };
}

function parseSteps(steps: unknown[]): FormStep[] {
  return steps.map((s) => {
    const step = s as AnyRecord;
    const { networkType, network } = parseNetworkConfig(step.network);
    return {
      plugin: parsePluginOptions(step.plugin),
      metadata: parseMetadataEntries(step.metadata),
      networkType,
      network,
      preInstallCommands: Array.isArray(step.preInstallCommands) ? step.preInstallCommands.map(String) : [],
      postInstallCommands: Array.isArray(step.postInstallCommands) ? step.postInstallCommands.map(String) : [],
      preCommands: Array.isArray(step.preCommands) ? step.preCommands.map(String) : [],
      postCommands: Array.isArray(step.postCommands) ? step.postCommands.map(String) : [],
      env: parseEnvEntries(step.env),
      position: step.position === 'post' ? 'post' : 'pre',
    };
  });
}

/**
 * Convert BuilderProps (from API) back into FormBuilderState (for edit mode).
 */
export function propsToFormState(rawProps: AnyRecord): FormBuilderState {
  const base = createInitialFormState();

  // Core
  base.project = String(rawProps.project || '');
  base.organization = String(rawProps.organization || '');
  base.pipelineName = String(rawProps.pipelineName || '');

  // Global metadata
  if (rawProps.global) {
    base.global = parseMetadataEntries(rawProps.global);
  }

  // Defaults
  if (rawProps.defaults) {
    const d = rawProps.defaults as AnyRecord;
    base.defaults.enabled = true;
    if (d.network) {
      const { networkType, network } = parseNetworkConfig(d.network);
      base.defaults.networkType = networkType;
      base.defaults.network = network;
    }
    if (d.securityGroups) {
      const { sgType, sg } = parseSecurityGroupConfig(d.securityGroups);
      base.defaults.securityGroupType = sgType;
      base.defaults.securityGroup = sg;
    }
    if (d.metadata) {
      base.defaults.metadata = parseMetadataEntries(d.metadata);
    }
  }

  // Role
  if (rawProps.role) {
    const r = rawProps.role as AnyRecord;
    const roleType = String(r.type || 'none') as FormBuilderState['role']['type'];
    const opts = (r.options as AnyRecord) || {};
    base.role = {
      type: roleType,
      roleArn: String(opts.roleArn || ''),
      roleName: String(opts.roleName || ''),
      mutable: opts.mutable !== false,
    };
  }

  // Synth
  if (rawProps.synth) {
    const synth = rawProps.synth as AnyRecord;

    if (synth.source) {
      const src = synth.source as AnyRecord;
      const srcType = String(src.type || 'github') as FormBuilderState['synth']['sourceType'];
      const opts = (src.options as AnyRecord) || {};
      base.synth.sourceType = srcType;
      switch (srcType) {
        case 's3':
          base.synth.s3 = {
            bucketName: String(opts.bucketName || ''),
            objectKey: String(opts.objectKey || ''),
            trigger: String(opts.trigger || 'NONE'),
          };
          break;
        case 'github':
          base.synth.github = {
            repo: String(opts.repo || ''),
            branch: String(opts.branch || ''),
            token: String(opts.token || ''),
            trigger: String(opts.trigger || 'NONE'),
          };
          break;
        case 'codestar':
          base.synth.codestar = {
            repo: String(opts.repo || ''),
            branch: String(opts.branch || ''),
            connectionArn: String(opts.connectionArn || ''),
            trigger: String(opts.trigger || 'NONE'),
            codeBuildCloneOutput: Boolean(opts.codeBuildCloneOutput),
          };
          break;
      }
    }

    if (synth.plugin) {
      base.synth.plugin = parsePluginOptions(synth.plugin);
    }
    if (synth.metadata) {
      base.synth.metadata = parseMetadataEntries(synth.metadata);
    }
    if (synth.network) {
      const { networkType, network } = parseNetworkConfig(synth.network);
      base.synth.networkType = networkType;
      base.synth.network = network;
    }
  }

  // Stages
  if (Array.isArray(rawProps.stages)) {
    base.stages = rawProps.stages.map((s: unknown) => {
      const stage = s as AnyRecord;
      return {
        stageName: String(stage.stageName || ''),
        alias: String(stage.alias || ''),
        steps: Array.isArray(stage.steps) ? parseSteps(stage.steps) : [createEmptyStep()],
      };
    });
  }

  return base;
}

// ═══════════════════════════════════════════════════════════════
//  VALIDATION (FormBuilderState → errors)
// ═══════════════════════════════════════════════════════════════

/**
 * Validate form state and return a map of field-path → error message.
 * Pure function — no side effects.
 */
export function validateFormState(state: FormBuilderState): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!state.project.trim()) errors['project'] = 'Project is required';
  if (!state.organization.trim()) errors['organization'] = 'Organization is required';

  // Synth source
  switch (state.synth.sourceType) {
    case 's3':
      if (!state.synth.s3.bucketName.trim()) errors['synth.s3.bucketName'] = 'Bucket name is required';
      break;
    case 'github':
      if (!state.synth.github.repo.trim()) errors['synth.github.repo'] = 'Repository is required';
      else if (!state.synth.github.repo.includes('/')) errors['synth.github.repo'] = 'Format: owner/repo';
      break;
    case 'codestar':
      if (!state.synth.codestar.repo.trim()) errors['synth.codestar.repo'] = 'Repository is required';
      if (!state.synth.codestar.connectionArn.trim()) errors['synth.codestar.connectionArn'] = 'Connection ARN is required';
      break;
  }

  if (!state.synth.plugin.name.trim()) errors['synth.plugin.name'] = 'Plugin name is required';

  // Role
  if (state.role.type === 'roleArn' && !state.role.roleArn.trim()) errors['role.roleArn'] = 'Role ARN is required';
  if (state.role.type === 'roleName' && !state.role.roleName.trim()) errors['role.roleName'] = 'Role name is required';

  // Stages
  for (let i = 0; i < state.stages.length; i++) {
    const stage = state.stages[i];
    if (!stage.stageName.trim()) errors[`stages.${i}.stageName`] = 'Stage name is required';
    if (stage.steps.length === 0) errors[`stages.${i}.steps`] = 'Stage must have at least one step';
    for (let j = 0; j < stage.steps.length; j++) {
      if (!stage.steps[j].plugin.name.trim()) {
        errors[`stages.${i}.steps.${j}.plugin.name`] = 'Plugin name is required';
      }
    }
  }

  return errors;
}

// ═══════════════════════════════════════════════════════════════
//  ASSEMBLY (FormBuilderState → BuilderProps)
// ═══════════════════════════════════════════════════════════════

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
): { props: BuilderProps | null; errors: Record<string, string> } {
  const errors = validateFormState(state);
  if (Object.keys(errors).length > 0) return { props: null, errors };

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
        return {
          plugin: assemblePluginOptions(step.plugin),
          ...(stepMeta && { metadata: stepMeta }),
          ...(stepNetwork && { network: stepNetwork }),
          ...(step.preInstallCommands.filter(Boolean).length > 0 && { preInstallCommands: step.preInstallCommands.filter(Boolean) }),
          ...(step.postInstallCommands.filter(Boolean).length > 0 && { postInstallCommands: step.postInstallCommands.filter(Boolean) }),
          ...(step.preCommands.filter(Boolean).length > 0 && { preCommands: step.preCommands.filter(Boolean) }),
          ...(step.postCommands.filter(Boolean).length > 0 && { postCommands: step.postCommands.filter(Boolean) }),
          ...(stepEnv && { env: stepEnv }),
          ...(step.position === 'post' && { position: 'post' }),
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
