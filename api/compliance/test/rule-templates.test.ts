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

    const unknown = RULE_TEMPLATES
      // Dotted paths (`props.foo`) are resolved inside the row, so only the
      // first segment has to be a column.
      .filter((tpl) => !columns[tpl.target].has(tpl.field.split('.')[0]))
      .map((tpl) => `${tpl.id} → ${tpl.target}.${tpl.field}`);

    expect(unknown).toEqual([]);
  });
});
