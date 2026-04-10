// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { execSync } from 'child_process';

export interface CdkInfo {
  available: boolean;
  version: string | null;
  error?: string;
}

/**
 * Checks whether the AWS CDK CLI is installed and returns its version.
 */
export function getCdkInfo(): CdkInfo {
  try {
    const output = execSync('cdk --version', { encoding: 'utf-8', stdio: 'pipe' });
    return { available: true, version: output.trim() };
  } catch (error) {
    return { available: false, version: null, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Checks whether the AWS CDK CLI is installed and accessible on the PATH.
 */
export function checkCdkAvailable(): boolean {
  return getCdkInfo().available;
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
