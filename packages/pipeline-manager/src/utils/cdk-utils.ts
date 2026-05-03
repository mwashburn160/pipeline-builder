// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { execSync } from 'child_process';
import path from 'path';
import { printError } from './output-utils';

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
 * Checks whether the AWS CDK CLI is installed and returns its version.
 *
 * Tries `cdk --version` first. If that fails (typically because the user has
 * cdk on PATH via their shell rc but execSync's default `/bin/sh` doesn't
 * source it), falls back to running through the user's interactive shell
 * (`$SHELL -i -c`) so node version managers like nvm/asdf and homebrew paths
 * become visible.
 */
export function getCdkInfo(): CdkInfo {
  try {
    const output = execSync('cdk --version', { encoding: 'utf-8', stdio: 'pipe' });
    return { available: true, version: output.trim() };
  } catch (firstError) {
    // Fallback: invoke through the user's login shell so PATH from their rc
    // file is sourced. Skip when SHELL isn't set or is /bin/sh (which would
    // be the same default).
    const userShell = process.env.SHELL;
    if (userShell && !userShell.endsWith('/sh')) {
      try {
        const output = execSync('cdk --version', {
          encoding: 'utf-8',
          stdio: 'pipe',
          shell: userShell,
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
  /** When `true`, inherits stdio so output streams to the terminal. Defaults to `true`. */
  showOutput?: boolean;
  /** Additional environment variables to inject. */
  env?: Record<string, string>;
}

/**
 * Result of a CDK shell command execution.
 */
export interface CdkShellResult {
  success: boolean;
  duration: number;
}

/**
 * Executes a CDK CLI command as a child process.
 *
 * @param command - The full CDK CLI command string (e.g., `cdk bootstrap ...`).
 * @param options - Optional execution settings.
 * @returns An object with `success` and `duration` in ms.
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
      stdio: showOutput ? ['inherit', 'inherit', 'pipe'] : 'pipe',
      env,
    });

    const duration = Date.now() - startTime;

    return {
      success: true,
      duration,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    // Extract stderr/stdout from execSync error when available
    if (error && typeof error === 'object' && 'stderr' in error) {
      const execError = error as { stderr?: Buffer | string; stdout?: Buffer | string; status?: number };
      const stderr = execError.stderr?.toString().trim();
      const stdout = execError.stdout?.toString().trim();

      console.error('');
      console.error('CDK deployment failed:');
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
