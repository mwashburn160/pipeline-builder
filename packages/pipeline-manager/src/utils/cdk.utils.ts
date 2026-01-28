import { execSync, ExecSyncOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import pico from 'picocolors';
import { ERROR_CODES, handleError } from './error.handler';
import { printError, printInfo, printKeyValue, printSection, printSuccess, printWarning } from './output.utils';
import {
  CdkCommand,
  TIMEOUTS,
  formatDuration,
  generateExecutionId,
} from '../config/cli.constants';

const { bold, cyan, dim, green, magenta, red, yellow } = pico;

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
   * @default 0 (no timeout)
   */
  timeout?: number;

  /**
   * Whether to show command output
   * @default true
   */
  showOutput?: boolean;

  /**
   * Whether to enable debug mode
   * @default false
   */
  debug?: boolean;

  /**
   * Custom execution ID for logging
   */
  executionId?: string;

  /**
   * Disable CDK telemetry
   * @default true
   */
  disableTelemetry?: boolean;

  /**
   * Force color output
   * @default true
   */
  forceColor?: boolean;

  /**
   * Dry run mode (validate without executing)
   * @default false
   */
  dryRun?: boolean;
}

/**
 * Result of CDK command execution
 */
export interface CdkExecutionResult {
  /**
   * Unique execution identifier
   */
  executionId: string;

  /**
   * The command that was executed
   */
  command: string;

  /**
   * Full command with all arguments
   */
  fullCommand: string;

  /**
   * Whether execution was successful
   */
  success: boolean;

  /**
   * Execution duration in milliseconds
   */
  duration: number;

  /**
   * Command output (if captured)
   */
  output?: string;

  /**
   * Error (if failed)
   */
  error?: Error;

  /**
   * Exit code
   */
  exitCode?: number;

  /**
   * Working directory
   */
  cwd: string;

  /**
   * Timestamp when execution started
   */
  startedAt: Date;

  /**
   * Timestamp when execution completed
   */
  completedAt: Date;
}

/**
 * Batch execution summary
 */
export interface BatchExecutionSummary {
  /**
   * Total number of commands executed
   */
  total: number;

  /**
   * Number of successful commands
   */
  successful: number;

  /**
   * Number of failed commands
   */
  failed: number;

  /**
   * Success rate percentage
   */
  successRate: number;

  /**
   * Total duration in milliseconds
   */
  totalDuration: number;

  /**
   * Individual results
   */
  results: CdkExecutionResult[];
}

/**
 * CDK context information
 */
export interface CdkContext {
  [key: string]: unknown;
}

/**
 * CDK availability check result
 */
export interface CdkAvailabilityInfo {
  /**
   * Whether CDK is available
   */
  available: boolean;

  /**
   * CDK version if available
   */
  version: string | null;

  /**
   * Error message if not available
   */
  error?: string;
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
 * const result = executeCdkCommand(
 *   'cdk deploy MyStack --require-approval never',
 *   encodedProps,
 *   { debug: true }
 * );
 *
 * if (result.success) {
 *   console.log(`Completed in ${result.duration}ms`);
 * }
 * ```
 */
export function executeCdkCommand(
  command: string,
  encodedProps: string,
  options: CdkExecutionOptions = {},
): CdkExecutionResult {
  const {
    env = {},
    cwd = process.cwd(),
    timeout = TIMEOUTS.CDK_COMMAND,
    showOutput = true,
    debug = false,
    executionId = generateExecutionId(),
    disableTelemetry = true,
    forceColor = true,
    dryRun = false,
  } = options;

  const startedAt = new Date();
  const startTime = Date.now();

  console.log(
    `${magenta(`[EXE-${executionId}]`)} ${cyan(bold('Starting CDK execution'))}`,
  );

  // Validate command
  try {
    validateCdkCommand(command);
  } catch (error) {
    printError('Invalid CDK command', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  // Log command details
  const shortCommand = command.split(' --')[0] || command;

  if (debug) {
    printInfo('Command details', {
      command: shortCommand,
      fullCommand: command,
      commandLength: command.length,
      propsLength: encodedProps.length,
      propsSize: `${(encodedProps.length / 1024).toFixed(2)} KB`,
      workingDirectory: cwd,
      timeout: timeout > 0 ? `${timeout}ms` : 'none',
    });
    console.log(dim('  Encoded props preview:'), encodedProps.substring(0, 50) + '...');
  } else {
    printInfo('Executing CDK command', {
      command: shortCommand,
      workingDirectory: cwd,
    });
  }

  // Dry run mode
  if (dryRun) {
    printWarning('Dry run mode - command will not be executed');

    const duration = Date.now() - startTime;
    const completedAt = new Date();

    return {
      executionId,
      command: shortCommand,
      fullCommand: command,
      success: true,
      duration,
      cwd,
      startedAt,
      completedAt,
      output: 'Dry run - no output',
    };
  }

  // Build environment variables
  const execEnv: Record<string, string> = {
    ...process.env,
    ...env,
    PIPELINE_PROPS: encodedProps,
  } as Record<string, string>;

  if (disableTelemetry) {
    execEnv.CDK_DISABLE_CLI_TELEMETRY = 'true';
  }

  if (forceColor) {
    execEnv.FORCE_COLOR = '1';
  }

  const execOptions: ExecSyncOptions = {
    stdio: showOutput ? 'inherit' : 'pipe',
    cwd,
    timeout,
    env: execEnv,
  };

  try {
    const output = execSync(command, execOptions);
    const duration = Date.now() - startTime;
    const completedAt = new Date();

    console.log(''); // Empty line after CDK output
    printSuccess('CDK command completed successfully', {
      duration: formatDuration(duration),
      executionId,
    });

    return {
      executionId,
      command: shortCommand,
      fullCommand: command,
      success: true,
      duration,
      output: output ? output.toString() : undefined,
      exitCode: 0,
      cwd,
      startedAt,
      completedAt,
    };
  } catch (error: any) {
    const duration = Date.now() - startTime;
    const completedAt = new Date();

    console.log(''); // Empty line after CDK output
    printError('CDK command execution failed', {
      duration: formatDuration(duration),
      executionId,
      exitCode: error.status,
    });

    const result: CdkExecutionResult = {
      executionId,
      command: shortCommand,
      fullCommand: command,
      success: false,
      duration,
      error: error instanceof Error ? error : new Error(String(error)),
      exitCode: error.status,
      cwd,
      startedAt,
      completedAt,
    };

    handleError(error, ERROR_CODES.GENERAL, {
      exit: true,
      debug,
      context: {
        command: shortCommand,
        fullCommand: command,
        executionId,
        duration,
        exitCode: error.status,
        cwd,
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
 * @returns Batch execution summary
 *
 * @example
 * ```typescript
 * const summary = executeCdkCommands([
 *   'cdk synth MyStack',
 *   'cdk deploy MyStack --require-approval never'
 * ], encodedProps);
 *
 * console.log(`${summary.successful}/${summary.total} commands succeeded`);
 * ```
 */
export function executeCdkCommands(
  commands: string[],
  encodedProps: string,
  options: CdkExecutionOptions = {},
): BatchExecutionSummary {
  printSection('Batch CDK Execution');

  printInfo(`Executing ${commands.length} command(s) in sequence`);

  const results: CdkExecutionResult[] = [];
  const batchStartTime = Date.now();

  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];

    if (!command || typeof command !== 'string') {
      printError(`Invalid command at index ${i}`, {
        index: i,
        type: typeof command,
        value: String(command),
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

  const totalDuration = Date.now() - batchStartTime;
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const total = results.length;
  const successRate = total > 0 ? Math.round((successful / total) * 100) : 0;

  printSection('Batch Execution Summary');

  if (successful === total) {
    printSuccess(`All ${total} command(s) completed successfully`);
  } else {
    printError(`${successful}/${total} command(s) completed successfully`);
  }

  printKeyValue({
    'Total Commands': total.toString(),
    'Successful': green(successful.toString()),
    'Failed': failed > 0 ? red(failed.toString()) : '0',
    'Success Rate': successRate >= 100 ? green(`${successRate}%`) : yellow(`${successRate}%`),
    'Total Duration': formatDuration(totalDuration),
    'Average Duration': formatDuration(Math.round(totalDuration / Math.max(total, 1))),
  });

  return {
    total,
    successful,
    failed,
    successRate,
    totalDuration,
    results,
  };
}

/**
 * Check if CDK is available in the environment
 *
 * @returns Availability information
 *
 * @example
 * ```typescript
 * const info = checkCdkAvailability();
 * if (info.available) {
 *   console.log(`CDK version: ${info.version}`);
 * }
 * ```
 */
export function checkCdkAvailability(): CdkAvailabilityInfo {
  try {
    const output = execSync('cdk --version', { stdio: 'pipe', encoding: 'utf-8' });
    const version = output.trim();

    return {
      available: true,
      version,
    };
  } catch (error) {
    return {
      available: false,
      version: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check if CDK is available (simple boolean check)
 *
 * @returns true if CDK is available, false otherwise
 */
export function checkCdkAvailable(): boolean {
  return checkCdkAvailability().available;
}

/**
 * Get CDK version
 *
 * @returns CDK version string or null if not available
 *
 * @example
 * ```typescript
 * const version = getCdkVersion();
 * if (version) {
 *   console.log(`CDK ${version}`);
 * }
 * ```
 */
export function getCdkVersion(): string | null {
  return checkCdkAvailability().version;
}

/**
 * Validate CDK command before execution
 *
 * @param command - The command to validate
 * @returns true if command is valid, throws error otherwise
 *
 * @throws {Error} If command is invalid
 *
 * @example
 * ```typescript
 * try {
 *   validateCdkCommand('cdk deploy MyStack');
 * } catch (error) {
 *   console.error('Invalid command:', error.message);
 * }
 * ```
 */
export function validateCdkCommand(command: string): boolean {
  if (!command || typeof command !== 'string') {
    throw new Error('Command must be a non-empty string');
  }

  const trimmedCommand = command.trim();

  if (trimmedCommand.length === 0) {
    throw new Error('Command cannot be empty or whitespace only');
  }

  if (!trimmedCommand.startsWith('cdk ')) {
    throw new Error('Command must start with "cdk "');
  }

  const parts = trimmedCommand.split(/\s+/);
  const cdkCommand = parts[1];

  if (!cdkCommand) {
    throw new Error('Invalid CDK command format - no command specified after "cdk"');
  }

  const validCommands = ['synth', 'deploy', 'diff', 'destroy', 'bootstrap', 'list', 'ls', 'doctor', 'watch'];

  if (!validCommands.includes(cdkCommand)) {
    printWarning(`Unknown CDK command: ${cdkCommand}`, {
      command: cdkCommand,
      validCommands: validCommands.join(', '),
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
  return ['synth', 'deploy', 'diff', 'destroy', 'bootstrap', 'list', 'ls', 'doctor', 'watch'];
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
 *
 * @example
 * ```typescript
 * const context = getCdkContext();
 * if (context) {
 *   console.log('CDK context:', context);
 * }
 * ```
 */
export function getCdkContext(cwd?: string): CdkContext | null {
  try {
    const contextPath = path.join(cwd || process.cwd(), 'cdk.context.json');

    if (fs.existsSync(contextPath)) {
      const content = fs.readFileSync(contextPath, 'utf-8');
      return JSON.parse(content) as CdkContext;
    }

    return null;
  } catch (error) {
    if (error instanceof Error) {
      printWarning('Failed to read CDK context', {
        error: error.message,
      });
    }
    return null;
  }
}

/**
 * Display CDK execution summary
 *
 * @param result - CDK execution result
 *
 * @example
 * ```typescript
 * const result = executeCdkCommand('cdk synth', props);
 * displayCdkSummary(result);
 * ```
 */
export function displayCdkSummary(result: CdkExecutionResult): void {
  printSection('CDK Execution Summary');

  printKeyValue({
    'Execution ID': result.executionId,
    'Command': result.command,
    'Full Command': result.fullCommand,
    'Status': result.success ? green('✓ Success') : red('✗ Failed'),
    'Duration': formatDuration(result.duration),
    'Working Directory': result.cwd,
    'Started At': result.startedAt.toLocaleString(),
    'Completed At': result.completedAt.toLocaleString(),
  });

  if (result.exitCode !== undefined) {
    console.log('');
    printInfo('Exit Code', { code: result.exitCode });
  }

  if (result.error) {
    console.log('');
    printError('Execution error', {
      message: result.error.message,
      name: result.error.name,
    });
  }

  if (result.output && result.output.length > 0) {
    console.log('');
    printInfo('Output available', {
      size: `${(result.output.length / 1024).toFixed(2)} KB`,
    });
  }
}

/**
 * Display batch execution summary
 *
 * @param summary - Batch execution summary
 *
 * @example
 * ```typescript
 * const summary = executeCdkCommands(commands, props);
 * displayBatchSummary(summary);
 * ```
 */
export function displayBatchSummary(summary: BatchExecutionSummary): void {
  printSection('Batch Execution Details');

  summary.results.forEach((result, index) => {
    console.log('');
    console.log(
      yellow(`Command ${index + 1}/${summary.total}:`),
      result.command,
    );
    printKeyValue({
      'Status': result.success ? green('✓ Success') : red('✗ Failed'),
      'Duration': formatDuration(result.duration),
      'Execution ID': result.executionId,
    });
  });

  console.log('');
  printSection('Overall Summary');

  printKeyValue({
    'Total Commands': summary.total.toString(),
    'Successful': green(summary.successful.toString()),
    'Failed': summary.failed > 0 ? red(summary.failed.toString()) : '0',
    'Success Rate': summary.successRate >= 100 ? green(`${summary.successRate}%`) : yellow(`${summary.successRate}%`),
    'Total Duration': formatDuration(summary.totalDuration),
  });
}

/**
 * Build CDK command with common options
 *
 * @param baseCommand - Base CDK command (e.g., 'deploy', 'synth')
 * @param stackName - Stack name
 * @param options - Additional options
 * @returns Formatted CDK command string
 *
 * @example
 * ```typescript
 * const command = buildCdkCommand('deploy', 'MyStack', {
 *   profile: 'production',
 *   requireApproval: 'never',
 *   output: 'cdk.out',
 * });
 * // Returns: "cdk deploy MyStack --profile production --require-approval never --output cdk.out"
 * ```
 */
export function buildCdkCommand(
  baseCommand: CdkCommand,
  stackName?: string,
  options: {
    profile?: string;
    requireApproval?: string;
    output?: string;
    region?: string;
    context?: Record<string, string>;
    [key: string]: any;
  } = {},
): string {
  let command = `cdk ${baseCommand}`;

  if (stackName) {
    command += ` ${stackName}`;
  }

  if (options.profile) {
    command += ` --profile ${options.profile}`;
  }

  if (options.requireApproval) {
    command += ` --require-approval ${options.requireApproval}`;
  }

  if (options.output) {
    command += ` --output ${options.output}`;
  }

  if (options.region) {
    command += ` --region ${options.region}`;
  }

  if (options.context) {
    Object.entries(options.context).forEach(([key, value]) => {
      command += ` --context ${key}=${value}`;
    });
  }

  // Add any other options
  Object.entries(options).forEach(([key, value]) => {
    if (!['profile', 'requireApproval', 'output', 'region', 'context'].includes(key)) {
      const kebabKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();

      if (typeof value === 'boolean') {
        if (value) {
          command += ` --${kebabKey}`;
        }
      } else if (value !== undefined && value !== null) {
        command += ` --${kebabKey} ${value}`;
      }
    }
  });

  return command;
}
