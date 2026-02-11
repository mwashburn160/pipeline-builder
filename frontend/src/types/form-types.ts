/**
 * Mutable form state types for the Pipeline Form Builder.
 * These parallel the readonly BuilderProps types from pipeline-core
 * but are designed for React form state management.
 */

export interface MetadataEntry {
  key: string;
  value: string;
  type: 'string' | 'number' | 'boolean';
}

export interface EnvEntry {
  key: string;
  value: string;
}

export interface TagEntry {
  key: string;
  value: string;
}

export interface FormPluginFilter {
  // Common filter properties
  id: string;
  orgId: string;
  accessModifier: string;
  isDefault: string;
  isActive: string;
  // Plugin-specific filter properties
  name: string;
  namePattern: string;
  version: string;
  versionMin: string;
  versionMax: string;
  imageTag: string;
}

export interface FormPluginOptions {
  name: string;
  alias: string;
  filter: FormPluginFilter;
  metadata: MetadataEntry[];
}

export interface FormNetworkConfig {
  // subnetIds variant
  vpcId: string;
  subnetIds: string[];
  securityGroupIds: string[];
  // vpcId / vpcLookup shared
  subnetType: string;
  availabilityZones: string[];
  subnetGroupName: string;
  // vpcLookup variant
  tags: TagEntry[];
  vpcName: string;
  region: string;
}

export interface FormSecurityGroupConfig {
  securityGroupIds: string[];
  mutable: boolean;
  securityGroupName: string;
  vpcId: string;
}

export interface FormStep {
  plugin: FormPluginOptions;
  metadata: MetadataEntry[];
  networkType: 'none' | 'subnetIds' | 'vpcId' | 'vpcLookup';
  network: FormNetworkConfig;
  preInstallCommands: string[];
  postInstallCommands: string[];
  preCommands: string[];
  postCommands: string[];
  env: EnvEntry[];
}

export interface FormStage {
  stageName: string;
  alias: string;
  steps: FormStep[];
}

export interface FormBuilderState {
  // Core
  project: string;
  organization: string;
  pipelineName: string;

  // Global metadata
  global: MetadataEntry[];

  // Defaults
  defaults: {
    enabled: boolean;
    networkType: 'none' | 'subnetIds' | 'vpcId' | 'vpcLookup';
    network: FormNetworkConfig;
    securityGroupType: 'none' | 'securityGroupIds' | 'securityGroupLookup';
    securityGroup: FormSecurityGroupConfig;
    metadata: MetadataEntry[];
  };

  // Role
  role: {
    type: 'none' | 'roleArn' | 'roleName' | 'codeBuildDefault';
    roleArn: string;
    roleName: string;
    mutable: boolean;
  };

  // Synth (required)
  synth: {
    sourceType: 's3' | 'github' | 'codestar';
    s3: { bucketName: string; objectKey: string; trigger: string };
    github: { repo: string; branch: string; token: string; trigger: string };
    codestar: { repo: string; branch: string; connectionArn: string; trigger: string; codeBuildCloneOutput: boolean };
    plugin: FormPluginOptions;
    metadata: MetadataEntry[];
    networkType: 'none' | 'subnetIds' | 'vpcId' | 'vpcLookup';
    network: FormNetworkConfig;
  };

  // Stages
  stages: FormStage[];
}

export function createEmptyNetworkConfig(): FormNetworkConfig {
  return {
    vpcId: '',
    subnetIds: [],
    securityGroupIds: [],
    subnetType: 'PRIVATE_WITH_EGRESS',
    availabilityZones: [],
    subnetGroupName: '',
    tags: [],
    vpcName: '',
    region: '',
  };
}

export function createEmptyPluginFilter(): FormPluginFilter {
  return { id: '', orgId: '', accessModifier: '', isDefault: '', isActive: '', name: '', namePattern: '', version: '', versionMin: '', versionMax: '', imageTag: '' };
}

export function createEmptyPlugin(): FormPluginOptions {
  return { name: '', alias: '', filter: createEmptyPluginFilter(), metadata: [] };
}

export function createEmptyStep(): FormStep {
  return {
    plugin: createEmptyPlugin(),
    metadata: [],
    networkType: 'none',
    network: createEmptyNetworkConfig(),
    preInstallCommands: [],
    postInstallCommands: [],
    preCommands: [],
    postCommands: [],
    env: [],
  };
}

export function createEmptyStage(): FormStage {
  return { stageName: '', alias: '', steps: [createEmptyStep()] };
}

export function createInitialFormState(): FormBuilderState {
  return {
    project: '',
    organization: '',
    pipelineName: '',
    global: [],
    defaults: {
      enabled: false,
      networkType: 'none',
      network: createEmptyNetworkConfig(),
      securityGroupType: 'none',
      securityGroup: {
        securityGroupIds: [],
        mutable: true,
        securityGroupName: '',
        vpcId: '',
      },
      metadata: [],
    },
    role: {
      type: 'none',
      roleArn: '',
      roleName: '',
      mutable: true,
    },
    synth: {
      sourceType: 'github',
      s3: { bucketName: '', objectKey: '', trigger: 'NONE' },
      github: { repo: '', branch: '', token: '', trigger: 'NONE' },
      codestar: { repo: '', branch: '', connectionArn: '', trigger: 'NONE', codeBuildCloneOutput: false },
      plugin: createEmptyPlugin(),
      metadata: [],
      networkType: 'none',
      network: createEmptyNetworkConfig(),
    },
    stages: [],
  };
}

// ─── Props-to-FormState Conversion (for Edit mode) ──────────────

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
    };
  });
}

/**
 * Convert BuilderProps (from API) back into FormBuilderState (for edit mode).
 * This is the reverse of assembleBuilderPropsFromState in useFormBuilderState.ts.
 */
export function propsToFormState(props: AnyRecord): FormBuilderState {
  const base = createInitialFormState();

  // Core
  base.project = String(props.project || '');
  base.organization = String(props.organization || '');
  base.pipelineName = String(props.pipelineName || '');

  // Global metadata
  if (props.global) {
    base.global = parseMetadataEntries(props.global);
  }

  // Defaults
  if (props.defaults) {
    const d = props.defaults as AnyRecord;
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
  if (props.role) {
    const r = props.role as AnyRecord;
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
  if (props.synth) {
    const synth = props.synth as AnyRecord;

    // Source
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

    // Synth plugin
    if (synth.plugin) {
      base.synth.plugin = parsePluginOptions(synth.plugin);
    }

    // Synth metadata
    if (synth.metadata) {
      base.synth.metadata = parseMetadataEntries(synth.metadata);
    }

    // Synth network
    if (synth.network) {
      const { networkType, network } = parseNetworkConfig(synth.network);
      base.synth.networkType = networkType;
      base.synth.network = network;
    }
  }

  // Stages
  if (Array.isArray(props.stages)) {
    base.stages = props.stages.map((s: unknown) => {
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
