// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * pb_sync_env_keys (deploy/bin/gen-env-secrets.sh) appends keys that are new in
 * .env.example to an EXISTING .env. An .env whose last line has no trailing
 * newline (a hand edit, an editor that strips it) used to have the first
 * appended key glued onto that line. When the last line is a comment, the key
 * silently becomes part of the comment:
 *
 *   # ... see docker-build.ts for details.POSTGRES_RUNG_ENABLED=true
 *
 * The key then looks present to a human and absent to everything that reads
 * the file, which is how POSTGRES_RUNG_ENABLED went missing on an eks install.
 */

import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';
import { REPO_ROOT } from '../src/index.js';

const SCRIPT = join(REPO_ROOT, 'deploy/bin/gen-env-secrets.sh');

function sync(envBody: string, exampleBody: string): { status: number | null; env: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pb-env-sync-'));
  try {
    const env = join(dir, '.env');
    const example = join(dir, '.env.example');
    writeFileSync(env, envBody);
    writeFileSync(example, exampleBody);
    const r = spawnSync('bash', ['-c', `. "${SCRIPT}"; pb_sync_env_keys "${env}" "${example}"`], {
      encoding: 'utf-8',
    });
    return { status: r.status, env: readFileSync(env, 'utf-8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('pb_sync_env_keys — appending to an .env without a trailing newline', () => {
  const EXAMPLE = 'OLD_KEY=1\nNEW_KEY=true\nOTHER_KEY=2\n';

  it('does not glue the first new key onto a final comment line', () => {
    const { status, env } = sync('OLD_KEY=1\n# a closing comment', EXAMPLE);
    expect(status).toBe(0);
    expect(env).toBe('OLD_KEY=1\n# a closing comment\nNEW_KEY=true\nOTHER_KEY=2\n');
    expect(env.split('\n')).toContain('NEW_KEY=true');
  });

  it('does not glue the first new key onto a final assignment', () => {
    const { env } = sync('OLD_KEY=1', EXAMPLE);
    expect(env).toBe('OLD_KEY=1\nNEW_KEY=true\nOTHER_KEY=2\n');
  });

  it('adds no blank line when the file already ends with a newline', () => {
    const { env } = sync('OLD_KEY=1\n', EXAMPLE);
    expect(env).toBe('OLD_KEY=1\nNEW_KEY=true\nOTHER_KEY=2\n');
  });

  it('leaves the file byte-for-byte alone when there is nothing to add', () => {
    const body = 'OLD_KEY=1\nNEW_KEY=true\n# no trailing newline';
    const { env } = sync(body, EXAMPLE.replace('OTHER_KEY=2\n', ''));
    expect(env).toBe(body);
  });
});
