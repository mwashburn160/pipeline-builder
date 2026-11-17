// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * WCAG AA contrast for the theme tokens, read straight out of globals.css.
 *
 * Every pair below is text the app actually renders at small sizes — link text
 * (`.action-link`, `text-brand`), danger text, and the white label on a filled
 * button — on each surface it lands on, in both themes. The floor is 4.5:1
 * (WCAG 1.4.3, normal text). A token edit that drops any pair under it fails
 * here instead of in an accessibility audit.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(__dirname, '../src/styles/globals.css'), 'utf8');

/** The `--pb-*` declarations of the first block opened by `selector {`. */
function tokens(selector: string): Record<string, string> {
  const start = css.search(new RegExp(`^\\s*${selector.replace('.', '\\.')}\\s*\\{`, 'm'));
  if (start < 0) throw new Error(`no ${selector} block in globals.css`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--pb-[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const light = tokens(':root');
const dark = { ...light, ...tokens('.dark') };

function resolve(theme: Record<string, string>, value: string, depth = 0): string {
  const v = /^var\((--pb-[\w-]+)\)$/.exec(value);
  if (!v) return value;
  if (depth > 5 || !(v[1] in theme)) throw new Error(`unresolvable ${value}`);
  return resolve(theme, theme[v[1]], depth + 1);
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ['--pb-bg', '--pb-surface', '--pb-surface-muted'];
/** [foreground, backgrounds] — tokens, or a literal colour. */
const PAIRS: Array<[string, string[]]> = [
  // Link / brand text (.action-link, .btn-link, text-brand) and its hover.
  ['--pb-brand', SURFACES],
  ['--pb-brand-strong', SURFACES],
  // Danger text (text-danger, .btn-danger-outline, .action-link-danger), also on its alert tint.
  ['--pb-danger-fg', [...SURFACES]],
  ['--pb-danger-fg-strong', [...SURFACES]],
  ['--pb-text-subtle', SURFACES],
  ['--pb-text-muted', SURFACES],
  // White labels on filled buttons (.btn-primary + hover, .btn-danger, .btn-success).
  ['#ffffff', ['--pb-brand-solid', '--pb-brand-solid-strong', '--pb-danger', '--pb-success']],
];

describe.each([['light', light], ['dark', dark]] as const)('%s theme', (_name, theme) => {
  const cases = PAIRS.flatMap(([fg, bgs]) => bgs.map((bg) => [fg, bg] as const));
  it.each(cases)('%s on %s meets 4.5:1', (fg, bg) => {
    const f = fg.startsWith('--') ? resolve(theme, theme[fg] ?? '') : fg;
    const b = bg.startsWith('--') ? resolve(theme, theme[bg] ?? '') : bg;
    expect(contrast(f, b)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('danger text on its alert tint (light theme, opaque tint)', () => {
  it('meets 4.5:1', () => {
    expect(contrast(resolve(light, light['--pb-danger-fg']), light['--pb-danger-bg'])).toBeGreaterThanOrEqual(4.5);
  });
});

describe('contrast()', () => {
  it('matches the WCAG reference values', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // The value this suite was written against: the old brand blue on white.
    expect(contrast('#0f6fff', '#ffffff')).toBeCloseTo(4.43, 2);
  });
});
