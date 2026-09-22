// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Smoke test: every existing plugin-spec.yaml in deploy/plugins/ must pass
 * the template validator unchanged.
 *
 * This guards against regressions in phase 3's upload-time template
 * validator. If a plugin uses `{{ ... }}` tokens, the scope must be
 * allowed; if it doesn't, validation is a no-op.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from '@jest/globals';
import YAML from 'yaml';
import { validatePluginTemplates } from '../src/helpers/plugin-spec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS_ROOT = path.resolve(__dirname, '../../../deploy/plugins');

function findAllPlugins(): string[] {
  const out: string[] = [];
  if (!existsSync(PLUGINS_ROOT)) return out;
  for (const category of readdirSync(PLUGINS_ROOT, { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    const categoryDir = path.join(PLUGINS_ROOT, category.name);
    for (const plugin of readdirSync(categoryDir, { withFileTypes: true })) {
      if (!plugin.isDirectory()) continue;
      const specPath = path.join(categoryDir, plugin.name, 'plugin-spec.yaml');
      if (existsSync(specPath)) out.push(specPath);
    }
  }
  return out;
}

describe('plugin-spec smoke test: existing plugins must validate', () => {
  const specs = findAllPlugins();

  // Guard — fail loudly if the test accidentally points at an empty directory
  it(`finds at least 100 existing plugin specs (actual: ${specs.length})`, () => {
    expect(specs.length).toBeGreaterThanOrEqual(100);
  });

  it.each(specs.map(p => [path.relative(PLUGINS_ROOT, p), p]))(
    '%s — template validation passes',
    (_rel, specPath) => {
      const text = readFileSync(specPath, 'utf-8');
      const spec = YAML.parse(text);
      // Validator throws on failure; passing = no throw
      expect(() => validatePluginTemplates(spec)).not.toThrow();
    },
  );
});

describe('validatePluginTemplates (upload wrapper of api-core checkPluginTemplates)', () => {
  it('throws one ValidationError grouping every issue by kind', () => {
    const spec = YAML.parse([
      'name: bad', 'version: 1.0.0', 'pluginType: CodeBuildStep',
      'requiredVars: [n]',
      'commands:',
      '  - "echo {{ pipeline.metadata.env }} {{ pipeline.vars.n | number }} {{ bogus.x }}"',
    ].join('\n'));
    let message = '';
    try { validatePluginTemplates(spec); } catch (err) { message = (err as Error).message; }
    expect(message).toMatch(/^Template validation failed \(1\):\n {2}• \[commands\[0\]:1:\d+\] .*unknown scope root 'bogus'/);
    expect(message).toContain('Plugin spec uses template paths not declared in contract (1):\n  • pipeline.metadata.env is not declared');
    expect(message).toContain('Plugin spec has type mismatches between coercion filters and declared types (1):');
  });

  it('passes a declared, typed contract', () => {
    const spec = {
      name: 'ok',
      version: '1.0.0',
      commands: ['echo {{ pipeline.vars.n | number }} {{ pipeline.metadata.x | default: "a" }}'],
      requiredVars: ['n'],
      varsTypes: { n: 'number' },
    };
    expect(() => validatePluginTemplates(spec as never)).not.toThrow();
  });
});
