import { execSync } from 'child_process';
import { Command } from 'commander';
import pico from 'picocolors';
import { APP_NAME, APP_VERSION, generateExecutionId } from '../config/cli.constants';
import { getConfig } from '../utils/config.loader';
import { ERROR_CODES, handleError } from '../utils/error.handler';
import { printDivider, printError, printInfo, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output.utils';

const { bold, cyan, dim, green, magenta, red, yellow } = pico;

/**
 * System information interface
 */
interface SystemInfo {
  nodejs: string;
  npm: string | null;
  platform: string;
  architecture: string;
  memory: {
    total: string;
    free: string;
  };
  uptime: string;
}

/**
 * CDK information interface
 */
interface CdkInfo {
  available: boolean;
  version: string | null;
  error?: string;
}

/**
 * Check if CDK is available and get version
 */
function checkCdk(): CdkInfo {
  try {
    const output = execSync('cdk --version', { encoding: 'utf-8', stdio: 'pipe' });
    const version = output.trim();
    return {
      available: true,
      version,
    };
  } catch (error) {
    return {
      available: false,
      version: null,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get Node.js version
 */
function getNodeVersion(): string {
  return process.version;
}

/**
 * Get npm version
 */
function getNpmVersion(): string | null {
  try {
    const output = execSync('npm --version', { encoding: 'utf-8', stdio: 'pipe' });
    return output.trim();
  } catch {
    return null;
  }
}

/**
 * Get system information
 */
function getSystemInfo(): SystemInfo {
  const totalMem = (process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2);
  const freeMem = ((process.memoryUsage().heapTotal - process.memoryUsage().heapUsed) / 1024 / 1024).toFixed(2);
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);

  return {
    nodejs: getNodeVersion(),
    npm: getNpmVersion(),
    platform: process.platform,
    architecture: process.arch,
    memory: {
      total: `${totalMem} MB`,
      free: `${freeMem} MB`,
    },
    uptime: `${hours}h ${minutes}m ${seconds}s`,
  };
}

/**
 * Check configuration status
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
 * Get environment variable status
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
 * Version command
 * Display CLI version and environment information
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

        // JSON output
        if (options.json) {
          const cdkInfo = checkCdk();
          const systemInfo = getSystemInfo();
          const configStatus = options.checkConfig ? checkConfiguration() : { valid: true };
          const envStatus = getEnvironmentStatus();

          const jsonOutput = {
            cli: {
              name: APP_NAME,
              version: APP_VERSION,
            },
            system: {
              nodejs: systemInfo.nodejs,
              npm: systemInfo.npm,
              platform: systemInfo.platform,
              architecture: systemInfo.architecture,
              memory: systemInfo.memory,
              uptime: systemInfo.uptime,
            },
            cdk: {
              available: cdkInfo.available,
              version: cdkInfo.version,
            },
            configuration: {
              valid: configStatus.valid,
              error: configStatus.error,
            },
            environment: envStatus,
            executionId,
            timestamp: new Date().toISOString(),
          };

          console.log(JSON.stringify(jsonOutput, null, 2));
          return;
        }

        // Standard output
        printSection('Version Information');
        console.log(`${magenta(`[EXE-${executionId}]`)} ${cyan(bold('CLI Version Check'))}`);
        console.log('');

        // CLI version
        printKeyValue({
          'CLI Name': bold(APP_NAME),
          'CLI Version': green(bold(APP_VERSION)),
        });

        printDivider();

        // Environment information
        if (options.verbose) {
          printSection('System Environment');

          const systemInfo = getSystemInfo();

          printKeyValue({
            'Node.js': systemInfo.nodejs,
            'npm': systemInfo.npm || yellow('(not available)'),
            'Platform': systemInfo.platform,
            'Architecture': systemInfo.architecture,
            'Memory (Heap)': `${systemInfo.memory.total} total, ${systemInfo.memory.free} free`,
            'Process Uptime': systemInfo.uptime,
          });

          printDivider();
        }

        // CDK information
        if (options.verbose) {
          printSection('AWS CDK');
        }

        const cdkInfo = checkCdk();

        if (cdkInfo.available && cdkInfo.version) {
          if (options.verbose) {
            printSuccess('AWS CDK is installed');
          }
          printKeyValue({
            'CDK Version': green(cdkInfo.version),
            'Status': green('✓ Available'),
          });
        } else {
          if (options.verbose) {
            printWarning('AWS CDK is not installed');
            console.log(dim('  💡 Tip: Install CDK with: npm install -g aws-cdk'));
            if (cdkInfo.error) {
              console.log(dim(`  Error: ${cdkInfo.error}`));
            }
          }
          printKeyValue({
            'AWS CDK': red('✗ Not installed'),
            'Status': red('✗ Not Available'),
          });
        }

        if (!options.verbose) {
          console.log(dim('\n  💡 Tip: Run with --verbose for detailed environment information'));
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
