// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A link inside a sentence is told apart from the words around it by more than
 * colour (WCAG 1.4.1, axe `link-in-text-block`): the shared `.text-link` style
 * underlines it at rest. The colour-only `text-brand hover:underline` pairing,
 * underlined only on hover, is gone from the app.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'generated' ? [] : sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('links in running text', () => {
  it('.text-link underlines at rest, in the brand colour', () => {
    const css = readFileSync(join(ROOT, 'src/styles/globals.css'), 'utf8');
    const rule = /\.text-link\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/color:\s*var\(--pb-brand\)/);
    expect(rule).toMatch(/\bunderline\b/);
  });

  it('no link is set apart from its sentence by colour alone', () => {
    const offenders = [...sources(join(ROOT, 'src')), ...sources(join(ROOT, 'pages'))]
      .filter((file) => /className="text-brand hover:underline"/.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });
});
