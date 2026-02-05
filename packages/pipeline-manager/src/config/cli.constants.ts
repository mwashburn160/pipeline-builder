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
export type OutputFormat = 'table' | 'json' | 'yaml' | 'csv';

/**
 * Valid CDK commands
 */
export type CdkCommand = 'synth' | 'deploy';

/**
 * Default timeouts (in milliseconds)
 */
export const TIMEOUTS = {
  HTTP_REQUEST: 30000,
  CDK_COMMAND: 0,
  HEALTH_CHECK: 5000,
  UPLOAD: 300000,
} as const;

/**
 * File size limits (in bytes)
 */
export const FILE_SIZE_LIMITS = {
  PLUGIN: 100 * 1024 * 1024, // 100MB
  PIPELINE_PROPS: 10 * 1024 * 1024, // 10MB
} as const;

/**
 * Environment variable names
 */
export const ENV_VARS = {
  PLATFORM_TOKEN: 'PLATFORM_TOKEN',
  PLATFORM_BASE_URL: 'PLATFORM_BASE_URL',
  CLI_CONFIG_PATH: 'CLI_CONFIG_PATH',
  TLS_REJECT_UNAUTHORIZED: 'TLS_REJECT_UNAUTHORIZED',
  AWS_PROFILE: 'AWS_PROFILE',
  AWS_REGION: 'AWS_REGION',
  DEBUG: 'DEBUG',
} as const;

/**
 * Check if debug mode is enabled
 */
export function isDebugMode(options?: { debug?: boolean }): boolean {
  return options?.debug ?? process.env.DEBUG === 'true';
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
}

/**
 * Format duration for display
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  const minutes = Math.floor(ms / 60000);
  const remainingSeconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Generate execution ID for request tracing
 */
export function generateExecutionId(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

/**
 * Table display options (box-drawing characters)
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

/**
 * Color scheme for status indicators
 */
export const STATUS_COLORS = {
  success: 'green',
  error: 'red',
  warning: 'yellow',
  info: 'cyan',
  debug: 'magenta',
} as const;

/**
 * Validate boolean string from CLI input
 */
export function validateBoolean(value: string, fieldName: string): boolean {
  const normalized = value.toLowerCase().trim();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value for ${fieldName}: "${value}". Use true/false, yes/no, or 1/0.`);
}
