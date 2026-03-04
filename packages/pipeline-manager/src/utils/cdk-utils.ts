import { execSync } from 'child_process';

/**
 * Checks whether the AWS CDK CLI is installed and accessible on the PATH.
 * @returns `true` if `cdk --version` succeeds, `false` otherwise.
 */
export function checkCdkAvailable(): boolean {
  try {
    execSync('cdk --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
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
      stdio: showOutput ? 'inherit' : 'pipe',
      env,
    });

    const duration = Date.now() - startTime;

    return {
      success: true,
      duration,
    };
  } catch (error) {
    if (debug) {
      console.error('CDK execution failed:', error);
    }
    throw error;
  }
}
