// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every `<label>` names a control: it either wraps one (implicit association)
 * or points at one with `htmlFor`. ~60 labels sat above their inputs with
 * neither, so a screen reader announced every such field as unlabelled and a
 * click on the text focused nothing.
 *
 * This is the static stand-in for eslint-plugin-jsx-a11y's
 * `label-has-associated-control` — the frontend has no ESLint setup to hang the
 * rule on. A caption over something that is NOT a form control (a group of
 * inputs, a read-only value, a preview) is a `<span>` with an id the container
 * references via `aria-labelledby`, not a `<label>`.
 */

import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const CONTROL = /<(input|Input|Checkbox|Switch|select|Select|textarea|Textarea|FilterInput|FilterSelect|SearchInput)\b/;

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

function unassociatedLabels(): string[] {
  const out: string[] = [];
  for (const file of [...tsxFiles(join(ROOT, 'src')), ...tsxFiles(join(ROOT, 'pages'))]) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/<label\b([^>]*)>/g)) {
      if (m[1].includes('htmlFor')) continue;
      const start = (m.index ?? 0) + m[0].length;
      const inner = src.slice(start, src.indexOf('</label>', start));
      if (CONTROL.test(inner)) continue;
      out.push(`${relative(ROOT, file)}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  return out;
}

describe('label association', () => {
  it('has no <label> that neither wraps a control nor names one with htmlFor', () => {
    expect(unassociatedLabels()).toEqual([]);
  });
});
