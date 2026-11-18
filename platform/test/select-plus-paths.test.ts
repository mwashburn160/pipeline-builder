// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Guard: a `+path` in a `.select('…')` names a `select: false` schema path.
 *
 * Mongoose only understands `+path` for a path the schema HIDES. For any other
 * path the `+` is kept as part of the field name, so `select('+tokenVersion
 * issuedTokens')` projects `{ '+tokenVersion': 1, issuedTokens: 1 }` and the
 * document comes back WITHOUT `tokenVersion` — silently. That shape made
 * "revoke all" fail to mint its surviving session and made a password reset
 * reset `tokenVersion` to 1 instead of bumping it. This walks platform/src and
 * fails on any `+path` that no model hides.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { jest, describe, it, expect } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';

jest.unstable_mockModule('../src/config/index.js', () => mockConfig({
  auth: { passwordMinLength: 8, passwordSaltRounds: 4 },
  invitation: { expirationDays: 7 },
}));

const mongoose = (await import('mongoose')).default;
await import('../src/models/index.js');

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/** Every `select: false` path across the registered models. */
function hiddenPaths(): Set<string> {
  const hidden = new Set<string>();
  for (const name of mongoose.modelNames()) {
    mongoose.model(name).schema.eachPath((p, type) => {
      if ((type as { options?: { select?: unknown } }).options?.select === false) hidden.add(p);
    });
  }
  return hidden;
}

describe('.select() `+path` entries name hidden schema paths', () => {
  it('knows the hidden User paths (sanity)', () => {
    const hidden = hiddenPaths();
    expect(hidden.has('password')).toBe(true);
    expect(hidden.has('isSuperAdmin')).toBe(true);
    expect(hidden.has('tokenVersion')).toBe(false);
  });

  it('no source file selects `+path` for a path no model hides', () => {
    const hidden = hiddenPaths();
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const source = readFileSync(file, 'utf8');
      for (const m of source.matchAll(/\.select\(\s*(['"`])((?:(?!\1).)*)\1/g)) {
        for (const token of m[2]!.split(/\s+/)) {
          if (token.startsWith('+') && !hidden.has(token.slice(1))) {
            offenders.push(`${path.relative(SRC, file)}: ${token}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('mongoose keeps a `+` on a non-hidden path as a literal field name (why this guard exists)', () => {
    const User = mongoose.model('User');
    const q = User.findById(new mongoose.Types.ObjectId()).select('+tokenVersion issuedTokens') as unknown as {
      _applyPaths(): void; _fields: Record<string, number>;
    };
    q._applyPaths();
    expect(q._fields).toEqual({ '+tokenVersion': 1, 'issuedTokens': 1 });
  });
});
