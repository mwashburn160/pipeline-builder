// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin contract enforcement (W0.2): the pure checks the pipeline service
 * runs at create/update, and the synth-time guard in StageBuilder.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { App, Stack } from 'aws-cdk-lib';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const createCodeBuildStepMock = jest.fn((opts: Record<string, unknown>) => ({ __step: true, id: opts.id }));
jest.unstable_mockModule('../src/core/pipeline-helpers.js', () => ({
  createCodeBuildStep: createCodeBuildStepMock,
  getComputeType: () => 'BUILD_GENERAL1_SMALL',
}));

const {
  assertPluginContract,
  checkPluginContract,
  collectPluginSteps,
  contractScopeFromTemplateScope,
  isContractValueOfType,
  pipelineContractScope,
  pluginLookupFilter,
} = await import('../src/core/plugin-contract.js');
const { StageBuilder } = await import('../src/pipeline/stage-builder.js');
const { PipelineConfiguration } = await import('../src/pipeline/pipeline-configuration.js');
const { UniqueId } = await import('../src/core/id-generator.js');

describe('isContractValueOfType (mirrors the template evaluator)', () => {
  it.each([
    ['string', 'x', true],
    ['string', 3, true],
    ['string', { a: 1 }, false],
    ['number', 3, true],
    ['number', '3.5', true],
    ['number', 'three', false],
    ['number', Infinity, false],
    ['bool', true, true],
    ['bool', ' Yes ', true],
    ['bool', 0, true],
    ['bool', 'maybe', false],
    ['json', '{"a":1}', true],
    ['json', 42, true],
    ['json', '{bad', false],
    ['json', { a: 1 }, false],
    ['json', ['a'], false],
  ] as const)('%s accepts %j → %s', (type, value, ok) => {
    expect(isContractValueOfType(value, type)).toBe(ok);
  });
});

describe('checkPluginContract', () => {
  const contract = {
    requiredMetadata: ['env', 'count'],
    requiredVars: ['branch'],
    metadataTypes: { count: 'number' as const, enabled: 'bool' as const },
    varsTypes: { branch: 'string' as const, config: 'json' as const },
  };

  it('is empty when every required key is supplied with its declared type', () => {
    expect(checkPluginContract(contract, {
      metadata: { env: 'prod', count: '3', enabled: 'true' },
      vars: { branch: 'main', config: '{"x":1}' },
    })).toEqual([]);
  });

  it('reports missing keys (absent, null, empty string) and ill-typed values', () => {
    const issues = checkPluginContract(contract, {
      metadata: { env: '', count: 'many', enabled: 'perhaps' },
      vars: { branch: null, config: { x: 1 } },
    });
    expect(issues.map((i) => [i.kind, i.key, i.problem, i.expected])).toEqual([
      ['metadata', 'env', 'missing', undefined],
      ['metadata', 'count', 'type', 'number'],
      ['metadata', 'enabled', 'type', 'bool'],
      ['vars', 'branch', 'missing', undefined],
      ['vars', 'config', 'type', 'json'],
    ]);
    expect(issues[1]!.message).toBe('pipeline metadata.count must be a number, got "many"');
    expect(issues[4]!.message).toBe('pipeline vars.config must be a json, got an object');
  });

  it('does not type-check a value that is still a template (resolved later)', () => {
    expect(checkPluginContract(contract, {
      metadata: { env: 'prod', count: '{{ vars.n }}' },
      vars: { branch: 'main' },
    })).toEqual([]);
  });

  it('tolerates a plugin with no contract (null / absent fields)', () => {
    expect(checkPluginContract({ requiredMetadata: null, metadataTypes: null }, { metadata: {}, vars: {} })).toEqual([]);
    expect(checkPluginContract({}, { metadata: {}, vars: {} })).toEqual([]);
  });
});

describe('pipelineContractScope', () => {
  it('merges global ← defaults.metadata ← synth.metadata exactly as PipelineConfiguration does', () => {
    const props = {
      project: 'p',
      organization: 'o',
      global: { a: 'global', b: 'global' },
      defaults: { metadata: { b: 'defaults', c: 'defaults' } },
      synth: { source: { type: 'github', options: { repo: 'o/r' } }, plugin: { name: 'cdk-synth' }, metadata: { c: 'synth' } },
      vars: { branch: 'main' },
    };
    const scope = pipelineContractScope(props);
    expect(scope).toEqual({ metadata: { a: 'global', b: 'defaults', c: 'synth' }, vars: { branch: 'main' } });
    const config = new PipelineConfiguration(props as never);
    expect(contractScopeFromTemplateScope(config.getPipelineScope())).toEqual(scope);
  });

  it('treats absent / malformed sections as empty', () => {
    expect(pipelineContractScope({ global: ['x'], defaults: null, synth: 'x', vars: 3 })).toEqual({ metadata: {}, vars: {} });
    expect(contractScopeFromTemplateScope({})).toEqual({ metadata: {}, vars: {} });
  });
});

describe('collectPluginSteps / pluginLookupFilter', () => {
  it('lists synth then every stage step, with a path and a label per step', () => {
    const steps = collectPluginSteps({
      synth: { plugin: { name: 'cdk-synth' } },
      stages: [
        { stageName: 'test', steps: [{ plugin: { name: 'jest', alias: 'unit' } }, { plugin: { name: 'jest' } }] },
        { steps: [{ plugin: { name: 'trivy', filter: { version: '^1.0.0' } } }, { plugin: {} }, 'junk'] },
      ],
    });
    expect(steps).toEqual([
      { path: 'synth', label: 'synth', name: 'cdk-synth' },
      { path: 'stages[0].steps[0]', label: 'test/unit', name: 'jest', alias: 'unit' },
      { path: 'stages[0].steps[1]', label: 'test/jest', name: 'jest' },
      { path: 'stages[1].steps[0]', label: 'stage 2/trivy', name: 'trivy', filter: { version: '^1.0.0' } },
    ]);
    expect(collectPluginSteps(null)).toEqual([]);
  });

  it('carries a step\'s publisher and labels it publisher/name', () => {
    expect(collectPluginSteps({ stages: [{ stageName: 'scan', steps: [{ plugin: { publisher: 'acme', name: 'lint' } }, { plugin: { publisher: '', name: 'lint' } }] }] })).toEqual([
      { path: 'stages[0].steps[0]', label: 'scan/acme/lint', name: 'lint', publisher: 'acme' },
      { path: 'stages[0].steps[1]', label: 'scan/lint', name: 'lint' },
    ]);
  });

  it('builds the same lookup filter synth sends', () => {
    expect(pluginLookupFilter({ name: 'jest' })).toEqual({ name: 'jest', isActive: true, isDefault: true });
    expect(pluginLookupFilter({ name: 'jest', filter: { version: '1.2.0' } })).toEqual({ name: 'jest', version: '1.2.0' });
    expect(pluginLookupFilter({ name: 'jest', filter: { name: 'other' } })).toEqual({ name: 'other' });
    expect(pluginLookupFilter({ name: 'lint', publisher: 'acme' })).toEqual({ name: 'lint', publisher: 'acme', isActive: true, isDefault: true });
    expect(pluginLookupFilter({ name: 'lint', publisher: 'acme', filter: { version: '^1.0.0' } })).toEqual({ name: 'lint', publisher: 'acme', version: '^1.0.0' });
  });
});

describe('synth-time guard', () => {
  it('assertPluginContract throws listing every unmet key', () => {
    expect(() => assertPluginContract(
      { name: 'helm-deploy', version: '1.0.0', requiredMetadata: ['namespace'], requiredVars: ['cluster'] },
      { metadata: {}, vars: {} },
      'deploy/helm',
    )).toThrow(/Step "deploy\/helm" uses plugin "helm-deploy@1.0.0" whose contract is not met:\n {2}• .*'namespace'\n {2}• .*'cluster'/);
    expect(() => assertPluginContract({ name: 'x', requiredVars: ['a'] }, { metadata: {}, vars: { a: 1 } }, 's')).not.toThrow();
  });

  function builder(pipelineScope: Record<string, unknown>, plugin: Record<string, unknown>) {
    return new StageBuilder({
      scope: new Stack(new App(), 'ContractStack'),
      pluginLookup: { plugin: () => ({ name: 'helm-deploy', version: '2.0.0', metadata: {}, ...plugin }) } as never,
      uniqueId: new UniqueId({ organization: 'acme', project: 'checkout' }),
      globalMetadata: {},
      orgId: 'org-1',
      pipelineScope,
    });
  }

  it('StageBuilder refuses a step whose plugin contract the pipeline does not meet', () => {
    const b = builder({ pipeline: { metadata: {}, vars: {} } }, { requiredMetadata: ['namespace'] });
    expect(() => b.addStage({ addWave: jest.fn() } as never, { stageName: 'deploy', steps: [{ plugin: { name: 'helm-deploy' } }] }))
      .toThrow(/Step "deploy\/helm-deploy" uses plugin "helm-deploy@2.0.0"/);
    expect(createCodeBuildStepMock).not.toHaveBeenCalled();
  });

  it('StageBuilder builds the step when the contract is met', () => {
    const b = builder({ pipeline: { metadata: { namespace: 'prod' }, vars: {} } }, { requiredMetadata: ['namespace'] });
    const pipeline = { addWave: jest.fn() };
    b.addStage(pipeline as never, { stageName: 'deploy', steps: [{ plugin: { name: 'helm-deploy' } }] });
    expect(pipeline.addWave).toHaveBeenCalledTimes(1);
  });
});
