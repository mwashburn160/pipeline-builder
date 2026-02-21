import {
  createEmptyNetworkConfig,
  createEmptyPluginFilter,
  createEmptyPlugin,
  createEmptyStep,
  createEmptyStage,
  createInitialFormState,
} from '../src/types/form-types';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createEmptyNetworkConfig', () => {
  it('should return empty network config with default values', () => {
    const config = createEmptyNetworkConfig();
    expect(config.vpcId).toBe('');
    expect(config.subnetIds).toEqual([]);
    expect(config.securityGroupIds).toEqual([]);
    expect(config.subnetType).toBe('PRIVATE_WITH_EGRESS');
    expect(config.availabilityZones).toEqual([]);
    expect(config.subnetGroupName).toBe('');
    expect(config.tags).toEqual([]);
    expect(config.vpcName).toBe('');
    expect(config.region).toBe('');
  });

  it('should return a new object each time', () => {
    const a = createEmptyNetworkConfig();
    const b = createEmptyNetworkConfig();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe('createEmptyPluginFilter', () => {
  it('should return filter with all empty strings', () => {
    const filter = createEmptyPluginFilter();
    expect(filter.id).toBe('');
    expect(filter.orgId).toBe('');
    expect(filter.name).toBe('');
    expect(filter.version).toBe('');
    expect(filter.imageTag).toBe('');
  });
});

describe('createEmptyPlugin', () => {
  it('should return plugin with empty name, alias, filter, and metadata', () => {
    const plugin = createEmptyPlugin();
    expect(plugin.name).toBe('');
    expect(plugin.alias).toBe('');
    expect(plugin.filter).toEqual(createEmptyPluginFilter());
    expect(plugin.metadata).toEqual([]);
  });
});

describe('createEmptyStep', () => {
  it('should return step with default values', () => {
    const step = createEmptyStep();
    expect(step.plugin.name).toBe('');
    expect(step.metadata).toEqual([]);
    expect(step.networkType).toBe('none');
    expect(step.installCommands).toEqual({ position: 'pre', commands: [] });
    expect(step.buildCommands).toEqual({ position: 'pre', commands: [] });
    expect(step.env).toEqual([]);
    expect(step.position).toBe('pre');
    expect(step.inputArtifact).toBe('');
    expect(step.additionalInputArtifacts).toEqual([]);
  });
});

describe('createEmptyStage', () => {
  it('should return stage with one empty step', () => {
    const stage = createEmptyStage();
    expect(stage.stageName).toBe('');
    expect(stage.alias).toBe('');
    expect(stage.steps).toHaveLength(1);
    expect(stage.steps[0].plugin.name).toBe('');
  });
});

describe('createInitialFormState', () => {
  it('should return complete initial form state', () => {
    const state = createInitialFormState();

    // Core fields
    expect(state.project).toBe('');
    expect(state.organization).toBe('');
    expect(state.pipelineName).toBe('');
    expect(state.description).toBe('');
    expect(state.keywords).toBe('');
    expect(state.global).toEqual([]);
  });

  it('should have correct defaults section', () => {
    const state = createInitialFormState();
    expect(state.defaults.enabled).toBe(false);
    expect(state.defaults.networkType).toBe('none');
    expect(state.defaults.securityGroupType).toBe('none');
    expect(state.defaults.metadata).toEqual([]);
  });

  it('should have correct role section', () => {
    const state = createInitialFormState();
    expect(state.role.type).toBe('none');
    expect(state.role.roleArn).toBe('');
    expect(state.role.roleName).toBe('');
    expect(state.role.mutable).toBe(true);
  });

  it('should have correct synth section', () => {
    const state = createInitialFormState();
    expect(state.synth.sourceType).toBe('github');
    expect(state.synth.s3.bucketName).toBe('');
    expect(state.synth.github.repo).toBe('');
    expect(state.synth.codestar.connectionArn).toBe('');
    expect(state.synth.plugin.name).toBe('');
    expect(state.synth.networkType).toBe('none');
  });

  it('should have empty stages', () => {
    const state = createInitialFormState();
    expect(state.stages).toEqual([]);
  });

  it('should return a new object each time', () => {
    const a = createInitialFormState();
    const b = createInitialFormState();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
