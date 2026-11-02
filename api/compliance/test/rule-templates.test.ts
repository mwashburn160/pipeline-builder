// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import { RULE_TEMPLATES, type RuleTemplate } from '../src/data/rule-templates.js';

describe('RULE_TEMPLATES', () => {
  it('exports a non-empty array', () => {
    expect(Array.isArray(RULE_TEMPLATES)).toBe(true);
    expect(RULE_TEMPLATES.length).toBeGreaterThan(0);
  });

  it('every template has required fields', () => {
    for (const tpl of RULE_TEMPLATES) {
      expect(tpl.id).toMatch(/^tpl-/);
      expect(typeof tpl.name).toBe('string');
      expect(tpl.name.length).toBeGreaterThan(0);
      expect(typeof tpl.description).toBe('string');
      expect(typeof tpl.field).toBe('string');
      expect(typeof tpl.operator).toBe('string');
      expect(typeof tpl.priority).toBe('number');
      expect(Array.isArray(tpl.tags)).toBe(true);
      expect(typeof tpl.category).toBe('string');
    }
  });

  it('every template targets either plugin or pipeline', () => {
    const allowed: RuleTemplate['target'][] = ['plugin', 'pipeline'];
    for (const tpl of RULE_TEMPLATES) {
      expect(allowed).toContain(tpl.target);
    }
  });

  it('every template severity is warning, error, or critical', () => {
    const allowed: RuleTemplate['severity'][] = ['warning', 'error', 'critical'];
    for (const tpl of RULE_TEMPLATES) {
      expect(allowed).toContain(tpl.severity);
    }
  });

  it('template ids are unique', () => {
    const ids = RULE_TEMPLATES.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('template names are unique', () => {
    const names = RULE_TEMPLATES.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('regex templates have string values', () => {
    for (const tpl of RULE_TEMPLATES.filter(t => t.operator === 'regex')) {
      expect(typeof tpl.value).toBe('string');
      // verify they are valid regex patterns
      expect(() => new RegExp(tpl.value as string)).not.toThrow();
    }
  });

  it('contains at least one plugin and one pipeline template', () => {
    expect(RULE_TEMPLATES.some(t => t.target === 'plugin')).toBe(true);
    expect(RULE_TEMPLATES.some(t => t.target === 'pipeline')).toBe(true);
  });
});

/**
 * A starter template names a FIELD, and the engine reads that field off the
 * entity row verbatim — `toComplianceAttributes` redacts secrets but never
 * renames anything. So a template whose field does not exist matches
 * `undefined` on every entity, and at `error` severity that blocks the entire
 * org the moment an admin applies it.
 *
 * Two shipped that way: `pipeline-naming-convention` asked for `name` when the
 * column is `pipelineName`, and `max-pipeline-timeout` asked for
 * `timeoutInMinutes`, which exists nowhere — not on the row, not in `props`
 * (`timeout` is a per-STEP metadata passthrough). The shape checks above pass
 * happily for both, because the shape was never the problem.
 */
describe('every template field exists on the entity it targets', () => {
  it('names a real column', async () => {
    const { schema } = await import('@pipeline-builder/pipeline-data');
    const { getTableColumns } = await import('drizzle-orm');

    const columns: Record<RuleTemplate['target'], Set<string>> = {
      plugin: new Set(Object.keys(getTableColumns(schema.plugin))),
      pipeline: new Set(Object.keys(getTableColumns(schema.pipeline))),
    };

    const { STEP_FACTS_KEY, STEP_FACT_FIELDS } = await import('../src/helpers/pipeline-step-facts.js');
    const stepFacts = new Set<string>(STEP_FACT_FIELDS);

    const unknown = RULE_TEMPLATES
      // A pipeline's derived step facts are not a column but a resolved
      // attribute — every field named must be one the derivation produces.
      .filter((tpl) => !(tpl.target === 'pipeline' && tpl.field.startsWith(`${STEP_FACTS_KEY}.`)
        ? stepFacts.has(tpl.field.slice(STEP_FACTS_KEY.length + 1))
        // Dotted paths (`props.foo`) are resolved inside the row, so only the
        // first segment has to be a column.
        : columns[tpl.target].has(tpl.field.split('.')[0])))
      .map((tpl) => `${tpl.id} → ${tpl.target}.${tpl.field}`);

    expect(unknown).toEqual([]);
  });
});

describe('derivePipelineStepFacts', () => {
  const scanner = { category: 'security', pluginType: 'CodeBuildStep', kev: 0 };
  const build = { category: 'language', pluginType: 'CodeBuildStep', kev: 0 };
  const approval = { category: 'deploy', pluginType: 'ManualApprovalStep', kev: 0 };
  const props = (stages: unknown[]) => ({ project: 'p', organization: 'o', synth: { plugin: { name: 'cdk-synth' } }, stages });

  it('counts security-category steps and KEV steps from what each step resolved to', async () => {
    const { derivePipelineStepFacts } = await import('../src/helpers/pipeline-step-facts.js');
    const p = props([{ stageName: 'Build', steps: [{ plugin: { name: 'trivy' } }, { plugin: { name: 'node' } }] }]);
    const facts = derivePipelineStepFacts(p, new Map([
      ['synth', build],
      ['stages[0].steps[0]', scanner],
      ['stages[0].steps[1]', { ...build, kev: 2 }],
    ]));
    expect(facts).toEqual(expect.objectContaining({ securityScanSteps: 1, kevSteps: 1, kevStepNames: ['Build/node'] }));
  });

  it('requires an approval step before a production stage (earlier stage or a pre step in it)', async () => {
    const { derivePipelineStepFacts } = await import('../src/helpers/pipeline-step-facts.js');
    const ungated = props([
      { stageName: 'Build', steps: [{ plugin: { name: 'node' } }] },
      { stageName: 'Prod', environment: 'production', steps: [{ plugin: { name: 'deploy' } }] },
    ]);
    expect(derivePipelineStepFacts(ungated, new Map([['stages[0].steps[0]', build]])).approvalBeforeProduction).toBe(false);

    const gatedEarlier = props([
      { stageName: 'Gate', steps: [{ plugin: { name: 'approve' } }] },
      { stageName: 'Prod', environment: 'prod', steps: [{ plugin: { name: 'deploy' } }] },
    ]);
    expect(derivePipelineStepFacts(gatedEarlier, new Map([['stages[0].steps[0]', approval]])).approvalBeforeProduction).toBe(true);

    const postOnly = props([
      { stageName: 'Prod', environment: 'prod', steps: [{ plugin: { name: 'deploy' } }, { plugin: { name: 'approve' }, position: 'post' }] },
    ]);
    expect(derivePipelineStepFacts(postOnly, new Map([['stages[0].steps[1]', approval]])).approvalBeforeProduction).toBe(false);

    // No production stage: nothing to gate.
    expect(derivePipelineStepFacts(props([{ stageName: 'Build', steps: [{ plugin: { name: 'node' } }] }]), new Map()))
      .toEqual(expect.objectContaining({ productionStages: 0, approvalBeforeProduction: true }));
  });

  it('enforces rules on vulnerability step facts as warnings, leaving the others alone', async () => {
    const { asNonBlockingVulnRules } = await import('../src/helpers/pipeline-step-facts.js');
    const rules = [
      { id: 'kev', field: 'stepFacts.kevSteps', severity: 'critical' },
      { id: 'kev-cond', field: null, conditions: [{ field: '$count(stepFacts.kevStepNames)' }], severity: 'error' },
      { id: 'scan', field: 'stepFacts.securityScanSteps', severity: 'error' },
      { id: 'name', field: 'pipelineName', severity: 'critical' },
    ];
    expect(asNonBlockingVulnRules(rules).map((r) => [r.id, r.severity])).toEqual([
      ['kev', 'warning'], ['kev-cond', 'warning'], ['scan', 'error'], ['name', 'critical'],
    ]);
  });

  it('only rules reading stepFacts trigger the resolution', async () => {
    const { rulesReadStepFacts } = await import('../src/helpers/pipeline-step-facts.js');
    expect(rulesReadStepFacts([{ field: 'pipelineName' }])).toBe(false);
    expect(rulesReadStepFacts([{ field: 'stepFacts.kevSteps' }])).toBe(true);
    expect(rulesReadStepFacts([{ field: null, conditions: [{ field: '$count(stepFacts.kevStepNames)' }] }])).toBe(true);
  });
});
