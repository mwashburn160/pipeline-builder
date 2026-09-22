// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The CLI's command SURFACE (src/cli.ts): every namespace and leaf command
 * registers and renders its help, the completions generator walks the real
 * tree for bash/zsh/fish, the environment warnings fire when nobody is
 * signed in, and the process signal handlers exit with the conventional codes
 * (main()'s argument handling is cli-main.test.ts — it needs a fresh program). Nothing here reaches the network or AWS: only `--help`
 * and the completions action run.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Command } from 'commander';

// A throwaway HOME so the credential store (resolved at import) never reads the
// developer's real session.
const HOME = mkdtempSync(join(tmpdir(), 'pm-cli-surface-'));
const saved = { HOME: process.env.HOME, PLATFORM_TOKEN: process.env.PLATFORM_TOKEN, NO_COLOR: process.env.NO_COLOR };
process.env.HOME = HOME;
delete process.env.PLATFORM_TOKEN;

const { program } = await import('commander');
// Configure BEFORE registration: subcommands copy these settings when created.
let helpOut = '';
program.exitOverride();
program.configureOutput({ writeOut: (s) => { helpOut += s; }, writeErr: (s) => { helpOut += s; } });

const cli = await import('../src/cli.js');

class ExitError extends Error {
  constructor(readonly code: number | undefined) { super(`__EXIT_${code}__`); }
}

const logged: string[] = [];

/** Capture console output and turn process.exit into a throw (re-armed per test: the config restores mocks). */
function captureIo(): void {
  for (const m of ['log', 'error', 'warn'] as const) {
    jest.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  }
  jest.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new ExitError(code); }) as never);
}

// Registered at module load (not in a hook): the per-command `it.each` below
// is built from the registered tree at collection time. Not signed in and no
// token → checkEnvironment's warning path; `noColor` exercises NO_COLOR; the
// full banner renders once. (The config restores these spies before each test.)
captureIo();
cli.initializeCli({ debug: true, verbose: true, noColor: true });
const initWarnings = logged.join('\n');

afterAll(() => {
  jest.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  helpOut = '';
  logged.length = 0;
  captureIo();
});

/** Every command path (`['pipeline', 'list']`, `['version']`, …). */
function paths(cmd: Command, prefix: string[] = []): string[][] {
  return cmd.commands.flatMap((c) => {
    const p = [...prefix, c.name()];
    return c.commands.length ? [p, ...paths(c, p)] : [p];
  });
}

async function parse(args: string[]): Promise<unknown> {
  try {
    return await program.parseAsync(['node', 'pipeline-manager', ...args]);
  } catch (e) {
    return e;
  }
}

describe('command registration', () => {
  it('registers the task namespaces and meta commands', () => {
    expect(program.commands.map((c) => c.name()).sort()).toEqual(
      ['audit', 'auth', 'completions', 'infra', 'org', 'pipeline', 'plugin', 'status', 'template', 'version'],
    );
  });

  it('warned at startup that nobody is signed in, and honoured --no-color', () => {
    expect(initWarnings).toContain('Not signed in (no PLATFORM_TOKEN, no stored session)');
    expect(process.env.NO_COLOR).toBe('1');
  });

  it.each(paths(program).map((p) => [p.join(' '), p] as const))('`%s --help` renders', async (_label, path) => {
    const err = await parse([...path, '--help']);
    expect(err).toMatchObject({ code: 'commander.helpDisplayed' });
    expect(helpOut).toContain('Usage:');
  });

  it('the root help lists the command groups and exit codes', async () => {
    await parse(['--help']);
    expect(helpOut).toContain('Command groups:');
    expect(helpOut).toContain('Exit codes');
  });
});

describe('completions', () => {
  it.each(['bash', 'zsh', 'fish'])('generates %s completions from the live command tree', async (shell) => {
    await parse(['completions', shell]);
    const out = logged.join('\n');
    expect(out).toContain('pipeline-manager');
    expect(out).toContain('pipeline');
    expect(out).toMatch(/list/);
  });

  it('refuses an unknown shell with exit 1', async () => {
    const err = await parse(['completions', 'powershell']);
    expect(err).toBeInstanceOf(ExitError);
    expect((err as ExitError).code).toBe(1);
    expect(logged.join('\n')).toContain('Unknown shell: powershell');
  });
});

describe('process signal handlers', () => {
  it.each([['SIGINT', 130], ['SIGTERM', 143]] as const)('%s exits %i', (signal, code) => {
    const handler = process.listeners(signal).at(-1) as () => void;
    expect(() => handler()).toThrow(`__EXIT_${code}__`);
  });

  it('an uncaught exception or unhandled rejection is reported and exits non-zero', () => {
    const uncaught = process.listeners('uncaughtException').at(-1) as (e: Error) => void;
    expect(() => uncaught(new Error('boom'))).toThrow(ExitError);
    const rejection = process.listeners('unhandledRejection').at(-1) as (r: unknown) => void;
    expect(() => rejection('string reason')).toThrow(ExitError);
  });
});
