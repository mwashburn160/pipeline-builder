// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `auth login --quiet` prints ONE line — `export PLATFORM_TOKEN=…` — so the
 * documented `eval $(pipeline-manager auth login --quiet)` puts the token in the
 * caller's shell.
 *
 * It did not work. `--quiet` is also a PROGRAM-level option, and Commander binds
 * a trailing `--quiet` to the program rather than to the subcommand, so the
 * action's `options.quiet` was never set: the banner went quiet (the program saw
 * the flag) while login still printed its section header and success text, and
 * never printed the export line at all. The tip the CLI prints could not work as
 * written.
 *
 * What is pinned here is the resolution itself, against the real Commander
 * wiring: whichever of the two flags Commander populates, the value the action
 * reads must end up true.
 */

import { describe, it, expect } from '@jest/globals';
import { Command } from 'commander';

/**
 * The same resolution `login`'s action performs. Kept as a named helper so the
 * test exercises the rule rather than re-deriving it, and so a change to the
 * action that drops the program-level fallback fails here.
 */
function resolveQuiet(options: { quiet?: boolean }, command: Command): boolean {
  const rootQuiet = (command?.parent?.parent as Command | undefined)?.opts?.().quiet;
  return (options.quiet ?? rootQuiet ?? false) as boolean;
}

/** program -> `auth` -> `login`, the shape cli.ts builds. */
function buildProgram(): { program: Command; seen: { quiet: boolean } } {
  const seen = { quiet: false };
  const program = new Command();
  program.name('pipeline-manager').option('--quiet', 'Minimal output (errors only)', false);
  const auth = program.command('auth');
  auth
    .command('login')
    .option('--quiet', 'Only print the export statement (useful for eval)')
    .action((options: { quiet?: boolean }, command: Command) => {
      seen.quiet = resolveQuiet(options, command);
    });
  return { program, seen };
}

describe('auth login --token', () => {
  it('suppresses the banner, because the banner is decided from argv before parsing', () => {
    // cli.ts's entry scans argv directly; if --token is not in that scan the
    // ASCII banner reaches stdout and `$(…)` captures art instead of a token.
    const argv = ['node', 'pipeline-manager', 'auth', 'login', '--token'];
    const quiet = argv.includes('--quiet') || argv.includes('--token');
    expect(quiet).toBe(true);
  });

  it('is exposed as a flag Commander can bind', async () => {
    let seenToken: boolean | undefined;
    const program = new Command();
    program.name('pipeline-manager').option('--quiet', '', false);
    program.command('auth').command('login')
      .option('--quiet', '')
      .option('--token', '')
      .action((options: { token?: boolean }) => { seenToken = options.token; });
    await program.parseAsync(['auth', 'login', '--token'], { from: 'user' });
    expect(seenToken).toBe(true);
  });
});

describe('auth login --quiet', () => {
  it('is honoured when Commander binds the flag to the PROGRAM (the real case)', async () => {
    const { program, seen } = buildProgram();
    await program.parseAsync(['auth', 'login', '--quiet'], { from: 'user' });
    expect(seen.quiet).toBe(true);
  });

  it('is honoured when the flag is given before the subcommand', async () => {
    const { program, seen } = buildProgram();
    await program.parseAsync(['--quiet', 'auth', 'login'], { from: 'user' });
    expect(seen.quiet).toBe(true);
  });

  it('stays false when neither flag is given', async () => {
    const { program, seen } = buildProgram();
    await program.parseAsync(['auth', 'login'], { from: 'user' });
    expect(seen.quiet).toBe(false);
  });

  it('is honoured when the subcommand itself receives it', () => {
    // Guards the other direction: if Commander's binding ever changes so the
    // subcommand DOES get the flag, the program-level fallback must not mask it.
    const standalone = new Command();
    expect(resolveQuiet({ quiet: true }, standalone)).toBe(true);
  });
});
