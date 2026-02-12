/**
 * @module props-parsing
 * @description Converts BuilderProps (API) into FormBuilderState (UI) for edit mode.
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
  AdditionalInputArtifact,
  createInitialFormState,
  createEmptyNetworkConfig,
  createEmptyPlugin,
  createEmptyStep,
} from './form-types';

type AnyRecord = Record<string, unknown>;

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

function artifactKeyToString(key: unknown): string {
  if (!key || typeof key !== 'object') return '';
  const k = key as AnyRecord;
  return [k.stageName, k.stageAlias, k.pluginName, k.pluginAlias, k.outputDirectory]
    .map((v) => String(v || ''))
    .join(':');
}

export function parseArtifactKeyString(key: string): Record<string, string> {
  const [stageName = '', stageAlias = '', pluginName = '', pluginAlias = '', outputDirectory = ''] = key.split(':');
  return { stageName, stageAlias, pluginName, pluginAlias, outputDirectory };
}

function parseAdditionalInputArtifacts(obj: unknown): AdditionalInputArtifact[] {
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj as AnyRecord).map(([path, key]) => ({
    path,
    key: artifactKeyToString(key),
  }));
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
      installCommands: {
        position: Array.isArray(step.postInstallCommands) && step.postInstallCommands.length > 0 ? 'post' : 'pre',
        commands: Array.isArray(step.postInstallCommands) && step.postInstallCommands.length > 0
          ? step.postInstallCommands.map(String)
          : Array.isArray(step.preInstallCommands) ? step.preInstallCommands.map(String) : [],
      },
      buildCommands: {
        position: Array.isArray(step.postCommands) && step.postCommands.length > 0 ? 'post' : 'pre',
        commands: Array.isArray(step.postCommands) && step.postCommands.length > 0
          ? step.postCommands.map(String)
          : Array.isArray(step.preCommands) ? step.preCommands.map(String) : [],
      },
      env: parseEnvEntries(step.env),
      position: step.position === 'post' ? 'post' : 'pre',
      inputArtifact: step.inputArtifact ? artifactKeyToString(step.inputArtifact) : '',
      additionalInputArtifacts: parseAdditionalInputArtifacts(step.additionalInputArtifacts),
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
