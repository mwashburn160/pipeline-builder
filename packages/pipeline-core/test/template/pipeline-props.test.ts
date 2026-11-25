// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline props' own `{{ … }}` contract — the single implementation the
 * API (create/update validation, `GET ?resolve=true`, template instantiate), the
 * CLI (`--show-resolved`, `template validate`) and synth (PipelineBuilder) share:
 *
 *  - self-references live in `project`, `vars.*` and the metadata layers
 *    `global` ← `defaults.metadata` ← `synth.metadata` (last wins) — the same
 *    merge synth uses; a top-level `metadata` / `projectName` key is not a
 *    pipeline field and is never read;
 *  - `synth.source` fields other than `token` are the repository identity: a
 *    template may parameterize them with `{{ vars.* }}`, instantiate bakes them,
 *    and a pipeline must not carry one (it would never resolve).
 */

import { describe, it, expect } from '@jest/globals';
import { ErrorCode } from '@pipeline-builder/api-core';
import {
  bakeSourceTemplates,
  resolvePipelineProps,
  validatePipelineProps,
} from '../../src/template/pipeline-props.js';

describe('resolvePipelineProps', () => {
  it('resolves project, vars and every metadata layer against global ← defaults.metadata ← synth.metadata', () => {
    const props = {
      project: '{{ vars.service }}-{{ metadata.env }}',
      global: { env: 'dev', region: 'us-east-1', stack: '{{ metadata.env }}-{{ metadata.region }}' },
      defaults: { metadata: { tier: '{{ vars.tier }}' } },
      synth: { metadata: { env: 'prod', url: 'https://github.com/{{ vars.repo }}' } },
      vars: { service: 'checkout', tier: 'gold', repo: 'acme/{{ vars.service }}' },
    };
    const out = resolvePipelineProps(props);
    expect(out.project).toBe('checkout-prod');
    expect(out.global.stack).toBe('prod-us-east-1');
    expect(out.defaults.metadata.tier).toBe('gold');
    expect(out.synth.metadata.url).toBe('https://github.com/acme/checkout');
    expect(out.vars.repo).toBe('acme/checkout');
    // The overridden lower-layer value is left as written.
    expect(out.global.env).toBe('dev');
  });

  it('never mutates its input, and leaves everything outside the contract untouched', () => {
    const props = {
      project: 'app',
      global: { env: '{{ vars.stage }}' },
      synth: { source: { type: 'github', options: { repo: 'acme/app', token: 'secretsmanager:pb/{{ pipeline.vars.orgId }}/t' } } },
      stages: [{ name: 'deploy', steps: [{ commands: ['echo {{ pipeline.metadata.env }}'] }] }],
      vars: { stage: 'prod' },
    };
    const before = JSON.stringify(props);
    const out = resolvePipelineProps(props);
    expect(JSON.stringify(props)).toBe(before);
    expect(out.global.env).toBe('prod');
    // The token resolves at synth against the PIPELINE scope; stage text is plugin-scope.
    expect(out.synth.source.options.token).toBe('secretsmanager:pb/{{ pipeline.vars.orgId }}/t');
    expect(out.stages).toEqual(props.stages);
  });

  it('ignores a top-level `metadata` / `projectName` key (not pipeline fields)', () => {
    const props = { project: 'app', metadata: { a: '{{ vars.x }}' }, projectName: '{{ vars.x }}', vars: { x: '1' } };
    const out = resolvePipelineProps(props);
    expect(out.metadata.a).toBe('{{ vars.x }}');
    expect(out.projectName).toBe('{{ vars.x }}');
  });

  it('throws on an unresolved reference and on a cycle', () => {
    expect(() => resolvePipelineProps({ project: 'app', global: { a: '{{ vars.missing }}' } })).toThrow(/Pipeline resolution failed[\s\S]*global\.a|metadata\.a/);
    expect(() => resolvePipelineProps({ project: 'app', global: { a: '{{ metadata.b }}', b: '{{ metadata.a }}' } })).toThrow(/cycle/i);
  });
});

describe('validatePipelineProps', () => {
  it('checks the real metadata layers, not a top-level `metadata`', () => {
    for (const props of [
      { project: 'app', global: { r: '{{ nope.x }}' } },
      { project: 'app', defaults: { metadata: { r: '{{ nope.x }}' } } },
      { project: 'app', synth: { metadata: { r: '{{ nope.x }}' } } },
      { project: '{{ nope.x }}' },
    ]) {
      expect(validatePipelineProps(props).map((e) => e.code)).toEqual([ErrorCode.TEMPLATE_UNKNOWN_PATH]);
    }
    expect(validatePipelineProps({ project: 'app', metadata: { r: '{{ nope.x }}' }, projectName: '{{ nope.x }}' })).toEqual([]);
  });

  it('reports a cycle across layers', () => {
    const errors = validatePipelineProps({ project: 'app', global: { a: '{{ metadata.b }}' }, synth: { metadata: { b: '{{ metadata.a }}' } } });
    expect(errors.map((e) => e.code)).toEqual([ErrorCode.TEMPLATE_CYCLE]);
  });

  it('refuses a `{{ … }}` in a synth.source field other than token — it would reach CodePipeline as literal text', () => {
    const errors = validatePipelineProps({
      project: 'app',
      synth: { source: { type: 'github', options: { repo: '{{ vars.repo }}', token: 'secretsmanager:pb/{{ pipeline.vars.orgId }}/t' } } },
      vars: { repo: 'acme/app' },
    });
    expect(errors).toEqual([expect.objectContaining({ field: 'synth.source.options.repo', code: ErrorCode.TEMPLATE_VALIDATION_FAILED })]);
  });

  it('a TEMPLATE may parameterize synth.source with {{ vars.* }} only (instantiate bakes it)', () => {
    const ok = { project: 'app', synth: { source: { type: 'github', options: { repo: '{{ vars.repo }}', branch: '{{ vars.branch | default: "main" }}' } } } };
    expect(validatePipelineProps(ok, { template: true })).toEqual([]);
    const bad = { project: 'app', synth: { source: { type: 'github', options: { repo: '{{ metadata.repo }}', branch: '{{ vars.b' } } } };
    expect(validatePipelineProps(bad, { template: true }).map((e) => [e.field, e.code])).toEqual([
      ['synth.source.options.branch', ErrorCode.TEMPLATE_PARSE_ERROR],
      ['synth.source.options.repo', ErrorCode.TEMPLATE_UNKNOWN_PATH],
    ]);
  });
});

describe('bakeSourceTemplates', () => {
  it('bakes `{{ vars.* }}` into every synth.source field except token, without mutating the input', () => {
    const props = {
      project: 'app',
      synth: { source: { type: 'codestar', options: { repo: '{{ vars.repo }}', branch: '{{ vars.branch | default: "main" }}', token: 'x/{{ pipeline.vars.orgId }}' } } },
    };
    const out = bakeSourceTemplates(props, { repo: 'acme/shop' });
    expect(out.synth.source.options).toEqual({ repo: 'acme/shop', branch: 'main', token: 'x/{{ pipeline.vars.orgId }}' });
    expect(props.synth.source.options.repo).toBe('{{ vars.repo }}');
  });

  it('throws when a source template names a var that has no value', () => {
    expect(() => bakeSourceTemplates({ synth: { source: { type: 'github', options: { repo: '{{ vars.repo }}' } } } }, {}))
      .toThrow(/synth\.source\.options\.repo/);
  });

  it('is a no-op without a templated source', () => {
    const props = { synth: { source: { type: 'github', options: { repo: 'acme/app' } } } };
    expect(bakeSourceTemplates(props, {})).toEqual(props);
    expect(bakeSourceTemplates({ project: 'x' }, {})).toEqual({ project: 'x' });
  });
});
