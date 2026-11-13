// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * src/cli.ts `main()` argument handling, each case on a FRESH commander program
 * (jest isolates the module registry per test file, and `main` registers the
 * commands on commander's global `program`, so it can run once per module
 * instance): a known command runs, no command or an unknown one ends the
 * process non-zero instead of silently doing nothing.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

process.env.HOME = mkdtempSync(join(tmpdir(), 'pm-cli-main-'));
process.env.PLATFORM_TOKEN = 'test-token';

class ExitError extends Error {
  constructor(readonly code: number | undefined) { super(`__EXIT_${code}__`); }
}

const argv = process.argv;
const logged: string[] = [];

beforeEach(() => {
  logged.length = 0;
  jest.resetModules();
  for (const m of ['log', 'error', 'warn', 'info'] as const) {
    jest.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  }
  jest.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => { logged.push(String(s)); return true; });
  jest.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => { logged.push(String(s)); return true; });
  jest.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new ExitError(code); }) as never);
});
afterAll(() => { process.argv = argv; });

/** Run main() on a fresh module instance; the exit code it ended with, if any. */
async function runMain(args: string[], options: { quiet?: boolean; selfUpdate?: boolean } = { quiet: true }): Promise<number | undefined> {
  // argv[1] must be a real file that is NOT cli.ts, or the module's
  // "executed directly" check would run main() itself on import.
  const self = fileURLToPath(import.meta.url);
  process.argv = ['node', self];
  const { main } = await import('../src/cli.js');
  process.argv = ['node', self, ...args];
  try {
    main(options);
    return undefined;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

describe('main()', () => {
  it('runs a known command and returns normally', async () => {
    await expect(runMain(['completions', 'fish'])).resolves.toBeUndefined();
    expect(logged.join('\n')).toContain('complete -c pipeline-manager');
  });

  it('ends non-zero with help when no command is given', async () => {
    const code = await runMain([]);
    expect(code).not.toBe(undefined);
    expect(logged.join('\n')).toMatch(/Usage:|help/i);
  });

  it('ends non-zero on an unknown command', async () => {
    const code = await runMain(['definitely-not-a-command']);
    expect(code).toBeGreaterThan(0);
  });
});

describe('self-update needs no sign-in', () => {
  it('isSelfUpdate spots --upgrade / --upgrade-check in any form', async () => {
    const { isSelfUpdate } = await import('../src/cli.js');
    for (const a of [['--upgrade'], ['--upgrade', '4.4.22'], ['--upgrade=next'], ['--upgrade-check'], ['--upgrade-check=4.4.22']]) {
      expect(isSelfUpdate(a)).toBe(true);
    }
    expect(isSelfUpdate(['pipeline', 'list'])).toBe(false);
    expect(isSelfUpdate(['--upgrades'])).toBe(false);
  });

  it('runs signed out without the "Not signed in" warning, which other commands still get', async () => {
    const token = process.env.PLATFORM_TOKEN;
    delete process.env.PLATFORM_TOKEN;
    try {
      // An invalid spec exits before any registry call, so this stays offline.
      // The FIRST exit is the listener's: the mocked exit throws, and the CLI's
      // catch-all then exits again, which a real process never reaches.
      await runMain(['--upgrade-check', 'x;y'], { selfUpdate: true });
      expect(jest.mocked(process.exit).mock.calls[0]?.[0]).toBe(2);
      expect(logged.join('\n')).not.toContain('Not signed in');
      logged.length = 0;
      await runMain(['completions', 'fish'], {});
      expect(logged.join('\n')).toContain('Not signed in');
    } finally {
      process.env.PLATFORM_TOKEN = token;
    }
  });
});
