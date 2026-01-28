/**
 * CLI command type definitions
 */

/**
 * Command execution context
 */
export interface CommandContext {
  /**
   * Execution ID for tracking
   */
  executionId: string;

  /**
   * Command name
   */
  command: string;

  /**
   * Command arguments
   */
  args: string[];

  /**
   * Command options
   */
  options: Record<string, unknown>;

  /**
   * Debug mode enabled
   */
  debug: boolean;

  /**
   * Start time of execution
   */
  startTime: number;

  /**
   * User who executed the command (if available)
   */
  userId?: string;
}

/**
 * Command execution result
 */
export interface CommandResult {
  /**
   * Whether command succeeded
   */
  success: boolean;

  /**
   * Execution ID
   */
  executionId: string;

  /**
   * Execution duration in milliseconds
   */
  duration: number;

  /**
   * Result data (if any)
   */
  data?: unknown;

  /**
   * Error (if failed)
   */
  error?: Error;

  /**
   * Exit code
   */
  exitCode: number;
}

/**
 * Deploy command options
 */
export interface DeployOptions {
  /**
   * Pipeline ID to deploy
   */
  id: string;

  /**
   * AWS profile to use
   * @default 'default'
   */
  profile?: string;

  /**
   * CDK approval level
   * @default 'never'
   */
  requireApproval?: 'never' | 'any-change' | 'broadening';

  /**
   * CDK output directory
   * @default 'cdk.out'
   */
  output?: string;

  /**
   * Run synthesis only (skip deployment)
   * @default false
   */
  synth?: boolean;

  /**
   * Disable SSL certificate verification
   * @default false
   */
  noVerifySsl?: boolean;

  /**
   * Debug mode
   * @default false
   */
  debug?: boolean;
}

/**
 * Create pipeline command options
 */
export interface CreatePipelineOptions {
  /**
   * Project name
   */
  project: string;

  /**
   * Organization name
   */
  organization: string;

  /**
   * Path to pipeline properties JSON file
   */
  file: string;

  /**
   * Pipeline name (optional)
   */
  name?: string;

  /**
   * Access modifier
   * @default 'private'
   */
  access?: 'public' | 'private';

  /**
   * Set as default pipeline
   * @default false
   */
  default?: boolean;

  /**
   * Set pipeline as active
   * @default true
   */
  active?: boolean;

  /**
   * Disable SSL certificate verification
   * @default false
   */
  noVerifySsl?: boolean;

  /**
   * Dry run mode (validate without creating)
   * @default false
   */
  dryRun?: boolean;

  /**
   * Debug mode
   * @default false
   */
  debug?: boolean;
}

/**
 * List pipelines command options
 */
export interface ListPipelinesOptions {
  /**
   * Filter by project name
   */
  project?: string;

  /**
   * Filter by organization name
   */
  organization?: string;

  /**
   * Filter by active status
   */
  active?: boolean;

  /**
   * Filter by default status
   */
  default?: boolean;

  /**
   * Output format
   * @default 'table'
   */
  format?: 'table' | 'json' | 'yaml' | 'csv';

  /**
   * Page number
   * @default 1
   */
  page?: number;

  /**
   * Items per page
   * @default 20
   */
  limit?: number;

  /**
   * Disable SSL certificate verification
   * @default false
   */
  noVerifySsl?: boolean;

  /**
   * Debug mode
   * @default false
   */
  debug?: boolean;
}

/**
 * Upload plugin command options
 */
export interface UploadPluginOptions {
  /**
   * Organization name
   */
  organization: string;

  /**
   * Path to plugin file
   */
  file: string;

  /**
   * Plugin name (optional, can be extracted from file)
   */
  name?: string;

  /**
   * Plugin version (optional, can be extracted from file)
   */
  version?: string;

  /**
   * Make plugin public
   * @default false
   */
  public?: boolean;

  /**
   * Set plugin as active
   * @default true
   */
  active?: boolean;

  /**
   * Disable SSL certificate verification
   * @default false
   */
  noVerifySsl?: boolean;

  /**
   * Debug mode
   * @default false
   */
  debug?: boolean;
}

/**
 * Delete command options
 */
export interface DeleteOptions {
  /**
   * Resource ID to delete
   */
  id: string;

  /**
   * Force deletion without confirmation
   * @default false
   */
  force?: boolean;

  /**
   * Disable SSL certificate verification
   * @default false
   */
  noVerifySsl?: boolean;

  /**
   * Debug mode
   * @default false
   */
  debug?: boolean;
}

/**
 * Output format type
 */
export type OutputFormat = 'table' | 'json' | 'yaml' | 'csv' | 'pretty';

/**
 * Table column definition
 */
export interface TableColumn {
  /**
   * Column header
   */
  header: string;

  /**
   * Column key (property name)
   */
  key: string;

  /**
   * Column width (optional)
   */
  width?: number;

  /**
   * Column alignment
   * @default 'left'
   */
  align?: 'left' | 'center' | 'right';

  /**
   * Value formatter
   */
  formatter?: (value: any) => string;
}

/**
 * Progress indicator options
 */
export interface ProgressOptions {
  /**
   * Total number of steps
   */
  total: number;

  /**
   * Progress bar width
   * @default 40
   */
  width?: number;

  /**
   * Show percentage
   * @default true
   */
  showPercentage?: boolean;

  /**
   * Show ETA
   * @default true
   */
  showEta?: boolean;

  /**
   * Show current/total count
   * @default true
   */
  showCount?: boolean;

  /**
   * Custom format string
   */
  format?: string;
}

/**
 * Spinner options
 */
export interface SpinnerOptions {
  /**
   * Spinner text
   */
  text: string;

  /**
   * Spinner color
   */
  color?: 'cyan' | 'green' | 'yellow' | 'red' | 'blue' | 'magenta';

  /**
   * Spinner interval in milliseconds
   * @default 80
   */
  interval?: number;
}

/**
 * Command global options
 */
export interface GlobalOptions {
  /**
   * Enable debug mode
   */
  debug?: boolean;

  /**
   * Verbose output
   */
  verbose?: boolean;

  /**
   * Quiet mode (minimal output)
   */
  quiet?: boolean;

  /**
   * Output format
   */
  format?: OutputFormat;

  /**
   * Config file path
   */
  config?: string;

  /**
   * Disable colors
   */
  noColor?: boolean;

  /**
   * Enable timestamps in logs
   */
  timestamps?: boolean;
}
