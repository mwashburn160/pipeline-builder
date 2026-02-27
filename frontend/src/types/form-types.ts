/**
 * Mutable form state types for the Pipeline Form Builder.
 * These parallel the readonly BuilderProps types from pipeline-core
 * but are designed for React form state management.
 */

/** A single key-value metadata entry with an explicit value type for serialization. */
export interface MetadataEntry {
  key: string;
  value: string;
  /** Controls how `value` is coerced during assembly (e.g. "true" -> boolean). */
  type: 'string' | 'number' | 'boolean';
}

/** A key-value pair representing an environment variable passed to a build step. */
export interface EnvEntry {
  key: string;
  value: string;
}

/** A key-value pair representing an AWS resource tag (used in VPC lookups). */
export interface TagEntry {
  key: string;
  value: string;
}

/**
 * Mutable filter criteria used to resolve a plugin at synth/step time.
 * All fields are strings so they bind directly to form inputs;
 * boolean-like fields ("true"/"false") are coerced during assembly.
 */
export interface FormPluginFilter {
  // Common filter properties
  id: string;
  orgId: string;
  accessModifier: string;
  /** String "true"/"false" — coerced to boolean during assembly. */
  isDefault: string;
  /** String "true"/"false" — coerced to boolean during assembly. */
  isActive: string;
  // Plugin-specific filter properties
  name: string;
  version: string;
  imageTag: string;
}

/** Plugin selection with an optional alias, filter criteria, and per-plugin metadata. */
export interface FormPluginOptions {
  name: string;
  alias: string;
  filter: FormPluginFilter;
  metadata: MetadataEntry[];
}

/**
 * Superset of fields for all three network config variants (subnetIds, vpcId, vpcLookup).
 * Only fields relevant to the selected `networkType` are assembled into the API payload.
 */
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

/**
 * Superset of fields for security group config variants (securityGroupIds, securityGroupLookup).
 * Only fields relevant to the selected `securityGroupType` are assembled.
 */
export interface FormSecurityGroupConfig {
  securityGroupIds: string[];
  mutable: boolean;
  securityGroupName: string;
  vpcId: string;
}

/** Reference to an artifact from another stage/step, used as additional input in a build step. */
export interface AdditionalInputArtifact {
  /** Directory path where the artifact will be mounted. */
  path: string;
  /** Colon-delimited artifact key: stageName:stageAlias:pluginName:pluginAlias:outputDirectory. */
  key: string;
}

/** A command group with a position (pre/post) and a list of commands */
export interface CommandGroup {
  position: 'pre' | 'post';
  commands: string[];
}

/** A single build step within a stage, including its plugin, commands, network, and artifacts. */
export interface FormStep {
  /** Stable unique ID for React key (not persisted) */
  id: string;
  plugin: FormPluginOptions;
  metadata: MetadataEntry[];
  networkType: 'none' | 'subnetIds' | 'vpcId' | 'vpcLookup';
  network: FormNetworkConfig;
  installCommands: CommandGroup;
  buildCommands: CommandGroup;
  env: EnvEntry[];
  /** Whether this step runs before or after the primary synth action. */
  position: 'pre' | 'post';
  /** Colon-delimited artifact key referencing another step's output. */
  inputArtifact: string;
  additionalInputArtifacts: AdditionalInputArtifact[];
  /** Build timeout in minutes (overrides plugin default). */
  timeout: string;
  /** Failure behavior (overrides plugin default). */
  failureBehavior: 'fail' | 'warn' | 'ignore';
}

/** A named pipeline stage containing one or more build steps. */
export interface FormStage {
  /** Stable unique ID for React key (not persisted) */
  id: string;
  stageName: string;
  alias: string;
  steps: FormStep[];
}

/**
 * Top-level mutable state for the Pipeline Form Builder.
 * Mirrors the readonly BuilderProps shape from pipeline-core but is
 * designed for two-way binding with React form controls.
 */
export interface FormBuilderState {
  // Core
  project: string;
  organization: string;
  pipelineName: string;
  description: string;
  /** Comma-separated keywords for pipeline discovery/search. */
  keywords: string;

  // Global metadata
  /** Metadata entries applied to every stage/step in the pipeline. */
  global: MetadataEntry[];

  // Defaults
  /** Default network, security group, and metadata applied to steps that don't override them. */
  defaults: {
    /** Whether the defaults section is active in the form. */
    enabled: boolean;
    networkType: 'none' | 'subnetIds' | 'vpcId' | 'vpcLookup';
    network: FormNetworkConfig;
    securityGroupType: 'none' | 'securityGroupIds' | 'securityGroupLookup';
    securityGroup: FormSecurityGroupConfig;
    metadata: MetadataEntry[];
  };

  // Role
  /** IAM role configuration for the pipeline's CodeBuild project. */
  role: {
    type: 'none' | 'roleArn' | 'roleName' | 'codeBuildDefault';
    roleArn: string;
    roleName: string;
    mutable: boolean;
  };

  // Synth (required)
  /** Source repository and synth plugin configuration. */
  synth: {
    sourceType: 's3' | 'github' | 'codestar';
    s3: { bucketName: string; objectKey: string; trigger: string };
    github: { repo: string; branch: string; token: string; trigger: string };
    codestar: { repo: string; branch: string; connectionArn: string; trigger: string; codeBuildCloneOutput: boolean };
    plugin: FormPluginOptions;
    metadata: MetadataEntry[];
    networkType: 'none' | 'subnetIds' | 'vpcId' | 'vpcLookup';
    network: FormNetworkConfig;
    /** Custom install commands injected before/after the synth plugin's install commands. */
    installCommands: CommandGroup;
    /** Custom build commands injected before/after the synth plugin's build commands. */
    buildCommands: CommandGroup;
    /** Environment variables passed to the synth step. */
    env: EnvEntry[];
  };

  // Stages
  stages: FormStage[];
}

/**
 * Creates a blank network config with safe defaults (PRIVATE_WITH_EGRESS subnet type).
 * @returns An empty {@link FormNetworkConfig} ready for form binding.
 */
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

/**
 * Creates a blank plugin filter with all fields set to empty strings.
 * @returns An empty {@link FormPluginFilter}.
 */
export function createEmptyPluginFilter(): FormPluginFilter {
  return { id: '', orgId: '', accessModifier: '', isDefault: '', isActive: '', name: '', version: '', imageTag: '' };
}

/**
 * Creates a blank plugin options object with an empty filter and no metadata.
 * @returns An empty {@link FormPluginOptions}.
 */
export function createEmptyPlugin(): FormPluginOptions {
  return { name: '', alias: '', filter: createEmptyPluginFilter(), metadata: [] };
}

let _idCounter = 0;
/**
 * Generates a unique form-element ID for React keys.
 * IDs are ephemeral and not persisted to the API.
 * @returns A string in the format `form-{counter}-{timestamp}`.
 */
export function nextFormId(): string {
  return `form-${++_idCounter}-${Date.now()}`;
}

/**
 * Creates a blank build step with default values (no network, no commands, pre position).
 * @returns An empty {@link FormStep} with a unique ID.
 */
export function createEmptyStep(): FormStep {
  return {
    id: nextFormId(),
    plugin: createEmptyPlugin(),
    metadata: [],
    networkType: 'none',
    network: createEmptyNetworkConfig(),
    installCommands: { position: 'pre', commands: [] },
    buildCommands: { position: 'pre', commands: [] },
    env: [],
    position: 'pre',
    inputArtifact: '',
    additionalInputArtifacts: [],
    timeout: '',
    failureBehavior: 'fail',
  };
}

/**
 * Creates a blank pipeline stage containing one empty step.
 * @returns An empty {@link FormStage} with a unique ID.
 */
export function createEmptyStage(): FormStage {
  return { id: nextFormId(), stageName: '', alias: '', steps: [createEmptyStep()] };
}

/**
 * Creates the initial (blank) form state used when building a new pipeline.
 * Defaults to GitHub source type, no network, no role, and no stages.
 * @returns A fully initialized {@link FormBuilderState}.
 */
export function createInitialFormState(): FormBuilderState {
  return {
    project: '',
    organization: '',
    pipelineName: '',
    description: '',
    keywords: '',
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
      installCommands: { position: 'pre', commands: [] },
      buildCommands: { position: 'pre', commands: [] },
      env: [],
    },
    stages: [],
  };
}

