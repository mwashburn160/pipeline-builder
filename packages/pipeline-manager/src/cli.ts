#!/usr/bin/env node

import { program } from 'commander';
import { create_pipeline } from './commands/create-pipeline-command';
import { deploy } from './commands/deploy-command';
import { get_pipeline } from './commands/get-pipeline-command';
import { get_plugin } from './commands/get-plugin-command';
import { list_pipelines } from './commands/list-pipelines-command';
import { list_plugins } from './commands/list-plugins-command';
import { upload_plugin } from './commands/upload-plugin-command';
import { version } from './commands/version-command';
import { APP_NAME, APP_DESCRIPTION, APP_VERSION } from './config/cli-constants';
import { banner } from './utils/banner';
import { ERROR_CODES, handleError } from './utils/error-handler';
import { printSuccess, printInfo, printError } from './utils/output-utils';

/**
 * Register all CLI commands
 */
function register(): void {
  program
    .name(APP_NAME)
    .description(APP_DESCRIPTION)
    .version(APP_VERSION, '-v, --version', 'Show version')
    .option('--debug', 'Show debug output and stack traces', false);

  printInfo('Registering commands');

  // Version command
  version(program);

  // Query commands
  get_plugin(program); // Single plugin by name
  list_plugins(program); // Multiple plugins with filters
  get_pipeline(program); // Single pipeline by ID
  list_pipelines(program); // Multiple pipelines with filters

  // Create/Upload commands
  create_pipeline(program); // Create pipeline configuration
  upload_plugin(program); // Upload and deploy plugin

  // Deployment command
  deploy(program); // Deploy pipeline with CDK

  // Parse command line arguments
  program.parse();

  // Show help if no command provided
  if (!process.argv.slice(2).length) {
    program.outputHelp();
  }
}

/**
 * Main CLI entry point
 */
export function main(): void {
  // Display banner
  banner();

  printInfo('Starting CLI', { version: APP_VERSION });

  try {
    register();
    printSuccess('CLI initialized');
  } catch (error) {
    printError(
      'CLI startup failed',
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );

    handleError(
      error,
      ERROR_CODES.CONFIGURATION,
      {
        debug: program.opts().debug,
        exit: true,
      },
    );
  }
}

// Run CLI if executed directly
if (require.main === module) {
  main();
}