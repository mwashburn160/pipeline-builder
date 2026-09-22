// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Layering guard: a controller never imports another controller. Logic two
 * controllers share lives in a helper or a service, so each controller stays an
 * HTTP surface over them and can be tested (and mocked) on its own. The
 * `controllers/index.ts` barrel is the one file allowed to re-export them.
 */

import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from '@jest/globals';

const CONTROLLERS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/controllers');

/** Static (`from '…'`) and dynamic (`import('…')`) module specifiers in `source`. */
function specifiers(source: string): string[] {
  const out: string[] = [];
  for (const re of [/\bfrom\s+'([^']+)'/g, /\bimport\(\s*'([^']+)'\s*\)/g]) {
    for (const m of source.matchAll(re)) out.push(m[1]);
  }
  return out;
}

/** Whether `spec`, imported from a file in src/controllers, names a controller module. */
function isControllerImport(spec: string): boolean {
  return /^\.\/[^/]+\.js$/.test(spec) || /(^|\/)controllers\//.test(spec);
}

describe('controller layering', () => {
  const files = readdirSync(CONTROLLERS_DIR).filter((f) => f.endsWith('.ts') && f !== 'index.ts');

  it('finds the controllers', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files)('%s imports no other controller', (file) => {
    const source = readFileSync(path.join(CONTROLLERS_DIR, file), 'utf8');
    expect(specifiers(source).filter(isControllerImport)).toEqual([]);
  });

  it('detects a controller import (self-check)', () => {
    expect(specifiers("import { x } from './saml.js';\nconst y = await import('../controllers/sso.js');")
      .filter(isControllerImport)).toEqual(['./saml.js', '../controllers/sso.js']);
    expect(isControllerImport('../helpers/org-idp-ops.js')).toBe(false);
  });
});
