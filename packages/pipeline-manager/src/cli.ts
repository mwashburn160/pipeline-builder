#!/usr/bin/env node
// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { program } from 'commander';
import { preflightCommandTools } from './utils/preflight.js';
import { auditStacks } from './commands/audit-stacks.js';
import { auditTokens } from './commands/audit-tokens.js';
import { bootstrap } from './commands/bootstrap.js';
import { createPat } from './commands/create-pat.js';
import { createPipeline } from './commands/create-pipeline.js';
import { deploy } from './commands/deploy.js';
import { getPipeline } from './commands/get-pipeline.js';
import { getPlugin } from './commands/get-plugin.js';
import { listPipelines } from './commands/list-pipelines.js';
import { listPlugins } from './commands/list-plugins.js';
import { login } from './commands/login.js';
import { newPlugin } from './commands/new-plugin.js';
import { orgExport } from './commands/org-export.js';
import { provision } from './commands/provision.js';
import { register } from './commands/register.js';
import { setupEvents } from './commands/setup-events.js';
import { status } from './commands/status.js';
import { storeToken } from './commands/store-token.js';
import { synth } from './commands/synth.js';
import { uploadPlugin } from './commands/upload-plugin.js';
import { validatePlugin } from './commands/validate-plugin.js';
import { validateTemplatesCommand } from './commands/validate-templates.js';
import { version } from './commands/version.js';
import {
  APP_NAME,
  APP_DESCRIPTION,
  APP_VERSION,
  ENV_VARS,
  isDebugMode,
  generateExecutionId,
} from './config/cli.constants.js';
import { banner, miniBanner } from './utils/banner.js';
import { ERROR_CODES, handleError } from './utils/error-handler.js';
import { printInfo, printError, printWarning, printDebug, printSection } from './utils/output-utils.js';

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
  const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0] || '0', 10);
  if (majorVersion < 24) {
    warnings.push(`Node.js ${nodeVersion} detected - version 24+ required (see package.json engines)`);
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
        token: process.env[ENV_VARS.PLATFORM_TOKEN] ? 'set': 'not set',
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
Command groups  auth      Authenticate and manage credentials (login, pat)
  pipeline  Create, inspect, and deploy pipelines (create, list, get, register, synth, deploy)
  plugin    Author, validate, and publish plugins (new, validate, upload, get, list)
  template  Validate {{ ... }} templates (validate)
  infra     Set up and operate platform infrastructure (bootstrap, setup-events, store-token, provision)
  audit     Operator audits, cron-friendly (tokens, stacks)
  org       Organization data operations (export)
  status / version / completions

Environment Variables  ${ENV_VARS.PLATFORM_TOKEN} Authentication token (required)
  ${ENV_VARS.PLATFORM_BASE_URL} API base URL (optional)
  ${ENV_VARS.CLI_CONFIG_PATH} Config file path (optional)
  ${ENV_VARS.TLS_REJECT_UNAUTHORIZED} Disable SSL verification if '0'
  ${ENV_VARS.DEBUG} Enable debug mode if 'true'

Examples  $ ${APP_NAME} version
  $ ${APP_NAME} auth login -u me@example.com
  $ ${APP_NAME} pipeline list --project my-app
  $ ${APP_NAME} pipeline get --id pipe-123 --format json
  $ ${APP_NAME} plugin upload --file plugin.zip --organization acme
  $ ${APP_NAME} infra store-token --days 30 --region us-east-1
  $ ${APP_NAME} infra bootstrap --account 123456789012 --region us-east-1
  $ ${APP_NAME} pipeline deploy --id pipe-123 --profile production

Run '${APP_NAME} <group> --help' to see a group's subcommands.
`);

  // Fail-fast preflight: before ANY command's action runs, verify the local
  // tools that command needs. Commander skips this for --help/--version and for
  // help output, so those always work; API-only commands declare no requirements
  // and pass through untouched.
  program.hook('preAction', (_thisCommand, actionCommand) => preflightCommandTools(actionCommand));

  // Top-level meta commands (no namespace).
  version(program);
  status(program); // Show environment and connectivity status

  // Task namespaces — commands are grouped by the job the user is doing, not by
  // implementation. Each parent is a subcommand container; the leaf verb lives in
  // the command file (e.g. `.command('list')`), so `pipeline list` reads as a task.
  printDebug('Registering task namespaces');

  // auth — authenticate and manage credentials
  const auth = program.command('auth').description('Authenticate and manage credentials');
  login(auth); // auth login — obtain PLATFORM_TOKEN (also supports --refresh)
  createPat(auth); // auth pat — create a named Personal Access Token

  // pipeline — create, inspect, and deploy pipelines
  const pipeline = program.command('pipeline').description('Create, inspect, and deploy pipelines');
  createPipeline(pipeline); // pipeline create
  listPipelines(pipeline); // pipeline list
  getPipeline(pipeline); // pipeline get
  register(pipeline); // pipeline register — re-register a deployed ARN + drain pending intents
  synth(pipeline); // pipeline synth — CDK synthesis from pipeline config
  deploy(pipeline); // pipeline deploy — CDK deploy (--app prints boilerplate path)

  // plugin — author, validate, and publish plugins
  const plugin = program.command('plugin').description('Author, validate, and publish plugins');
  newPlugin(plugin); // plugin new — scaffold a local plugin directory
  validatePlugin(plugin); // plugin validate — validate a local plugin before upload
  uploadPlugin(plugin); // plugin upload — upload and deploy
  getPlugin(plugin); // plugin get
  listPlugins(plugin); // plugin list

  // template — validate {{ ... }} templates
  const template = program.command('template').description('Validate {{ ... }} templates in a pipeline or plugin spec');
  validateTemplatesCommand(template); // template validate

  // infra — set up and operate platform infrastructure
  const infra = program.command('infra').description('Set up and operate platform infrastructure');
  bootstrap(infra); // infra bootstrap — CDK toolkit stack
  setupEvents(infra); // infra setup-events — EventBridge event ingestion
  storeToken(infra); // infra store-token — JWT token in Secrets Manager for CDK
  provision(infra); // infra provision — AI-assisted deploy/teardown of the platform

  // audit — operator audits (cron-friendly: exit 1 on findings)
  const audit = program.command('audit').description('Operator audits (cron-friendly: exit 1 on findings)');
  auditTokens(audit); // audit tokens — expiring platform tokens in Secrets Manager
  auditStacks(audit); // audit stacks — CFN stacks vs pipeline_registry drift

  // org — organization data operations
  const org = program.command('org').description('Organization data operations');
  orgExport(org); // org export — GDPR portability export

  // Shell completions
  printDebug('Registering completions command');
  program
    .command('completions')
    .description('Generate shell completions (bash, zsh, fish)')
    .argument('<shell>', 'Shell type: bash, zsh, or fish')
    .action((shell: string) => {
      // Walk commander's registered tree so completions never drift from the actual
      // surface. `topLevel` is the first-word set (namespaces + meta commands);
      // `subs` maps each namespace to its leaf verbs for second-word completion.
      const topLevel = program.commands.map(c => c.name()).sort();
      const subs: Record<string, string[]> = {};
      for (const c of program.commands) {
        if (c.commands.length > 0) subs[c.name()] = c.commands.map(s => s.name()).sort();
      }
      const topLevelStr = topLevel.join(' ');
      switch (shell) {
        case 'bash': {
          // Two-level: complete the group at word 1, its subcommands at word 2.
          const cases = Object.entries(subs)
            .map(([ns, leaves]) => `      ${ns}) COMPREPLY=($(compgen -W "${leaves.join(' ')}" -- "\${cur}"));;`)
            .join('\n');
          console.log(`# pipeline-manager bash completions
_pipeline_manager_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "\${COMP_CWORD}" -eq 1 ]; then
    COMPREPLY=($(compgen -W "${topLevelStr}" -- "\${cur}"))
    return
  fi
  case "\${COMP_WORDS[1]}" in
${cases}
  esac
}
complete -F _pipeline_manager_completions pipeline-manager`);
          break;
        }
        case 'zsh': {
          const cases = Object.entries(subs)
            .map(([ns, leaves]) => `        ${ns}) _values 'subcommand' ${leaves.join(' ')};;`)
            .join('\n');
          console.log(`# pipeline-manager zsh completions
_pipeline_manager() {
  if (( CURRENT == 2 )); then
    _values 'command' ${topLevel.join(' ')}
    return
  fi
  case "\${words[2]}" in
${cases}
  esac
}
compdef _pipeline_manager pipeline-manager`);
          break;
        }
        case 'fish': {
          const lines = [
            `complete -c pipeline-manager -n '__fish_use_subcommand' -a '${topLevelStr}'`,
            ...Object.entries(subs).map(([ns, leaves]) =>
              `complete -c pipeline-manager -n '__fish_seen_subcommand_from ${ns}' -a '${leaves.join(' ')}'`),
          ];
          console.log(`# pipeline-manager fish completions\n${lines.join('\n')}`);
          break;
        }
        default:
          console.error(`Unknown shell: ${shell}. Use bash, zsh, or fish.`);
          process.exit(1);
      }
    });

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
      reason: reason instanceof Error ? reason.message: String(reason),
    });

    const error = reason instanceof Error ? reason: new Error(String(reason));

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
      error: error instanceof Error ? error.message: String(error),
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
          console.log(` • ${cmd.name()} - ${cmd.description()}`);
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
      error: error instanceof Error ? error.message: String(error),
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
 * Run CLI if executed directly. ESM has no `require.main`; compare the invoked
 * script to this module's path, resolving symlinks on both sides so the `bin`
 * symlink (node_modules/.bin/pipeline-manager → dist/cli.js) still matches.
 */
const invokedScript = process.argv[1];
const isMainModule = invokedScript !== undefined
  && realpathSync(invokedScript) === realpathSync(fileURLToPath(import.meta.url));
if (isMainModule) {
  // Parse CLI options from environment or command line
  const options: CliOptions = {
    debug: process.env.DEBUG === 'true',
    quiet: process.argv.includes('--quiet'),
    verbose: process.argv.includes('--verbose'),
    noColor: process.argv.includes('--no-color') || process.env.NO_COLOR === '1',
  };

  main(options);
}