/**
 * CLI command type definitions
 *
 * Note: Unused interfaces (CommandContext, CommandResult, DeleteOptions,
 * SpinnerOptions, GlobalOptions, ProgressOptions, and duplicate OutputFormat/
 * TableColumn definitions) were removed during cleanup. Re-add as needed.
 */

/**
 * Deploy command options
 */
export interface DeployOptions {
  id: string;
  profile?: string;
  requireApproval?: 'never' | 'any-change' | 'broadening';
  output?: string;
  synth?: boolean;
  noVerifySsl?: boolean;
  debug?: boolean;
}

/**
 * Create pipeline command options
 */
export interface CreatePipelineOptions {
  project: string;
  organization: string;
  file: string;
  name?: string;
  access?: 'public' | 'private';
  default?: boolean;
  active?: boolean;
  noVerifySsl?: boolean;
  dryRun?: boolean;
  debug?: boolean;
}

/**
 * Upload plugin command options
 */
export interface UploadPluginOptions {
  organization: string;
  file: string;
  name?: string;
  version?: string;
  public?: boolean;
  active?: boolean;
  noVerifySsl?: boolean;
  debug?: boolean;
}
