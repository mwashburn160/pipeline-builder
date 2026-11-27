// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A version-pinned PLUGIN_VULN_WAIVERS entry must name a version the catalogue
 * actually ships.
 *
 * Waivers match the plugin version EXACTLY (applyVulnWaivers), and every pin
 * refresh patch-bumps the catalogue. A pin left behind matches nothing: the
 * shipped `playwright@1.0.0:…:firefox` sat in every .env.example while the
 * catalogue moved to 1.0.2 and 1.0.3, so a fresh install's gate counted all of
 * playwright's bundled-Firefox Criticals and refused the build. Whoever bumps a
 * waived plugin must move its waiver in the same change; this fails until they do.
 */

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { ALL_TARGETS, REPO_ROOT, read } from '../src/index.js';

/** name → version of every catalogue plugin, from its plugin-spec.yaml. */
function catalogueVersions(): Map<string, string> {
  const versions = new Map<string, string>();
  const root = join(REPO_ROOT, 'deploy/plugins');
  for (const category of readdirSync(root)) {
    if (category.startsWith('_') || !existsSync(join(root, category)) || category.includes('.')) continue;
    for (const plugin of readdirSync(join(root, category))) {
      const rel = `deploy/plugins/${category}/${plugin}/plugin-spec.yaml`;
      if (!existsSync(join(REPO_ROOT, rel))) continue;
      const spec = read(rel);
      const name = /^name:\s*"?([^"\s]+)"?\s*$/m.exec(spec)?.[1];
      const version = /^version:\s*"?([^"\s]+)"?\s*$/m.exec(spec)?.[1];
      if (name && version) versions.set(name, version);
    }
  }
  return versions;
}

/** The `<plugin>@<version>` pins in one target's PLUGIN_VULN_WAIVERS. */
function pinnedEntries(target: string): Array<{ plugin: string; version: string; entry: string }> {
  const raw = /^PLUGIN_VULN_WAIVERS='([^']*)'$/m.exec(read(`${target}/.env.example`))?.[1] ?? '';
  return raw.split(';').map((e) => e.trim()).filter(Boolean).flatMap((entry) => {
    const m = /^([^@:]+)@([^:]+):/.exec(entry);
    return m ? [{ plugin: m[1]!, version: m[2]!, entry }] : [];
  });
}

const versions = catalogueVersions();

describe.each(ALL_TARGETS.map((t) => [t]))('%s PLUGIN_VULN_WAIVERS', (target) => {
  it('pins every per-plugin waiver to the version the catalogue ships', () => {
    const stale = pinnedEntries(target)
      .filter(({ plugin, version }) => versions.get(plugin) !== version)
      .map(({ plugin, version, entry }) => `${entry} (catalogue ships ${plugin}@${versions.get(plugin) ?? 'no such plugin'}, not ${version})`);
    expect(stale).toEqual([]);
  });
});

it('reads the catalogue (guards against a parser that silently finds nothing)', () => {
  expect(versions.get('playwright')).toMatch(/^\d+\.\d+\.\d+$/);
  expect(pinnedEntries('deploy/local/docker').length).toBeGreaterThan(0);
});
