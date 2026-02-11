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
  position: 'pre' | 'post';
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
    position: 'pre',
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

