// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drive the REAL CLI in-process: `initializeCli()` registers every command on
 * commander's global program exactly as `pipeline-manager` does at start-up
 * (namespaces, the preflight `preAction` hook, the error handlers), then
 * `program.parseAsync()` runs one invocation to completion.
 *
 * Each call gets a FRESH module registry (`jest.resetModules()`), because
 * commander keeps option values on the program between parses and the
 * credential store / config loader resolve their paths at import time. The
 * home directory is pinned to the suite's temp HOME before the import, and the
 * resolved credential path is checked against it before anything runs — a
 * mistake here must fail the test, never write the developer's own
 * `~/.pipeline-manager/credentials.json`.
 *
 * `process.exit` is turned into a thrown {@link ExitSignal}, so a command that
 * ends the process reports its exit code to the test instead.
 */

import os from 'node:os';
import { jest } from '@jest/globals';

class ExitSignal extends Error {
  constructor(readonly code: number) { super(`process.exit(${code})`); }
}

export interface CliResult {
  /** The process exit code the invocation would have ended with (0 = success). */
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Extra environment for this invocation only (undefined deletes a key). */
  env?: Record<string, string | undefined>;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

const HANDLED_SIGNALS = ['uncaughtException', 'unhandledRejection', 'SIGINT', 'SIGTERM'] as const;

export async function runCli(home: string, args: string[], options: RunOptions = {}): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const line = (sink: string[]) => (...a: unknown[]): void => { sink.push(`${a.map(String).join(' ')}\n`); };
  const savedEnv = { ...process.env };
  const savedListeners = new Map(HANDLED_SIGNALS.map((s) => [s, process.listeners(s as NodeJS.Signals)]));
  const spies = [
    jest.spyOn(os, 'homedir').mockReturnValue(home),
    jest.spyOn(console, 'log').mockImplementation(line(out)),
    jest.spyOn(console, 'info').mockImplementation(line(out)),
    jest.spyOn(console, 'warn').mockImplementation(line(err)),
    jest.spyOn(console, 'error').mockImplementation(line(err)),
    jest.spyOn(console, 'debug').mockImplementation(line(err)),
    jest.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => { out.push(String(s)); return true; }),
    jest.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => { err.push(String(s)); return true; }),
    jest.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new ExitSignal(code ?? 0); }) as never),
  ];

  process.env.HOME = home;
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  let code = 0;
  try {
    jest.resetModules();
    const store = await import('../../../src/utils/credential-store.js');
    if (!store.credentialStorePath().startsWith(home)) {
      throw new Error(`refusing to run: the credential store resolved to ${store.credentialStorePath()}, outside the test HOME`);
    }
    const { initializeCli } = await import('../../../src/cli.js');
    const { program } = await import('commander');
    initializeCli({ quiet: true, showBanner: false });
    // Commander's own usage errors throw instead of exiting the jest worker.
    program.exitOverride();
    try {
      await program.parseAsync(['node', 'pipeline-manager', ...args]);
      code = typeof process.exitCode === 'number' ? process.exitCode : 0;
    } catch (error) {
      if (error instanceof ExitSignal) code = error.code;
      else if (error && typeof error === 'object' && 'exitCode' in error && typeof error.exitCode === 'number') code = error.exitCode;
      else throw error;
    }
  } finally {
    for (const spy of spies) spy.mockRestore();
    process.exitCode = undefined;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    // initializeCli installs process-level handlers on every run; drop the new ones.
    for (const signal of HANDLED_SIGNALS) {
      const before = savedListeners.get(signal) ?? [];
      for (const listener of process.listeners(signal as NodeJS.Signals)) {
        if (!before.includes(listener)) process.removeListener(signal, listener);
      }
    }
  }

  return { code, stdout: out.join('').replace(ANSI, ''), stderr: err.join('').replace(ANSI, '') };
}
