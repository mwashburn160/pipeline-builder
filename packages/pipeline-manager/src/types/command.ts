/**
 * CLI command option type definitions.
 *
 * Each interface maps to the parsed options object produced by
 * Commander for a specific CLI sub-command.
 *
 * Note: Unused interfaces (CommandContext, CommandResult, DeleteOptions,
 * SpinnerOptions, GlobalOptions, ProgressOptions, and duplicate OutputFormat/
 * TableColumn definitions) were removed during cleanup. Re-add as needed.
 *
 * @module types/command
 */

/**
 * Parsed options for the `deploy` CLI command.
 */
export interface DeployOptions {
  /** Pipeline ID to deploy. */
  id: string;
  /** AWS CLI profile name. */
  profile?: string;
  /** CDK approval level for security-sensitive changes. */
  requireApproval?: 'never' | 'any-change' | 'broadening';
  /** CDK output directory for synthesized templates. */
  output?: string;
  /** When `true`, run synthesis only without deploying. */
  synth?: boolean;
  /** Disable SSL certificate verification for the API request. */
  noVerifySsl?: boolean;
  /** Enable verbose debug output. */
  debug?: boolean;
}

/**
 * Parsed options for the `create-pipeline` CLI command.
 */
export interface CreatePipelineOptions {
  /** Target project name. */
  project: string;
  /** Target organization name. */
  organization: string;
  /** Path to the pipeline properties JSON file. */
  file: string;
  /** Optional human-readable pipeline name. */
  name?: string;
  /** Pipeline visibility. */
  access?: 'public' | 'private';
  /** Mark the pipeline as the default for its project. */
  default?: boolean;
  /** Mark the pipeline as active. */
  active?: boolean;
  /** Disable SSL certificate verification for the API request. */
  noVerifySsl?: boolean;
  /** Validate inputs without creating the pipeline. */
  dryRun?: boolean;
  /** Enable verbose debug output. */
  debug?: boolean;
}

/**
 * Parsed options for the `upload-plugin` CLI command.
 */
export interface UploadPluginOptions {
  /** Organization that will own the uploaded plugin. */
  organization: string;
  /** Path to the plugin ZIP archive. */
  file: string;
  /** Plugin name override (auto-detected from package if omitted). */
  name?: string;
  /** Plugin version override (auto-detected from package if omitted). */
  version?: string;
  /** Make the plugin publicly accessible. */
  public?: boolean;
  /** Mark the plugin as active upon upload. */
  active?: boolean;
  /** Disable SSL certificate verification for the API request. */
  noVerifySsl?: boolean;
  /** Enable verbose debug output. */
  debug?: boolean;
}
