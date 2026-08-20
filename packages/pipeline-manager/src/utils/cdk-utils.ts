// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { execSync } from 'child_process';
import path from 'path';
import { printError, printSuccess } from './output-utils.js';

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
 * Asserts that the local toolchain CDK needs to bundle the PluginLookup Lambda
 * is present. Synth builds that Lambda via `NodejsFunction` (esbuild); when
 * esbuild isn't on PATH, CDK silently falls back to **Docker bundling**, which
 * can't resolve the handler's cross-directory imports and dies with an opaque
 * `Could not resolve "axios"` / `"../config/handler-constants.js"`. pnpm is also
 * required because the handler's lockfile is `pnpm-lock.yaml`, so CDK drives
 * esbuild through pnpm. Fail fast here with the fix instead of deep in a bundle.
 *
 * Bypass with `SKIP_BUNDLER_CHECK=1` (e.g. an environment that intentionally
 * bundles in Docker with a working mount scope).
 */
export function ensureBundlerAvailable(): void {
  if (process.env.SKIP_BUNDLER_CHECK === '1') return;

  const missing = ['esbuild', 'pnpm'].filter((tool) => !getToolInfo(tool).available);
  if (missing.length === 0) {
    printSuccess('Bundler (esbuild + pnpm) is available');
    return;
  }

  printError(`Missing local bundling prerequisite${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
  console.log('');
  console.log('Synth bundles the PluginLookup Lambda via esbuild (CDK NodejsFunction).');
  console.log('Without esbuild + pnpm on PATH, CDK falls back to Docker bundling, which');
  console.log('fails with: Could not resolve "axios" / "../config/handler-constants.js".');
  console.log('');
  console.log('Install with:');
  console.log('  npm install -g esbuild@0.28.1 pnpm@10.33.0');
  console.log('');
  console.log('Docs: pipeline-manager.md#prerequisites-for-local-pipeline-deploys');
  console.log('(Set SKIP_BUNDLER_CHECK=1 to bypass this check.)');
  throw new Error(`Missing bundler prerequisites: ${missing.join(', ')}`);
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
