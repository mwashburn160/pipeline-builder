// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { execSync } from 'child_process';
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
export function getToolInfo(tool: string, versionArg = '--version'): CdkInfo {
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
