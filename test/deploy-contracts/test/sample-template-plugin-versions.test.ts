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
 *
 * The MANAGED toolchain (`cdk-synth`, `pipeline-bootstrap`) is the exception:
 * it is never pinned per step — the pipeline service refuses a managed
 * `cdk-synth` carrying its own version (TOOLCHAIN_PIN_VIA_RELEASE), and a
 * template never carries the pipeline's `toolchain.release` either (D12) — so a
 * template references it unpinned and follows the org / platform default
 * (docs/plans/bootstrap-image-versioning.md §5).
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from '@jest/globals';
import { REPO_ROOT, read } from '../src/index.js';

const TEMPLATES_DIR = 'deploy/samples/templates';

/** The managed toolchain names: never pinned per step. */
const MANAGED = new Set(['cdk-synth', 'pipeline-bootstrap']);

/** name -> version, from every deploy/plugins/<category>/<name>/plugin-spec.yaml. */
function catalogueVersions(): Map<string, string> {
  const out = new Map<string, string>();
  const record = (spec: string) => {
    const name = /^name:\s*(\S+)/m.exec(spec)?.[1];
    const version = /^version:\s*(\S+)/m.exec(spec)?.[1];
    if (name && version) out.set(name, version);
  };
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
      record(spec);
    }
  }
  return out;
}

/**
 * Every reference to a managed toolchain name (`plugin.name` or `filter.name`),
 * with the version it pins (if any) and whether the template carries a
 * top-level `toolchain` pin.
 */
function managedReferences(node: unknown, path = ''): Array<{ path: string; name: string; version?: unknown; id?: unknown }> {
  if (Array.isArray(node)) return node.flatMap((v, i) => managedReferences(v, `${path}[${i}]`));
  if (!node || typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  const found: Array<{ path: string; name: string; version?: unknown; id?: unknown }> = [];
  const filter = (obj.filter && typeof obj.filter === 'object' ? obj.filter : {}) as Record<string, unknown>;
  const name = typeof filter.name === 'string' ? filter.name : typeof obj.name === 'string' && 'filter' in obj ? obj.name : undefined;
  if (name && MANAGED.has(name)) found.push({ path, name, version: filter.version, id: filter.id });
  for (const [k, v] of Object.entries(obj)) found.push(...managedReferences(v, `${path}.${k}`));
  return found;
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
    // The managed toolchain lives in deploy/toolchain/, outside the catalogue.
    for (const name of MANAGED) expect(catalogue.has(name)).toBe(false);
  });

  it.each(templates)('%s references the managed toolchain unpinned', (template) => {
    const parsed = JSON.parse(read(`${TEMPLATES_DIR}/${template}/template.json`)) as Record<string, unknown>;
    const refs = managedReferences(parsed);
    expect(refs.map((r) => r.name)).toContain('cdk-synth');
    expect(refs.filter((r) => r.version !== undefined || r.id !== undefined)).toEqual([]);
    // No `toolchain` pin anywhere in the template's props (D12).
    const props = (parsed.props ?? parsed) as Record<string, unknown>;
    expect(props).not.toHaveProperty('toolchain');
  });

  it.each(templates)('%s pins the catalogue versions', (template) => {
    const pins = pinnedPlugins(JSON.parse(read(`${TEMPLATES_DIR}/${template}/template.json`)));
    expect(pins.length).toBeGreaterThan(0);
    const wrong = pins
      .filter((p) => catalogue.get(p.name) !== p.version)
      .map((p) => `${p.path}: ${p.name}@${p.version} — the catalogue ships ${catalogue.get(p.name) ?? 'no such plugin'}`);
    expect(wrong).toEqual([]);
  });
});
