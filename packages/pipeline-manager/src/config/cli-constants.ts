import { version } from '../../package.json';

/**
 * Application metadata
 */
export const APP_NAME = 'pipeline-manager';
export const APP_VERSION = version;
export const APP_DESCRIPTION = 'A CLI tool to manage pipelines and plugins';

/**
 * Banner configuration for CLI startup
 */
export const BANNER_OPTIONS = {
  font: 'Doom' as const,
  horizontalLayout: 'fitted' as const,
  getWidth: () => process.stdout.columns ?? 80,
} as const;

/**
 * Output format types
 */
export type OutputFormat = 'table' | 'json' | 'yaml';

/**
 * CDK approval requirements
 */
export type ApprovalType = boolean | 'never' | 'auto';

/**
 * Common CLI options
 */
export interface CommonOptions {
  /**
   * Output format (table, json, yaml)
   */
  format?: OutputFormat;

  /**
   * Run CDK synth before deploy
   */
  synth?: boolean;

  /**
   * Enable debug mode
   */
  debug?: boolean;

  /**
   * Organization ID (for query commands that support flag)
   */
  orgId?: string;

  /**
   * CDK approval requirement
   */
  requireApproval?: ApprovalType;

  /**
   * AWS profile to use
   */
  profile?: string;

  /**
   * Output file path
   */
  output?: string;
}

/**
 * Valid CDK commands
 */
export const CDK_COMMANDS = ['synth', 'deploy'] as const;

export type CdkCommand = typeof CDK_COMMANDS[number];

/**
 * Default timeouts (in milliseconds)
 */
export const TIMEOUTS = {
  HTTP_REQUEST: 30000, // 30 seconds (matches config-loader default)
  CDK_COMMAND: 0, // No timeout
  HEALTH_CHECK: 5000, // 5 seconds
} as const;

/**
 * Environment variable names
 */
export const ENV_VARS = {
  CLI_CONFIG_PATH: 'CLI_CONFIG_PATH',
  AWS_PROFILE: 'AWS_PROFILE',
  AWS_REGION: 'AWS_REGION',
  DEBUG: 'DEBUG',
} as const;

/**
 * Check if debug mode is enabled
 */
export function isDebugMode(options?: CommonOptions): boolean {
  return options?.debug ?? process.env.DEBUG === 'true';
}

/**
 * Table display options
 */
export const TABLE_OPTIONS = {
  border: {
    topBody: '─',
    topJoin: '┬',
    topLeft: '┌',
    topRight: '┐',
    bottomBody: '─',
    bottomJoin: '┴',
    bottomLeft: '└',
    bottomRight: '┘',
    bodyLeft: '│',
    bodyRight: '│',
    bodyJoin: '│',
    joinBody: '─',
    joinLeft: '├',
    joinRight: '┤',
    joinJoin: '┼',
  },
} as const;