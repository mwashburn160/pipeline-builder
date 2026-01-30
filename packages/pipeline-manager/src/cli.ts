#!/usr/bin/env node

import { program } from 'commander';
import { createPipeline } from './commands/create-pipeline.command';
import { deploy } from './commands/deploy.command';
import { getPipeline } from './commands/get-pipeline.command';
import { getPlugin } from './commands/get-plugin.command';
import { listPipelines } from './commands/list-pipelines.command';
import { listPlugins } from './commands/list-plugins.command';
import { uploadPlugin } from './commands/upload-plugin.command';
import { version } from './commands/version.command';
import {
  APP_NAME,
  APP_DESCRIPTION,
  APP_VERSION,
  ENV_VARS,
  isDebugMode,
  generateExecutionId,
} from './config/cli.constants';
import { banner, miniBanner } from './utils/banner';
import { ERROR_CODES, handleError } from './utils/error.handler';
import { printInfo, printError, printWarning, printDebug, printSection } from './utils/output.utils';

/**
 * CLI initialization options
 */
interface CliOptions {
  /**
   * Show banner on startup
   * @default true
   */
  showBanner?: boolean;

  /**
   * Minimal banner (no ASCII art)
   * @default false
   */
  minimalBanner?: boolean;

  /**
   * Debug mode
   * @default false
   */
  debug?: boolean;

  /**
   * Verbose output
   * @default false
   */
  verbose?: boolean;

  /**
   * Quiet mode (minimal output)
   * @default false
   */
  quiet?: boolean;

  /**
   * No color output
   * @default false
   */
  noColor?: boolean;
}

/**
 * Check environment and display warnings
 */
function checkEnvironment(): void {
  const warnings: string[] = [];

  // Check for required environment variables
  if (!process.env[ENV_VARS.PLATFORM_TOKEN]) {
    warnings.push('PLATFORM_TOKEN environment variable is not set');
    warnings.push('Authentication will fail for API operations');
  }

  // Check Node version
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0] || '0');
  if (majorVersion < 18) {
    warnings.push(`Node.js ${nodeVersion} detected - version 18+ recommended`);
  }

  // Display warnings
  if (warnings.length > 0) {
    printSection('Environment Warnings');
    warnings.forEach(warning => {
      printWarning(warning);
    });
    console.log('');
  }
}

/**
 * Display startup information
 */
function displayStartupInfo(options: CliOptions): void {
  if (options.quiet) return;

  const executionId = generateExecutionId();

  if (options.debug || options.verbose) {
    printDebug('CLI Configuration', {
      name: APP_NAME,
      version: APP_VERSION,
      executionId,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
      env: {
        debug: process.env.DEBUG,
        token: process.env[ENV_VARS.PLATFORM_TOKEN] ? 'set' : 'not set',
        url: process.env[ENV_VARS.PLATFORM_BASE_URL] || 'default',
      },
    });
  } else {
    printDebug('Starting CLI', {
      version: APP_VERSION,
      executionId,
    });
  }
}

/**
 * Register all CLI commands
 */
function registerCommands(): void {
  printDebug('Registering commands');

  // Configure program
  program
    .name(APP_NAME)
    .description(APP_DESCRIPTION)
    .version(APP_VERSION, '-v, --version', 'Show CLI version')
    .option('--debug', 'Enable debug output with stack traces', false)
    .option('--verbose', 'Show detailed information', false)
    .option('--quiet', 'Minimal output (errors only)', false)
    .option('--no-color', 'Disable colored output', false)
    .addHelpText('after', `
Environment Variables:
  ${ENV_VARS.PLATFORM_TOKEN}              Authentication token (required)
  ${ENV_VARS.PLATFORM_BASE_URL}                 API base URL (optional)
  ${ENV_VARS.CLI_CONFIG_PATH}              Config file path (optional)
  ${ENV_VARS.TLS_REJECT_UNAUTHORIZED}      Disable SSL verification if '0'
  ${ENV_VARS.DEBUG}                        Enable debug mode if 'true'

Examples:
  $ ${APP_NAME} version
  $ ${APP_NAME} list-pipelines --project my-app
  $ ${APP_NAME} get-pipeline --id pipe-123 --format json
  $ ${APP_NAME} deploy --id pipe-123 --profile production

Documentation:
  For detailed documentation, visit: https://docs.example.com
  For support, contact: support@example.com
`);

  // Version command (special handling)
  version(program);

  // Query commands
  printDebug('Registering query commands');
  getPlugin(program); // Single plugin by ID
  listPlugins(program); // Multiple plugins with filters
  getPipeline(program); // Single pipeline by ID
  listPipelines(program); // Multiple pipelines with filters

  // Create/Upload commands
  printDebug('Registering create/upload commands');
  createPipeline(program); // Create pipeline configuration
  uploadPlugin(program); // Upload and deploy plugin

  // Deployment command
  printDebug('Registering deployment commands');
  deploy(program); // Deploy pipeline with CDK

  printDebug('All commands registered successfully');
}

/**
 * Handle program errors
 */
function setupErrorHandlers(): void {
  // Handle uncaught exceptions
  process.on('uncaughtException', (error: Error) => {
    console.error(''); // Empty line
    printError('Uncaught exception', {
      error: error.message,
      name: error.name,
    });

    handleError(error, ERROR_CODES.GENERAL, {
      debug: isDebugMode(program.opts()),
      exit: true,
      context: {
        type: 'uncaughtException',
      },
    });
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason: unknown) => {
    console.error(''); // Empty line
    printError('Unhandled promise rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });

    const error = reason instanceof Error ? reason : new Error(String(reason));

    handleError(error, ERROR_CODES.GENERAL, {
      debug: isDebugMode(program.opts()),
      exit: true,
      context: {
        type: 'unhandledRejection',
      },
    });
  });

  // Handle SIGINT (Ctrl+C)
  process.on('SIGINT', () => {
    console.log(''); // Empty line
    printWarning('Process interrupted by user (SIGINT)');
    console.log(''); // Empty line
    process.exit(130); // Standard exit code for SIGINT
  });

  // Handle SIGTERM
  process.on('SIGTERM', () => {
    console.log(''); // Empty line
    printWarning('Process terminated (SIGTERM)');
    console.log(''); // Empty line
    process.exit(143); // Standard exit code for SIGTERM
  });
}

/**
 * Initialize CLI with options
 *
 * @param options - CLI initialization options
 */
export function initializeCli(options: CliOptions = {}): void {
  const {
    showBanner = true,
    minimalBanner = false,
    debug = false,
    verbose = false,
    quiet = false,
    noColor = false,
  } = options;

  // Handle color output
  if (noColor) {
    process.env.NO_COLOR = '1';
  }

  // Display banner
  if (showBanner && !quiet) {
    if (minimalBanner) {
      miniBanner();
    } else {
      banner({
        minimal: false,
        showDescription: true,
        showTimestamp: debug || verbose,
        showExecutionId: debug,
      });
    }
  }

  // Display startup info
  displayStartupInfo({ debug, verbose, quiet });

  // Check environment
  if (!quiet) {
    checkEnvironment();
  }

  // Setup error handlers
  setupErrorHandlers();

  // Register commands
  try {
    registerCommands();
    printDebug('CLI initialization complete');
  } catch (error) {
    printError('CLI initialization failed', {
      error: error instanceof Error ? error.message : String(error),
    });

    handleError(error, ERROR_CODES.CONFIGURATION, {
      debug: debug || isDebugMode(),
      exit: true,
      context: {
        stage: 'initialization',
      },
    });
  }
}

/**
 * Parse command line arguments
 */
function parseArguments(): void {
  try {
    program.parse(process.argv);

    // Show help if no command provided
    const args = process.argv.slice(2);
    if (args.length === 0) {
      printInfo('No command specified - displaying help');
      console.log(''); // Empty line
      program.outputHelp();
      process.exit(0);
    }

    // Check if command exists
    const command = args[0];
    if (command && !command.startsWith('-')) {
      const commandExists = program.commands.some(cmd => cmd.name() === command);

      if (!commandExists) {
        console.log(''); // Empty line
        printError(`Unknown command: ${command}`);
        console.log(''); // Empty line
        printInfo('Available commands:');
        program.commands.forEach(cmd => {
          console.log(`  • ${cmd.name()} - ${cmd.description()}`);
        });
        console.log(''); // Empty line
        process.exit(1);
      }
    }

    printDebug('Command line arguments parsed successfully');
  } catch (error) {
    handleError(error, ERROR_CODES.GENERAL, {
      debug: isDebugMode(program.opts()),
      exit: true,
      context: {
        stage: 'argument-parsing',
        argv: process.argv,
      },
    });
  }
}

/**
 * Main CLI entry point
 *
 * @param options - CLI initialization options
 *
 * @example
 * ```typescript
 * // Standard initialization
 * main();
 *
 * // Minimal mode
 * main({ minimalBanner: true, quiet: true });
 *
 * // Debug mode
 * main({ debug: true, verbose: true });
 * ```
 */
export function main(options: CliOptions = {}): void {
  try {
    // Initialize CLI
    initializeCli(options);

    // Parse arguments and execute command
    parseArguments();

    // If we reach here, command completed successfully
    printDebug('CLI execution completed successfully');
  } catch (error) {
    // Final catch-all error handler
    console.error(''); // Empty line
    printError('Fatal CLI error', {
      error: error instanceof Error ? error.message : String(error),
    });

    handleError(error, ERROR_CODES.GENERAL, {
      debug: isDebugMode(options),
      exit: true,
      context: {
        stage: 'main',
        options,
      },
    });
  }
}

/**
 * Run CLI if executed directly
 */
if (require.main === module) {
  // Parse CLI options from environment or command line
  const options: CliOptions = {
    debug: process.env.DEBUG === 'true',
    quiet: process.argv.includes('--quiet'),
    verbose: process.argv.includes('--verbose'),
    noColor: process.argv.includes('--no-color') || process.env.NO_COLOR === '1',
  };

  main(options);
}