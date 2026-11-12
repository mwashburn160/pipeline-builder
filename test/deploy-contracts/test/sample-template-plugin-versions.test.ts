// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every plugin a sample template pins must be the version the catalogue ships.
 *
 * A template step names its plugin by `filter: { name, version }`, and the
 * pipeline service resolves that against the PUBLISHED catalogue: a version
 * that was never loaded is refused at create time —
 *
 *   Pipeline does not meet the contract of 1 plugin step:
 *     • synth (BuildSynth): pipeline-builder/cdk-synth has no published version 1.0.0.
 *
 * A plugin's version moves whenever its image changes (versions are immutable
 * once listed), and nothing tied the templates to that: all seven still pinned
 * cdk-synth 1.0.0 after it went to 1.0.2, git-secrets 1.0.0 after 1.0.1 and
 * trivy 1.0.0 after 1.1.0 — so instantiating ANY sample template produced a
 * pipeline the platform refused. The catalogue loader publishes exactly the
 * version in each `plugin-spec.yaml`, so that file is the source of truth.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from '@jest/globals';
import { REPO_ROOT, read } from '../src/index.js';

const TEMPLATES_DIR = 'deploy/samples/templates';

/** name -> version, from every deploy/plugins/<category>/<name>/plugin-spec.yaml. */
function catalogueVersions(): Map<string, string> {
  const out = new Map<string, string>();
  const root = join(REPO_ROOT, 'deploy/plugins');
  for (const category of readdirSync(root, { withFileTypes: true })) {
    if (!category.isDirectory() || category.name.startsWith('_')) continue;
    for (const plugin of readdirSync(join(root, category.name), { withFileTypes: true })) {
      if (!plugin.isDirectory()) continue;
      let spec: string;
      try {
        spec = read(`deploy/plugins/${category.name}/${plugin.name}/plugin-spec.yaml`);
      } catch {
        continue;
      }
      const name = /^name:\s*(\S+)/m.exec(spec)?.[1];
      const version = /^version:\s*(\S+)/m.exec(spec)?.[1];
      if (name && version) out.set(name, version);
    }
  }
  return out;
}

/** Every `{ filter: { name, version } }` in a template, with where it sits. */
function pinnedPlugins(node: unknown, path = ''): Array<{ path: string; name: string; version: string }> {
  if (Array.isArray(node)) return node.flatMap((v, i) => pinnedPlugins(v, `${path}[${i}]`));
  if (!node || typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  const found: Array<{ path: string; name: string; version: string }> = [];
  const filter = obj.filter as Record<string, unknown> | undefined;
  if (filter && typeof filter.name === 'string' && typeof filter.version === 'string') {
    found.push({ path, name: filter.name, version: filter.version });
  }
  for (const [k, v] of Object.entries(obj)) found.push(...pinnedPlugins(v, `${path}.${k}`));
  return found;
}

const templates = readdirSync(join(REPO_ROOT, TEMPLATES_DIR), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

describe('sample templates pin the plugin versions the catalogue publishes', () => {
  const catalogue = catalogueVersions();

  it('finds the templates and the catalogue it checks them against', () => {
    expect(templates.length).toBeGreaterThan(0);
    expect(catalogue.size).toBeGreaterThan(100);
  });

  it.each(templates)('%s', (template) => {
    const pins = pinnedPlugins(JSON.parse(read(`${TEMPLATES_DIR}/${template}/template.json`)));
    expect(pins.length).toBeGreaterThan(0);
    const wrong = pins
      .filter((p) => catalogue.get(p.name) !== p.version)
      .map((p) => `${p.path}: ${p.name}@${p.version} — the catalogue ships ${catalogue.get(p.name) ?? 'no such plugin'}`);
    expect(wrong).toEqual([]);
  });
});
