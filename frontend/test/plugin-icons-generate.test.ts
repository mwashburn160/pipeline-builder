// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/generate-plugin-icons.mjs`: copies curated SVGs to content-hashed
 * public files, emits the key → { url, hex, name } manifest, refuses anything
 * scriptable — and the checked-in manifest matches what the current
 * `deploy/plugins/_icons/` would generate (run the script after changing icons).
 */
import { describe, it, expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const FRONTEND = resolve(__dirname, '..');
const SCRIPT = join(FRONTEND, 'scripts', 'generate-plugin-icons.mjs');

function run(src: string) {
  const out = mkdtempSync(join(tmpdir(), 'pb-icons-out-'));
  const manifest = join(out, 'plugin-icons.ts');
  const publicDir = join(out, 'public');
  const env = { ...process.env, PLUGIN_ICONS_SRC: src, PLUGIN_ICONS_PUBLIC_DIR: publicDir, PLUGIN_ICONS_MANIFEST: manifest };
  execFileSync(process.execPath, [SCRIPT], { env, stdio: 'pipe' });
  return { manifest: readFileSync(manifest, 'utf8'), files: readdirSync(publicDir).sort() };
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';

describe('generate-plugin-icons', () => {
  it('hashes file names and records brand colour and name from SOURCES.md', () => {
    const src = mkdtempSync(join(tmpdir(), 'pb-icons-src-'));
    writeFileSync(join(src, 'trivy.svg'), SVG);
    writeFileSync(join(src, 'github.svg'), SVG.replace('M0', 'M1'));
    writeFileSync(join(src, 'SOURCES.md'), [
      '| Key | Name | Hex | Source | Licence | Date |',
      '|---|---|---|---|---|---|',
      '| `trivy` | Trivy | #1904DA | Simple Icons | CC0 | 2026-09-21 |',
      '| github | GitHub | 181717 | Simple Icons | CC0 | 2026-09-21 |',
    ].join('\n'));
    const { manifest, files } = run(src);
    expect(files).toHaveLength(2);
    expect(files.every((f) => /^[a-z0-9-]+\.[0-9a-f]{10}\.svg$/.test(f))).toBe(true);
    expect(manifest).toMatch(/"trivy": \{ url: "\/plugin-icons\/trivy\.[0-9a-f]{10}\.svg", hex: "#1904da", name: "Trivy" \}/);
    expect(manifest).toMatch(/"github": \{ url: "\/plugin-icons\/github\.[0-9a-f]{10}\.svg", hex: "#181717", name: "GitHub" \}/);
  });

  it('is empty (not an error) when there is no icon directory', () => {
    const { manifest, files } = run(join(tmpdir(), 'pb-icons-does-not-exist'));
    expect(files).toEqual([]);
    expect(manifest).toContain('PLUGIN_ICONS: Readonly<Record<string, PluginIconAsset>> = {\n};');
  });

  it.each([
    ['script', '<svg><script>alert(1)</script></svg>'],
    ['event handler', '<svg onload="alert(1)"></svg>'],
    ['foreignObject', '<svg><foreignObject><div/></foreignObject></svg>'],
    ['external href', '<svg><image href="https://evil.example/x.png"/></svg>'],
  ])('refuses an SVG with %s', (_label, body) => {
    const src = mkdtempSync(join(tmpdir(), 'pb-icons-bad-'));
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'bad.svg'), body);
    expect(() => run(src)).toThrow();
  });

  it('the checked-in manifest is current', () => {
    const { manifest } = run(resolve(FRONTEND, '..', 'deploy', 'plugins', '_icons'));
    const committed = readFileSync(join(FRONTEND, 'src', 'generated', 'plugin-icons.ts'), 'utf8');
    expect({ committed, fix: 'run `node scripts/generate-plugin-icons.mjs` in frontend/' })
      .toEqual({ committed: manifest, fix: expect.any(String) });
  });
});
