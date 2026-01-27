import { execSync } from 'child_process';
import { Command } from 'commander';
import pico from 'picocolors';
import { APP_NAME, APP_VERSION } from '../config/cli-constants';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { printDivider, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output-utils';

const { bold, cyan, dim, magenta } = pico;

/**
 * Check if CDK is available
 */
function checkCdkAvailable(): boolean {
  try {
    execSync('cdk --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get CDK version
 */
function getCdkVersion(): string | null {
  try {
    const output = execSync('cdk --version', { encoding: 'utf-8' });
    return output.trim();
  } catch {
    return null;
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
    const output = execSync('npm --version', { encoding: 'utf-8' });
    return output.trim();
  } catch {
    return null;
  }
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
    .action((options) => {
      try {
        const executionId = Math.random().toString(36).substring(7).toUpperCase();

        printSection('Version Information');
        console.log(`${magenta(`[${executionId}]`)} ${cyan(bold('CLI Version Check'))}\n`);

        // CLI version
        printKeyValue({
          'CLI Name': APP_NAME,
          'CLI Version': APP_VERSION,
        });

        printDivider();

        // Environment information
        if (options.verbose) {
          printSection('Environment');

          const nodeVersion = getNodeVersion();
          const npmVersion = getNpmVersion();
          const cdkAvailable = checkCdkAvailable();
          const cdkVersion = cdkAvailable ? getCdkVersion() : null;

          printKeyValue({
            'Node.js': nodeVersion,
            'npm': npmVersion || '(not available)',
            'Platform': process.platform,
            'Architecture': process.arch,
          });

          printDivider();

          // CDK information
          printSection('AWS CDK');

          if (cdkAvailable && cdkVersion) {
            printSuccess('AWS CDK is installed');
            printKeyValue({
              'CDK Version': cdkVersion,
              'Status': '✓ Available',
            });
          } else {
            printWarning('AWS CDK is not installed');
            console.log(dim('  💡 Tip: Install CDK with: npm install -g aws-cdk'));
            printKeyValue({
              Status: '✗ Not Available',
            });
          }
        } else {
          // Quick CDK check in non-verbose mode
          const cdkAvailable = checkCdkAvailable();
          const cdkVersion = cdkAvailable ? getCdkVersion() : null;

          if (cdkAvailable && cdkVersion) {
            printKeyValue({
              'AWS CDK': `✓ ${cdkVersion}`,
            });
          } else {
            printKeyValue({
              'AWS CDK': '✗ Not installed',
            });
            console.log(dim('\n  💡 Tip: Run with --verbose for more details'));
          }
        }

        printDivider();
        console.log(dim(`  Execution ID: ${executionId}`));
        console.log(dim(`  Timestamp: ${new Date().toISOString()}`));

      } catch (error) {
        handleError(error, ERROR_CODES.GENERAL, {
          debug: program.opts().debug,
          exit: true,
          context: {
            command: 'version',
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