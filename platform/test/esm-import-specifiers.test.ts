// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every dynamic `import()` in platform/src must use a LITERAL relative specifier
 * ending in `.js` (or a bare package name).
 *
 * The service runs as native Node ESM, which never adds extensions. An
 * extensionless or computed specifier (`const p = './x'; await import(p)`)
 * throws ERR_MODULE_NOT_FOUND at runtime — but jest's moduleNameMapper strips
 * `.js` and resolves it anyway, so no unit test can catch it. That exact bug
 * turned every cross-org authorization check into a 500 in production.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { describe, it, expect } from '@jest/globals';

const SRC = join(process.cwd(), 'src');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.d.ts') ? [full] : [];
  });
}

describe('dynamic import specifiers', () => {
  it('are literal, and relative ones end in .js', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      // `import(` in code, not the `typeof import(...)` type position.
      for (const m of text.matchAll(/(?<!typeof\s)\bimport\(\s*([^)]*?)\s*\)/g)) {
        const spec = m[1];
        const line = text.slice(0, m.index).split('\n').length;
        const where = `${relative(process.cwd(), file)}:${line} import(${spec})`;
        const literal = /^(['"`])([^'"`]*)\1$/.exec(spec);
        if (!literal) { offenders.push(`${where} — computed specifier`); continue; }
        const path = literal[2];
        if (path.startsWith('.') && !path.endsWith('.js')) offenders.push(`${where} — relative without .js`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
