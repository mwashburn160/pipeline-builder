// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { execSync } from 'child_process';
import { Command } from 'commander';
import pico from 'picocolors';
import { APP_NAME, APP_VERSION, generateExecutionId } from '../config/cli.constants';
import { getCdkInfo } from '../utils/cdk-utils';
import { getConfig } from '../utils/config-loader';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { printDivider, printError, printInfo, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output-utils';

const { bold, cyan, dim, green, magenta, red, yellow } = pico;

/**
 * Runtime system information collected for the `version --verbose` output.
 */
interface SystemInfo {
  nodejs: string;
  npm: string | null;
  platform: string;
  architecture: string;
  memory: {
    total: string;
    availableHeap: string;
  };
  uptime: string;
}

/**
 * Collects runtime system information including Node.js/npm versions,
 * platform, architecture, heap memory usage, and process uptime.
 */
function getSystemInfo(): SystemInfo {
  const mem = process.memoryUsage();
  const totalMem = (mem.heapTotal / 1024 / 1024).toFixed(2);
  const availableHeap = ((mem.heapTotal - mem.heapUsed) / 1024 / 1024).toFixed(2);
  const uptime = process.uptime();

  let npm: string | null;
  try {
    npm = execSync('npm --version', { encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    npm = null;
  }

  return {
    nodejs: process.version,
    npm,
    platform: process.platform,
    architecture: process.arch,
    memory: { total: `${totalMem} MB`, availableHeap: `${availableHeap} MB` },
    uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`,
  };
}

/**
 * Attempts to load the CLI configuration and reports whether it is valid.
 * @returns An object with `valid: true` on success, or `valid: false` with an error message.
 */
function checkConfiguration(): { valid: boolean; error?: string } {
  try {
    getConfig();
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Checks which key environment variables are currently set.
 * @returns Presence flags for `PLATFORM_TOKEN`, `PLATFORM_BASE_URL`, and `CLI_CONFIG_PATH`.
 */
function getEnvironmentStatus(): {
  token: boolean;
  url: boolean;
  configPath: boolean;
} {
  return {
    token: !!process.env.PLATFORM_TOKEN,
    url: !!process.env.PLATFORM_BASE_URL,
    configPath: !!process.env.CLI_CONFIG_PATH,
  };
}

/**
 * Registers the `version` command with the CLI program.
 *
 * Displays the CLI name/version, AWS CDK status, and optionally
 * full system diagnostics (`--verbose`) or configuration validation
 * (`--check-config`).  Supports `--json` for machine-readable output.
 *
 * @param program - The root Commander program instance to attach the command to.
 */
export function version(program: Command): void {
  program
    .command('version')
    .description('Display CLI version and environment information')
    .option('--verbose', 'Show detailed environment information', false)
    .option('--check-config', 'Verify configuration status', false)
    .option('--json', 'Output in JSON format', false)
    .action((options) => {
      try {
        const executionId = generateExecutionId();
        const cdkInfo = getCdkInfo();

        // JSON output
        if (options.json) {
          const systemInfo = getSystemInfo();
          const configStatus = options.checkConfig ? checkConfiguration() : { valid: true };
          const envStatus = getEnvironmentStatus();

          console.log(JSON.stringify({
            cli: { name: APP_NAME, version: APP_VERSION },
            system: systemInfo,
            cdk: { available: cdkInfo.available, version: cdkInfo.version },
            configuration: { valid: configStatus.valid, error: configStatus.error },
            environment: envStatus,
            executionId,
            timestamp: new Date().toISOString(),
          }, null, 2));
          return;
        }

        // Standard output
        printSection('Version Information');
        console.log(`${magenta(`[EXE-${executionId}]`)} ${cyan(bold('CLI Version Check'))}`);
        console.log('');

        printKeyValue({
          'CLI Name': bold(APP_NAME),
          'CLI Version': green(bold(APP_VERSION)),
        });

        printDivider();

        // Verbose: system environment
        if (options.verbose) {
          printSection('System Environment');
          const systemInfo = getSystemInfo();
          printKeyValue({
            'Node.js': systemInfo.nodejs,
            'npm': systemInfo.npm || yellow('(not available)'),
            'Platform': systemInfo.platform,
            'Architecture': systemInfo.architecture,
            'Memory (Heap)': `${systemInfo.memory.total} total, ${systemInfo.memory.availableHeap} available`,
            'Process Uptime': systemInfo.uptime,
          });
          printDivider();
          printSection('AWS CDK');
        }

        // CDK information
        if (cdkInfo.available && cdkInfo.version) {
          if (options.verbose) printSuccess('AWS CDK is installed');
          printKeyValue({
            'CDK Version': green(cdkInfo.version),
            'Status': green('✓ Available'),
          });
        } else {
          if (options.verbose) {
            printWarning('AWS CDK is not installed');
            console.log(dim('  Install CDK with: npm install -g aws-cdk'));
            if (cdkInfo.error) console.log(dim(`  Error: ${cdkInfo.error}`));
          }
          printKeyValue({
            'AWS CDK': red('✗ Not installed'),
            'Status': red('✗ Not Available'),
          });
        }

        if (!options.verbose) {
          console.log(dim('\n  Run with --verbose for detailed environment information'));
        }

        // Configuration check
        if (options.checkConfig) {
          printDivider();
          printSection('Configuration Status');

          const configStatus = checkConfiguration();
          const envStatus = getEnvironmentStatus();

          if (configStatus.valid) {
            printSuccess('Configuration is valid');

            try {
              const config = getConfig();
              printKeyValue({
                'API Base URL': config.api.baseUrl,
                'SSL Verification': config.api.rejectUnauthorized ? green('Enabled') : yellow('Disabled'),
                'Timeout': `${config.api.timeout}ms`,
                'Authenticated': config.auth.token ? green('Yes') : red('No'),
              });
            } catch (error) {
              printWarning('Could not load full configuration');
            }
          } else {
            printError('Configuration is invalid');
            if (configStatus.error) {
              console.log(red(`  Error: ${configStatus.error}`));
            }
          }

          console.log('');
          printInfo('Environment Variables');
          printKeyValue({
            PLATFORM_TOKEN: envStatus.token ? green('✓ Set') : red('✗ Not set'),
            PLATFORM_BASE_URL: envStatus.url ? green('✓ Set') : dim('(not set - using default)'),
            CLI_CONFIG_PATH: envStatus.configPath ? green('✓ Set') : dim('(not set - using default)'),
          });

          if (!envStatus.token) {
            console.log('');
            printWarning('PLATFORM_TOKEN is required for API operations');
            console.log(dim('  Set it with: export PLATFORM_TOKEN="your-token-here"'));
          }
        } else {
          console.log(dim('\n  💡 Tip: Run with --check-config to verify configuration'));
        }

        // Footer
        printDivider();
        console.log(dim(`  Execution ID: ${executionId}`));
        console.log(dim(`  Timestamp: ${new Date().toISOString()}`));
        console.log('');

      } catch (error) {
        handleError(error, ERROR_CODES.GENERAL, {
          debug: program.opts().debug,
          exit: true,
          context: {
            command: 'version',
            options: {
              verbose: options.verbose,
              checkConfig: options.checkConfig,
              json: options.json,
            },
          },
        });
      }
    });

  // Also support -v and --version flags at root level
  program.on('option:version', () => {
    console.log(`${APP_NAME} v${APP_VERSION}`);
    process.exit(0);
  });
}
