// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { execSync, spawn } from 'child_process';
import path from 'path';
import { printError } from './output-utils.js';

/**
 * Path to dist/boilerplate.js. tsc emits commands at dist/commands/, so
 * boilerplate is one level up.
 */
export function resolveBoilerplatePath(callerDir: string): string {
  return path.join(callerDir, '..', 'boilerplate.js');
}

export interface CdkInfo {
  available: boolean;
  version: string | null;
  error?: string;
}

/**
 * Checks whether a CLI tool is installed and returns its version output.
 *
 * Tries `<tool> <versionArg>` first. If that fails (typically because the tool
 * is on PATH via the user's shell rc but execSync's default `/bin/sh` doesn't
 * source it), falls back to running through the user's login+interactive shell
 * (`$SHELL -ilc`) so node version managers like nvm/asdf and homebrew paths
 * become visible. stdin is ignored so an interactive shell can't block on input.
 */
function getToolInfo(tool: string, versionArg = '--version'): CdkInfo {
  const cmd = `${tool} ${versionArg}`;
  try {
    const output = execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });
    return { available: true, version: output.trim() };
  } catch (firstError) {
    const userShell = process.env.SHELL;
    if (userShell && !userShell.endsWith('/sh')) {
      try {
        const output = execSync(`${userShell} -ilc '${cmd}'`, {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { available: true, version: output.trim() };
      } catch {
        // fall through to the original error
      }
    }
    return {
      available: false,
      version: null,
      error: firstError instanceof Error ? firstError.message : 'Unknown error',
    };
  }
}

/**
 * Checks whether the AWS CDK CLI is installed and returns its version.
 */
export function getCdkInfo(): CdkInfo {
  return getToolInfo('cdk');
}

/**
 * Checks whether the AWS CDK CLI is installed and accessible on the PATH.
 */
export function checkCdkAvailable(): boolean {
  return getCdkInfo().available;
}

/**
 * Asserts that the AWS CDK CLI is installed; throws with a user-friendly
 * message + install hint when it isn't. Use at the top of any command that
 * shells out to `cdk`.
 */
export function ensureCdkAvailable(): void {
  if (checkCdkAvailable()) return;
  printError('AWS CDK is not installed or not accessible');
  console.log('Install CDK with: npm install -g aws-cdk');
  throw new Error('AWS CDK not found');
}

/**
 * Options for executing a CDK shell command.
 */
export interface CdkShellOptions {
  /** When `true`, prints the error to stderr on failure. */
  debug?: boolean;
  /**
   * When `true` (the default), inherits stdio so output streams to the
   * terminal. That includes stderr: cdk writes its progress there, so piping it
   * would hide a whole deploy until it ended (and abort one whose log outgrew
   * execSync's buffer). When `false`, output is captured and replayed
   * only on failure.
   */
  showOutput?: boolean;
  /** Additional environment variables to inject. */
  env?: Record<string, string>;
}

/**
 * Result of a CDK shell command execution.
 */
export interface CdkShellResult {
  /** Wall-clock time the command took, in ms. */
  duration: number;
}

/**
 * Executes a CDK CLI command as a child process.
 *
 * @param command - The full CDK CLI command string (e.g., `cdk bootstrap ...`).
 * @param options - Optional execution settings.
 * @returns The command's `duration` in ms. A failed command THROWS (after
 *   printing its stderr/stdout), so there is no failure result to check.
 */
export function executeCdkShellCommand(
  command: string,
  options: CdkShellOptions = {},
): CdkShellResult {
  const { debug = false, showOutput = true, env: extraEnv } = options;
  const startTime = Date.now();

  try {
    const env = {
      ...process.env,
      ...extraEnv,
    };

    execSync(command, {
      stdio: showOutput ? 'inherit' : 'pipe',
      // Captured output must not overflow execSync's 1 MiB default, which kills cdk mid-run.
      maxBuffer: 64 * 1024 * 1024,
      env,
    });

    const duration = Date.now() - startTime;

    return { duration };
  } catch (error) {
    const duration = Date.now() - startTime;

    // Extract stderr/stdout from execSync error when available
    if (error && typeof error === 'object' && 'stderr' in error) {
      const execError = error as { stderr?: Buffer | string; stdout?: Buffer | string; status?: number };
      const stderr = execError.stderr?.toString().trim();
      const stdout = execError.stdout?.toString().trim();

      console.error('');
      console.error('CDK command failed:');
      if (stderr) console.error(stderr);
      if (stdout) console.error(stdout);
      if (execError.status !== undefined) {
        console.error(`Exit code: ${execError.status} (after ${duration}ms)`);
      }
    } else if (debug) {
      console.error('CDK execution failed:', error);
    }

    throw error;
  }
}

/** Options for {@link spawnCdkShellCommand}. */
export interface CdkSpawnOptions extends Pick<CdkShellOptions, 'showOutput' | 'env'> {
  /** Aborting kills the command's whole process group (cdk and the node app it started) and rejects with an `AbortError`. */
  signal?: AbortSignal;
  /** Called with the child's pid once it is started (tests). */
  onSpawn?: (pid: number) => void;
}

const abortError = (): Error => Object.assign(new Error('The CDK command was aborted'), { name: 'AbortError' });

/**
 * {@link executeCdkShellCommand}'s ABORTABLE twin: the command runs in its own
 * process group without blocking the event loop, so the caller can keep
 * talking to the platform (the runner deploy job's session heartbeat) and stop
 * cdk when told to. Resolves with the duration; a non-zero exit rejects.
 * An abort sends SIGTERM to the group, then SIGKILL after 10 s.
 */
export function spawnCdkShellCommand(command: string, options: CdkSpawnOptions = {}): Promise<CdkShellResult> {
  const { showOutput = true, env: extraEnv, signal, onSpawn } = options;
  if (signal?.aborted) return Promise.reject(abortError());
  const startTime = Date.now();
  return new Promise<CdkShellResult>((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      detached: true,
      stdio: showOutput ? 'inherit' : 'ignore',
      env: { ...process.env, ...extraEnv },
    });
    if (child.pid) onSpawn?.(child.pid);
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const killGroup = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // Already gone.
      }
    };
    const onAbort = (): void => {
      aborted = true;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), 10_000);
      killTimer.unref();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = (): void => {
      signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
    };
    child.on('error', (err) => {
      done();
      reject(aborted ? abortError() : err);
    });
    child.on('exit', (code, sig) => {
      done();
      // The shell may have exited while its group lives on: make sure nothing outlives an abort.
      if (aborted) {
        killGroup('SIGKILL');
        reject(abortError());
        return;
      }
      const duration = Date.now() - startTime;
      if (code === 0) {
        resolve({ duration });
        return;
      }
      const why = sig ? `was killed by ${sig}` : `exited with code ${code}`;
      printError(`CDK command ${why} (after ${duration}ms)`);
      reject(Object.assign(new Error(`CDK command ${why}`), { status: code ?? undefined }));
    });
  });
}
