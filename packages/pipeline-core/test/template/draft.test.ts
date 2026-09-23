// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import {
  formatTemplateDraftProblems,
  validateTemplateDraft,
  type TemplateDraftProblemKind,
} from '../../src/template/draft.js';

const kinds = (draft: Parameters<typeof validateTemplateDraft>[0]): TemplateDraftProblemKind[] =>
  validateTemplateDraft(draft).problems.map((p) => p.kind);

describe('validateTemplateDraft — a well-formed draft', () => {
  const draft = {
    props: {
      project: '{{ vars.PROJECT }}',
      global: { env: '{{ vars.STAGE }}' },
      vars: { PROJECT: 'demo' },
      synth: { source: { repo: 'https://example.com/{{ vars.REPO }}.git' } },
    },
    inputs: [{ name: 'STAGE' }, { name: 'REPO' }],
  };

  it('passes and reports what it saw', () => {
    const result = validateTemplateDraft(draft);
    expect(result.problems).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.referencedVariables).toEqual(['PROJECT', 'REPO', 'STAGE']);
    expect(result.declaredInputs).toEqual(['STAGE', 'REPO']);
  });

  it('accepts a body with no templates at all', () => {
    expect(validateTemplateDraft({ props: { project: 'demo' } })).toEqual({
      valid: true, problems: [], referencedVariables: [], declaredInputs: [],
    });
  });

  it('accepts metadata self-reference through any layer', () => {
    expect(kinds({
      props: {
        global: { region: 'us-east-1' },
        defaults: { metadata: { bucket: 'b-{{ metadata.region }}' } },
        synth: { metadata: { tag: '{{ metadata.bucket }}' } },
      },
    })).toEqual([]);
  });
});

describe('validateTemplateDraft — the draft cannot be created', () => {
  it('rejects a body that is not an object', () => {
    for (const props of [undefined, null, 'x', ['a']]) {
      const result = validateTemplateDraft({ props });
      expect(result.valid).toBe(false);
      expect(result.problems.map((p) => p.kind)).toEqual(['invalid-props']);
      expect(result.referencedVariables).toEqual([]);
      expect(result.declaredInputs).toEqual([]);
    }
  });

  it('reports a malformed expression with its position, and skips cycle detection', () => {
    const result = validateTemplateDraft({ props: { project: '{{ vars.A', global: { a: '{{ metadata.b }}' }, defaults: { metadata: { b: '{{ metadata.a }}' } } } });
    expect(result.valid).toBe(false);
    expect(result.problems.map((p) => p.kind)).toEqual(['parse']);
    expect(result.problems[0]).toMatchObject({ field: 'project', line: 1, col: 10 });
    expect(result.problems[0]!.message).toContain("Expected '}}'");
  });

  it('reports the reserved secrets scope wherever it appears', () => {
    const result = validateTemplateDraft({ props: { synth: { image: '{{ secrets.REGISTRY_TOKEN }}' } } });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ kind: 'reserved-scope', field: 'synth.image', path: 'secrets.REGISTRY_TOKEN' });
    expect(result.valid).toBe(false);
  });

  it('rejects an unknown scope root in a self-referencing field', () => {
    const result = validateTemplateDraft({ props: { global: { who: '{{ pipeline.orgId }}' } } });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ kind: 'unknown-scope', field: 'global.who', path: 'pipeline.orgId' });
  });

  it('leaves a non-self-referencing field free to use other roots', () => {
    expect(kinds({ props: { synth: { source: { url: '{{ pipeline.orgId }}' } } } })).toEqual([]);
  });

  it('detects a reference cycle', () => {
    const result = validateTemplateDraft({
      props: { global: { a: '{{ metadata.b }}', b: '{{ metadata.a }}' } },
    });
    expect(result.valid).toBe(false);
    const cycle = result.problems.find((p) => p.kind === 'cycle');
    expect(cycle).toBeDefined();
    expect(cycle!.cycle).toEqual(expect.arrayContaining(['metadata.a', 'metadata.b']));
    expect(cycle!.message).toContain('cycle');
  });

  it('detects a self-referencing var', () => {
    expect(kinds({ props: { vars: { A: '{{ vars.A }}' } } })).toContain('cycle');
  });
});

describe('validateTemplateDraft — the vars contract', () => {
  it('flags a referenced variable that no input declares', () => {
    const result = validateTemplateDraft({ props: { project: '{{ vars.REGION }}' }, inputs: [] });
    expect(result.valid).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ kind: 'undeclared-variable', variable: 'REGION' });
    expect(result.problems[0]!.message).toContain('vars.REGION');
  });

  it('accepts a variable supplied by a default already in props.vars', () => {
    expect(kinds({ props: { project: '{{ vars.REGION }}', vars: { REGION: 'us-east-1' } } })).toEqual([]);
  });

  it('treats a missing inputs list the same as an empty one', () => {
    expect(kinds({ props: { project: '{{ vars.REGION }}' } })).toEqual(['undeclared-variable']);
    expect(kinds({ props: { project: '{{ vars.REGION }}' }, inputs: null })).toEqual(['undeclared-variable']);
  });

  it('warns — but does not fail — on an input nothing references', () => {
    const result = validateTemplateDraft({ props: { project: 'demo' }, inputs: [{ name: 'UNUSED' }] });
    expect(result.valid).toBe(true);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ kind: 'unused-input', severity: 'warning', variable: 'UNUSED' });
  });

  it('rejects an input name the grammar cannot express', () => {
    const result = validateTemplateDraft({ props: {}, inputs: [{ name: 'my-var' }, { name: '' }, { name: 7 }, {}] });
    expect(result.problems.map((p) => p.kind)).toEqual(
      ['invalid-input-name', 'invalid-input-name', 'invalid-input-name', 'invalid-input-name'],
    );
    expect(result.problems[0]).toMatchObject({ variable: 'my-var' });
    expect(result.problems[2]!.variable).toBeUndefined();
    expect(result.declaredInputs).toEqual([]);
  });

  it('rejects a duplicated input', () => {
    const result = validateTemplateDraft({ props: { project: '{{ vars.A }}' }, inputs: [{ name: 'A' }, { name: 'A' }] });
    expect(result.problems.map((p) => p.kind)).toEqual(['duplicate-input']);
    expect(result.declaredInputs).toEqual(['A']);
  });

  it('collects a variable referenced from an array element', () => {
    const result = validateTemplateDraft({ props: { steps: [{ run: 'echo {{ vars.MSG }}' }] }, inputs: [{ name: 'MSG' }] });
    expect(result.problems).toEqual([]);
    expect(result.referencedVariables).toEqual(['MSG']);
  });

  it('ignores a bare {{ vars }} with no variable name', () => {
    const result = validateTemplateDraft({ props: { project: '{{ vars }}' } });
    expect(result.referencedVariables).toEqual([]);
    expect(result.problems.map((p) => p.kind)).toEqual([]);
  });
});

describe('formatTemplateDraftProblems', () => {
  it('renders field, position and message', () => {
    const problems = validateTemplateDraft({ props: { project: '{{ vars.A', global: { b: '{{ pipeline.x }}' } } }).problems;
    const lines = formatTemplateDraftProblems(problems);
    expect(lines[0]).toMatch(/^\[project:1:10\] /);
    expect(lines.some((l) => l.startsWith('[global.b:1:1] '))).toBe(true);
  });

  it('falls back to the kind when a problem names no field', () => {
    const problems = validateTemplateDraft({ props: { project: '{{ vars.A }}' } }).problems;
    expect(formatTemplateDraftProblems(problems)).toEqual([
      "[undeclared-variable] Template references {{ vars.A }} but declares no input named 'A'",
    ]);
  });

  it('renders nothing for a clean draft', () => {
    expect(formatTemplateDraftProblems([])).toEqual([]);
  });
});
