// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The committed curated icon set (`deploy/plugins/_icons/`):
 * every Official spec's `icon` key and badge resolves to a file, every file has a
 * `SOURCES.md` row (and vice versa), every SVG passes the lint, and every spec's
 * category has a glyph. Specs without a key must say why (`# icon: none — …`).
 */
import { describe, it, expect } from '@jest/globals';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isPluginCategory } from '../src/lib/plugin-categories';
import { CATEGORY_ICONS } from '../src/lib/plugin-category-icons';
import { PLUGIN_ICONS } from '../src/generated/plugin-icons';

const PLUGINS = resolve(__dirname, '..', '..', 'deploy', 'plugins');
const ICONS = join(PLUGINS, '_icons');
const KEY_RE = /^[a-z0-9-]+$/;

interface Spec { path: string; text: string }

function specs(): Spec[] {
  const out: Spec[] = [];
  for (const cat of readdirSync(PLUGINS, { withFileTypes: true })) {
    if (!cat.isDirectory() || cat.name.startsWith('_')) continue;
    for (const p of readdirSync(join(PLUGINS, cat.name), { withFileTypes: true })) {
      const file = join(PLUGINS, cat.name, p.name, 'plugin-spec.yaml');
      if (p.isDirectory() && existsSync(file)) out.push({ path: `${cat.name}/${p.name}`, text: readFileSync(file, 'utf8') });
    }
  }
  return out;
}

/** `icon: trivy` → ['trivy']; `icon: { key: snyk, badge: python }` → ['snyk', 'python']; comment form → []. */
function iconKeys(text: string): string[] | null {
  const line = /^icon:\s*(.+?)\s*$/m.exec(text);
  if (!line) return null;
  const v = line[1];
  const obj = /^\{\s*key:\s*([^,\s}]+)\s*(?:,\s*badge:\s*([^,\s}]+)\s*)?\}$/.exec(v);
  return obj ? [obj[1], obj[2]].filter((k): k is string => !!k) : [v];
}

const svgFiles = readdirSync(ICONS).filter((f) => f.endsWith('.svg')).sort();
const svgKeys = svgFiles.map((f) => f.slice(0, -4));

/** Keys of the icon table rows in SOURCES.md (the key cell is backticked; the no-icon table uses plugin paths). */
function sourceRows(): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of readFileSync(join(ICONS, 'SOURCES.md'), 'utf8').split('\n')) {
    const m = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (m) rows.set(m[1], line);
  }
  return rows;
}

describe('curated plugin icon set', () => {
  const all = specs();

  it('finds the plugin specs', () => {
    expect(all.length).toBeGreaterThan(100);
  });

  it('every spec has an icon key or an explained `# icon: none` comment', () => {
    const bad = all.filter((s) => iconKeys(s.text) === null && !/^# icon: none — \S.*\(monogram; see _icons\/SOURCES\.md\)$/m.test(s.text));
    expect(bad.map((s) => s.path)).toEqual([]);
  });

  it('every icon key and badge resolves to a file in _icons/', () => {
    const missing: string[] = [];
    for (const s of all) {
      for (const key of iconKeys(s.text) ?? []) {
        if (!KEY_RE.test(key) || !existsSync(join(ICONS, `${key}.svg`))) missing.push(`${s.path}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every icon file is used by at least one spec', () => {
    const used = new Set(all.flatMap((s) => iconKeys(s.text) ?? []));
    expect(svgKeys.filter((k) => !used.has(k))).toEqual([]);
  });

  it('every file has a SOURCES.md row with a brand hex, and every row has a file', () => {
    const rows = sourceRows();
    expect([...rows.keys()].sort()).toEqual(svgKeys);
    for (const [key, row] of rows) {
      expect({ key, hex: /#[0-9A-Fa-f]{6}\b/.test(row) }).toEqual({ key, hex: true });
      expect({ key, dated: /\d{4}-\d{2}-\d{2}/.test(row) }).toEqual({ key, dated: true });
    }
  });

  it('every no-icon spec is listed in the SOURCES.md no-icon table', () => {
    const md = readFileSync(join(ICONS, 'SOURCES.md'), 'utf8');
    const unlisted = all
      .filter((s) => iconKeys(s.text) === null)
      .filter((s) => !md.includes(`| ${s.path} |`));
    expect(unlisted.map((s) => s.path)).toEqual([]);
  });

  it('every SVG passes the lint', () => {
    const problems: string[] = [];
    for (const f of svgFiles) {
      const t = readFileSync(join(ICONS, f), 'utf8');
      if (!/^<svg\b/.test(t.trimStart())) problems.push(`${f}: not an SVG document`);
      if (/<script\b/i.test(t)) problems.push(`${f}: <script>`);
      if (/\son[a-z]+\s*=/i.test(t)) problems.push(`${f}: event handler`);
      if (/<foreignObject\b/i.test(t)) problems.push(`${f}: <foreignObject>`);
      if (/xlink:/i.test(t)) problems.push(`${f}: xlink`);
      if (/href\s*=\s*["']\s*(?!#)/i.test(t)) problems.push(`${f}: external href`);
      if (/url\(\s*["']?\s*(?!#)[a-z]+:/i.test(t)) problems.push(`${f}: external url()`);
      if (/<!ENTITY|<!DOCTYPE/i.test(t)) problems.push(`${f}: DTD/entity`);
      if ((t.match(/\sviewBox\s*=/g) ?? []).length !== 1) problems.push(`${f}: needs exactly one viewBox`);
    }
    expect(problems).toEqual([]);
  });

  it('the generated manifest covers the whole set with a brand colour', () => {
    expect(Object.keys(PLUGIN_ICONS).sort()).toEqual(svgKeys);
    for (const key of svgKeys) expect({ key, hex: PLUGIN_ICONS[key].hex }).toEqual({ key, hex: expect.stringMatching(/^#[0-9a-f]{6}$/) });
  });

  it('every spec category has a glyph', () => {
    const cats = new Set(all.map((s) => /^category:\s*(\S+)/m.exec(s.text)?.[1]));
    for (const c of cats) {
      expect({ c, known: isPluginCategory(c) }).toEqual({ c, known: true });
      if (isPluginCategory(c)) expect(CATEGORY_ICONS[c]).toBeTruthy();
    }
  });
});
