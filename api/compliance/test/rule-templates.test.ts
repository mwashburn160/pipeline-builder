// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { RULE_TEMPLATES, type RuleTemplate } from '../src/data/rule-templates';

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
