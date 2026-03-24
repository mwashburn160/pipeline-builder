import { CodeBuildStep, FileSet, ShellStep } from 'aws-cdk-lib/pipelines';

export interface ArtifactKey {
  readonly stageName: string;
  readonly stageAlias: string;
  readonly pluginName: string;
  readonly pluginAlias: string;
  readonly outputDirectory: string;
}

/**
 * Manages build step artifacts with hierarchical key-based lookup.
 * Keys follow the pattern: stageName:stageAlias:pluginName:pluginAlias:outputDirectory
 *
 * @example
 * ```typescript
 * // Synth step: "no-stage:no-stage-alias:cdk-synth:cdk-synth-alias:cdk.out"
 * // Build step: "build:build-alias:nodejs-build:nodejs-build-alias:dist"
 * ```
 */
export class ArtifactManager {
  private readonly artifacts: Map<string, CodeBuildStep | ShellStep> = new Map();

  /**
   * Generate a key string from artifact parameters
   */
  private generateKey(key: ArtifactKey): string {
    return `${key.stageName}:${key.stageAlias}:${key.pluginName}:${key.pluginAlias}:${key.outputDirectory}`;
  }

  /**
   * Register a build step artifact
   * @param key - The hierarchical key identifying this artifact (includes output directory)
   * @param step - The CodeBuildStep or ShellStep to store
   */
  add(key: ArtifactKey, step: CodeBuildStep | ShellStep): void {
    this.artifacts.set(this.generateKey(key), step);
  }

  /**
   * Get a build step by its artifact key
   * @param key - The hierarchical key identifying the artifact
   * @returns The stored step, or undefined if not found
   */
  get(key: ArtifactKey): CodeBuildStep | ShellStep | undefined {
    return this.artifacts.get(this.generateKey(key));
  }

  /**
   * Get the primary output FileSet from a registered step.
   * @param key - The artifact key identifying the step
   * @returns The primary output FileSet
   * @throws Error if the step is not found or has no primary output
   */
  getOutput(key: ArtifactKey): FileSet {
    const step = this.require(key);
    const output = step.primaryOutput;
    if (!output) {
      throw new Error(`Step '${key.pluginName}' has no primary output`);
    }
    return output;
  }

  /**
   * Register an additional output directory on a stored step and return its FileSet.
   * Calls CDK's addOutputDirectory() to create a named output beyond the primary.
   * @param key - The artifact key identifying the step
   * @param directory - The additional output directory path to register
   * @returns The FileSet for the additional output directory
   * @throws Error if the step is not found
   */
  addOutput(key: ArtifactKey, directory: string): FileSet {
    return this.require(key).addOutputDirectory(directory);
  }

  /**
   * Get a step by key or throw with a helpful error listing available artifacts.
   */
  private require(key: ArtifactKey): CodeBuildStep | ShellStep {
    const step = this.get(key);
    if (!step) {
      const registered = this.list();
      const available = registered.length > 0 ? ` Available: [${registered.join(', ')}]` : ' No artifacts registered.';
      throw new Error(`No artifact registered for "${this.generateKey(key)}".${available}`);
    }
    return step;
  }

  /**
   * List all artifact keys
   * @returns Array of all stored artifact key strings
   */
  list(): string[] {
    return Array.from(this.artifacts.keys());
  }
}
