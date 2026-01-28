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
 * Sort order types
 */
export type SortOrder = 'asc' | 'desc';

/**
 * Pipeline sort fields
 */
export type PipelineSortField = 'createdAt' | 'updatedAt' | 'pipelineName';

/**
 * Plugin sort fields
 */
export type PluginSortField = 'createdAt' | 'updatedAt' | 'name' | 'version';

/**
 * CDK approval requirements
 */
export type ApprovalType = 'never' | 'any-change' | 'broadening';

/**
 * Access modifier types
 */
export type AccessModifier = 'public' | 'private';

/**
 * Common CLI options
 */
export interface CommonOptions {
  /**
   * Output format (table, json, yaml, csv)
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
   * Verbose output
   */
  verbose?: boolean;

  /**
   * Organization name
   */
  organization?: string;

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

  /**
   * Disable SSL certificate verification (development only)
   */
  verifySsl?: boolean;

  /**
   * Dry run mode (validate without executing)
   */
  dryRun?: boolean;
}

/**
 * List command options
 */
export interface ListOptions extends CommonOptions {
  /**
   * Page number for pagination
   */
  page?: number;

  /**
   * Number of results per page
   */
  limit?: number;

  /**
   * Sort field
   */
  sortBy?: PipelineSortField | PluginSortField;

  /**
   * Sort order
   */
  sortOrder?: SortOrder;

  /**
   * Filter by active status
   */
  isActive?: boolean;

  /**
   * Filter by public status (plugins) or default status (pipelines)
   */
  isPublic?: boolean;
  isDefault?: boolean;

  /**
   * Project name filter (pipelines)
   */
  project?: string;

  /**
   * Plugin name filter
   */
  name?: string;

  /**
   * Search query (partial match)
   */
  search?: string;
}

/**
 * Valid CDK commands
 */
export const CDK_COMMANDS = ['synth', 'deploy'] as const;

export type CdkCommand = (typeof CDK_COMMANDS)[number];

/**
 * Default timeouts (in milliseconds)
 */
export const TIMEOUTS = {
  HTTP_REQUEST: 30000, // 30 seconds (matches config-loader default)
  CDK_COMMAND: 0, // No timeout
  HEALTH_CHECK: 5000, // 5 seconds
  UPLOAD: 300000, // 5 minutes for file uploads
} as const;

/**
 * File size limits (in bytes)
 */
export const FILE_SIZE_LIMITS = {
  PLUGIN: 100 * 1024 * 1024, // 100MB
  PIPELINE_PROPS: 10 * 1024 * 1024, // 10MB
} as const;

/**
 * Pagination defaults
 */
export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MIN_LIMIT: 1,
  MAX_LIMIT: 100,
} as const;

/**
 * Environment variable names
 */
export const ENV_VARS = {
  // Required
  PLATFORM_TOKEN: 'PLATFORM_TOKEN',

  // Optional
  PLATFORM_URL: 'PLATFORM_URL',
  CLI_CONFIG_PATH: 'CLI_CONFIG_PATH',
  NODE_TLS_REJECT_UNAUTHORIZED: 'NODE_TLS_REJECT_UNAUTHORIZED',

  // AWS
  AWS_PROFILE: 'AWS_PROFILE',
  AWS_REGION: 'AWS_REGION',

  // Debug
  DEBUG: 'DEBUG',
} as const;

/**
 * Validation patterns
 */
export const VALIDATION = {
  // ULID: 26 characters
  ULID_LENGTH: 26,
  // UUID: 36 characters
  UUID_LENGTH: 36,
  // Semantic version pattern
  VERSION_PATTERN: /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/,
  // Plugin name pattern (lowercase alphanumeric with dashes)
  PLUGIN_NAME_PATTERN: /^[a-z0-9-]+$/,
  // Organization name pattern
  ORG_NAME_PATTERN: /^[a-zA-Z0-9-_]+$/,
} as const;

/**
 * Check if debug mode is enabled
 */
export function isDebugMode(options?: CommonOptions): boolean {
  return options?.debug ?? process.env.DEBUG === 'true';
}

/**
 * Check if verbose mode is enabled
 */
export function isVerboseMode(options?: CommonOptions): boolean {
  return options?.verbose ?? false;
}

/**
 * Check if SSL verification should be disabled
 */
export function shouldDisableSslVerification(options?: CommonOptions): boolean {
  return (
    options?.verifySsl === false ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
  );
}

/**
 * Get effective page number
 */
export function getEffectivePage(page?: number): number {
  if (!page || page < PAGINATION.MIN_LIMIT) {
    return PAGINATION.DEFAULT_PAGE;
  }
  return page;
}

/**
 * Get effective limit with bounds checking
 */
export function getEffectiveLimit(limit?: number): number {
  if (!limit || limit < PAGINATION.MIN_LIMIT) {
    return PAGINATION.DEFAULT_LIMIT;
  }
  if (limit > PAGINATION.MAX_LIMIT) {
    return PAGINATION.MAX_LIMIT;
  }
  return limit;
}

/**
 * Validate semantic version format
 */
export function isValidVersion(version: string): boolean {
  return VALIDATION.VERSION_PATTERN.test(version);
}

/**
 * Validate plugin name format
 */
export function isValidPluginName(name: string): boolean {
  return VALIDATION.PLUGIN_NAME_PATTERN.test(name);
}

/**
 * Validate organization name format
 */
export function isValidOrganizationName(org: string): boolean {
  return VALIDATION.ORG_NAME_PATTERN.test(org);
}

/**
 * Validate plugin ID format (ULID or UUID)
 */
export function isValidPluginId(id: string): boolean {
  return (
    id.length === VALIDATION.ULID_LENGTH || id.length === VALIDATION.UUID_LENGTH
  );
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
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = (ms / 1000).toFixed(2);
  if (ms < 60000) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(ms / 60000);
  const remainingSeconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Generate execution ID
 */
export function generateExecutionId(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
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
  style: {
    head: ['cyan', 'bold'],
    border: ['dim'],
  },
  wordWrap: true,
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
 * Command categories for help organization
 */
export const COMMAND_CATEGORIES = {
  PIPELINE: 'Pipeline Commands',
  PLUGIN: 'Plugin Commands',
  UTILITY: 'Utility Commands',
  CONFIGURATION: 'Configuration Commands',
} as const;

/**
 * Success messages
 */
export const MESSAGES = {
  SUCCESS: {
    PIPELINE_CREATED: 'Pipeline created successfully',
    PIPELINE_RETRIEVED: 'Pipeline retrieved successfully',
    PLUGIN_UPLOADED: 'Plugin uploaded successfully',
    PLUGIN_RETRIEVED: 'Plugin retrieved successfully',
    CONFIG_LOADED: 'Configuration loaded successfully',
    AUTH_VALID: 'Authentication validated',
  },
  ERROR: {
    NO_TOKEN: 'PLATFORM_TOKEN environment variable is required',
    INVALID_FILE: 'Invalid file path or format',
    NETWORK_ERROR: 'Network error occurred',
    API_ERROR: 'API request failed',
    CONFIG_ERROR: 'Configuration error',
  },
  WARNING: {
    SSL_DISABLED: 'SSL certificate verification is DISABLED',
    LARGE_FILE: 'File size is large - upload may take time',
    NO_RESULTS: 'No results found matching criteria',
  },
  INFO: {
    DRY_RUN: 'Dry run mode - no changes will be made',
    DEVELOPMENT_MODE: 'This should only be used in development',
    CHECK_CONFIG: 'Run with --check-config to verify configuration',
  },
} as const;

/**
 * Help text snippets
 */
export const HELP_TEXT = {
  SSL_VERIFICATION: 'Disable SSL certificate verification (development only)',
  DRY_RUN: 'Validate inputs without executing the action',
  VERBOSE: 'Show detailed information',
  DEBUG: 'Enable debug output',
  OUTPUT_FORMAT: 'Output format: table, json, yaml, or csv',
  PAGINATION: 'Page number for pagination (default: 1)',
  LIMIT: 'Number of results per page (default: 20, max: 100)',
  SORT_ORDER: 'Sort order: asc or desc',
  ORGANIZATION: 'Organization name',
  PROJECT: 'Project name',
} as const;

/**
 * API endpoint paths (relative to base URL)
 */
export const API_ENDPOINTS = {
  // Pipelines
  PIPELINE: '/api/pipeline',
  PIPELINES: '/api/pipelines',
  PIPELINE_CREATE: '/api/pipeline',

  // Plugins
  PLUGIN: '/api/plugin',
  PLUGINS: '/api/plugins',
  PLUGIN_UPLOAD: '/api/plugin/upload',

  // Health
  HEALTH: '/health',
  READY: '/ready',
} as const;
