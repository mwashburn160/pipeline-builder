import { execSync, ExecSyncOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import pico from 'picocolors';
import { ERROR_CODES, handleError } from './error-handler';
import { printError, printInfo, printKeyValue, printSection, printSuccess, printWarning } from './output-utils';

const { bold, cyan, dim, magenta, yellow } = pico;

/**
 * Options for CDK command execution
 */
export interface CdkExecutionOptions {
  /**
   * Environment variables to pass to the CDK command
   */
  env?: Record<string, string>;

  /**
   * Working directory for command execution
   */
  cwd?: string;

  /**
   * Timeout in milliseconds (0 = no timeout)
   */
  timeout?: number;

  /**
   * Whether to show command output (default: true)
   */
  showOutput?: boolean;

  /**
   * Whether to enable debug mode
   */
  debug?: boolean;

  /**
   * Custom execution ID for logging
   */
  executionId?: string;
}

/**
 * Result of CDK command execution
 */
export interface CdkExecutionResult {
  executionId: string;
  command: string;
  success: boolean;
  duration: number;
  output?: string;
  error?: Error;
}

/**
 * Execute a CDK command with enhanced logging and error handling
 *
 * @param command - The CDK command to execute
 * @param encodedProps - Base64 encoded pipeline properties
 * @param options - Execution options
 * @returns Execution result
 *
 * @example
 * ```typescript
 * executeCdkCommand(
 *   'cdk deploy MyStack --require-approval never',
 *   encodedProps,
 *   { debug: true }
 * );
 * ```
 */
export function executeCdkCommand(
  command: string,
  encodedProps: string,
  options: CdkExecutionOptions = {},
): CdkExecutionResult {
  const {
    env = {},
    cwd,
    timeout = 0,
    showOutput = true,
    debug = false,
    executionId = Math.random().toString(36).substring(7).toUpperCase(),
  } = options;

  const startTime = Date.now();

  console.log(
    `${magenta(`[EXE-${executionId}]`)} ${cyan(bold('Starting CDK execution'))}`,
  );

  // Log command details
  const shortCommand = command.split(' --')[0] || command;

  if (debug) {
    printInfo('Command details', {
      command: shortCommand,
      fullCommand: command,
      commandLength: command.length,
      propsLength: encodedProps.length,
      workingDirectory: cwd || process.cwd(),
    });
    console.log(dim('  Encoded props preview:'), encodedProps.substring(0, 50) + '...');
  } else {
    printInfo('Executing CDK command', {
      command: shortCommand,
      workingDirectory: cwd || process.cwd(),
    });
  }

  const execOptions: ExecSyncOptions = {
    stdio: showOutput ? 'inherit' : 'pipe',
    cwd,
    timeout,
    env: {
      ...process.env,
      ...env,
      PIPELINE_PROPS: encodedProps,
      CDK_DISABLE_CLI_TELEMETRY: 'true',
      FORCE_COLOR: '1',
    },
  };

  try {
    const output = execSync(command, execOptions);
    const duration = Date.now() - startTime;

    console.log(''); // Empty line after CDK output
    printSuccess('CDK command completed successfully', {
      duration: `${duration}ms`,
      executionId,
    });

    return {
      executionId,
      command: shortCommand,
      success: true,
      duration,
      output: output ? output.toString() : undefined,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    console.log(''); // Empty line after CDK output
    printError('CDK command execution failed', {
      duration: `${duration}ms`,
      executionId,
    });

    const result: CdkExecutionResult = {
      executionId,
      command: shortCommand,
      success: false,
      duration,
      error: error instanceof Error ? error : new Error(String(error)),
    };

    handleError(error, ERROR_CODES.GENERAL, {
      exit: true,
      debug,
      context: {
        command: shortCommand,
        executionId,
        duration,
      },
    });

    return result; // Never reached due to handleError exit
  }
}

/**
 * Execute multiple CDK commands in sequence
 *
 * @param commands - Array of commands to execute
 * @param encodedProps - Base64 encoded pipeline properties
 * @param options - Execution options
 * @returns Array of execution results
 *
 * @example
 * ```typescript
 * executeCdkCommands([
 *   'cdk synth MyStack',
 *   'cdk deploy MyStack --require-approval never'
 * ], encodedProps);
 * ```
 */
export function executeCdkCommands(
  commands: string[],
  encodedProps: string,
  options: CdkExecutionOptions = {},
): CdkExecutionResult[] {
  printSection('Batch CDK Execution');

  printInfo(`Executing ${commands.length} command(s) in sequence`);

  const results: CdkExecutionResult[] = [];

  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];

    if (!command || typeof command !== 'string') {
      printError(`Invalid command at index ${i}`, {
        index: i,
        type: typeof command,
      });
      continue;
    }

    console.log(
      yellow(`\n[${i + 1}/${commands.length}]`),
      `Executing: ${command.split(' --')[0] || command}`,
    );

    const result = executeCdkCommand(command, encodedProps, {
      ...options,
      executionId: `BATCH-${i + 1}`,
    });

    results.push(result);

    if (!result.success) {
      printError(`Batch execution stopped at command ${i + 1}/${commands.length}`);
      break;
    }
  }

  const successful = results.filter(r => r.success).length;
  const total = results.length;

  printSection('Batch Execution Summary');

  if (successful === total) {
    printSuccess(`All ${total} command(s) completed successfully`);
  } else {
    printError(`${successful}/${total} command(s) completed successfully`);
  }

  printKeyValue({
    'Total Commands': total,
    'Successful': successful,
    'Failed': total - successful,
    'Success Rate': `${Math.round((successful / total) * 100)}%`,
  });

  return results;
}

/**
 * Check if CDK is available in the environment
 *
 * @returns true if CDK is available, false otherwise
 */
export function checkCdkAvailable(): boolean {
  try {
    execSync('cdk --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get CDK version
 *
 * @returns CDK version string or null if not available
 */
export function getCdkVersion(): string | null {
  try {
    const output = execSync('cdk --version', { stdio: 'pipe' });
    return output.toString().trim();
  } catch {
    return null;
  }
}

/**
 * Validate CDK command before execution
 *
 * @param command - The command to validate
 * @returns true if command is valid, throws error otherwise
 */
export function validateCdkCommand(command: string): boolean {
  if (!command || typeof command !== 'string') {
    throw new Error('Command must be a non-empty string');
  }

  if (!command.startsWith('cdk ')) {
    throw new Error('Command must start with "cdk "');
  }

  const validCommands = ['synth', 'deploy', 'diff', 'destroy', 'bootstrap'];

  const cdkCommand = command.split(' ')[1];
  if (!cdkCommand) {
    throw new Error('Invalid CDK command format');
  }

  if (!validCommands.includes(cdkCommand)) {
    printWarning(`Unknown CDK command: ${cdkCommand}`, {
      command: cdkCommand,
      validCommands,
    });
  }

  return true;
}

/**
 * Get available CDK commands
 *
 * @returns Array of CDK command names
 */
export function getAvailableCdkCommands(): string[] {
  return ['synth', 'deploy', 'diff', 'destroy', 'bootstrap', 'list', 'ls'];
}

/**
 * Check if a specific CDK command is available
 *
 * @param commandName - Name of the CDK command (e.g., 'deploy', 'synth')
 * @returns true if command is available, false otherwise
 */
export function isCdkCommandAvailable(commandName: string): boolean {
  if (!checkCdkAvailable()) {
    return false;
  }

  try {
    const output = execSync('cdk --help', { stdio: 'pipe', encoding: 'utf-8' });
    return output.includes(commandName);
  } catch {
    return false;
  }
}

/**
 * Get CDK context values
 *
 * @param cwd - Working directory
 * @returns CDK context object or null if not available
 */
export function getCdkContext(cwd?: string): Record<string, unknown> | null {
  try {
    const contextPath = path.join(cwd || process.cwd(), 'cdk.context.json');

    if (fs.existsSync(contextPath)) {
      const content = fs.readFileSync(contextPath, 'utf-8');
      return JSON.parse(content);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Display CDK execution summary
 *
 * @param result - CDK execution result
 */
export function displayCdkSummary(result: CdkExecutionResult): void {
  printSection('CDK Execution Summary');

  printKeyValue({
    'Execution ID': result.executionId,
    'Command': result.command,
    'Status': result.success ? '✓ Success' : '✗ Failed',
    'Duration': `${result.duration}ms`,
  });

  if (result.error) {
    printError('Execution error', {
      message: result.error.message,
    });
  }
}