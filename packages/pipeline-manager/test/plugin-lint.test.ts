// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Equivalence check for api-core's port of test-plugins.sh's static checks
 * (plugin-ecosystem W6): the whole Official catalog, which test-plugins.sh
 * passes, passes the shared lint too. The per-rule tests live with the lint in
 * api-core (test/plugin-lint.test.ts).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from '@jest/globals';
import { lintPluginDockerfile, lintPluginSpec } from '@pipeline-builder/api-core';
import YAML from 'yaml';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('the Official catalog passes the CLI lint (equivalence with test-plugins.sh)', () => {
  const root = path.join(REPO, 'deploy/plugins');
  const plugins = fs.readdirSync(root)
    .filter(c => !c.startsWith('_') && fs.statSync(path.join(root, c)).isDirectory())
    .flatMap(c => fs.readdirSync(path.join(root, c)).map(p => path.join(root, c, p)))
    .filter(d => fs.existsSync(path.join(d, 'plugin-spec.yaml')));

  it('covers the catalog', () => {
    expect(plugins.length).toBeGreaterThan(100);
  });

  it.each(plugins.map(p => [path.relative(root, p), p]))('%s', (_rel, dir) => {
    const specText = fs.readFileSync(path.join(dir, 'plugin-spec.yaml'), 'utf-8');
    const found = lintPluginSpec(YAML.parse(specText) as Record<string, unknown>, specText).filter(f => f.level === 'error');
    const dockerfile = path.join(dir, 'Dockerfile');
    if (fs.existsSync(dockerfile)) found.push(...lintPluginDockerfile(fs.readFileSync(dockerfile, 'utf-8')).filter(f => f.level === 'error'));
    expect(found).toEqual([]);
  });
});
