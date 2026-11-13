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
  // Both roots test-plugins.sh walks: the managed toolchain release
  // (deploy/toolchain/<name>) and the catalog (deploy/plugins/<category>/<name>).
  const root = path.join(REPO, 'deploy');
  const toolchain = path.join(root, 'toolchain');
  const catalog = path.join(root, 'plugins');
  const plugins = [
    ...fs.readdirSync(toolchain).map(p => path.join(toolchain, p)),
    ...fs.readdirSync(catalog)
      .filter(c => !c.startsWith('_') && fs.statSync(path.join(catalog, c)).isDirectory())
      .flatMap(c => fs.readdirSync(path.join(catalog, c)).map(p => path.join(catalog, c, p))),
  ]
    .filter(d => fs.existsSync(path.join(d, 'plugin-spec.yaml')))
    // test-plugins.sh skips a `pluginType: BuildImage` (pipeline-bootstrap): it is
    // the managed toolchain's build image, not a step plugin — no step fields, and
    // root by design. The deploy contracts and the build's base stage gate it.
    .filter(d => (YAML.parse(fs.readFileSync(path.join(d, 'plugin-spec.yaml'), 'utf-8')) as { pluginType?: string }).pluginType !== 'BuildImage');

  it('covers the catalog', () => {
    expect(plugins.length).toBeGreaterThan(100);
    // cdk-synth is linted; pipeline-bootstrap (BuildImage) is not.
    expect(plugins.filter(p => p.startsWith(toolchain + path.sep)).map(p => path.relative(root, p))).toEqual([path.join('toolchain', 'cdk-synth')]);
  });

  it.each(plugins.map(p => [path.relative(root, p), p]))('%s', (_rel, dir) => {
    const specText = fs.readFileSync(path.join(dir, 'plugin-spec.yaml'), 'utf-8');
    const found = lintPluginSpec(YAML.parse(specText) as Record<string, unknown>, specText).filter(f => f.level === 'error');
    const dockerfile = path.join(dir, 'Dockerfile');
    if (fs.existsSync(dockerfile)) found.push(...lintPluginDockerfile(fs.readFileSync(dockerfile, 'utf-8')).filter(f => f.level === 'error'));
    expect(found).toEqual([]);
  });
});
