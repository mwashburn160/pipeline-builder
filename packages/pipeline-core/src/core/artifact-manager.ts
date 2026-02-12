import { CodeBuildStep, ShellStep } from 'aws-cdk-lib/pipelines';

export interface ArtifactKey {
  readonly stageName: string;
  readonly stageAlias: string;
  readonly pluginName: string;
  readonly pluginAlias: string;
}

/**
 * Manages build step artifacts with hierarchical key-based lookup.
 * Keys follow the pattern: stageName:stageAlias:pluginName:pluginAlias:primary
 */
export class ArtifactManager {
  private readonly artifacts: Map<string, CodeBuildStep | ShellStep> = new Map();

  /**
   * Generate a key string from artifact parameters
   */
  private generateKey(params: ArtifactKey, suffix: string): string {
    const { stageName, stageAlias, pluginName, pluginAlias } = params;
    return `${stageName}:${stageAlias}:${pluginName}:${pluginAlias}:${suffix}`;
  }

  /**
   * Add a build step artifact
   * @param key - The hierarchical key identifying this artifact
   * @param step - The CodeBuildStep or ShellStep to store
   */
  add(key: ArtifactKey, step: CodeBuildStep | ShellStep, suffix: string): void {
    const artifactKey = this.generateKey(key, suffix);
    this.artifacts.set(artifactKey, step);
  }

  /**
   * Get a build step artifact by key
   * @param key - The hierarchical key identifying the artifact
   * @param suffix - The suffix to append to the key
   * @returns The stored step, or undefined if not found
   */
  get(key: ArtifactKey, suffix: string): CodeBuildStep | ShellStep | undefined {
    const artifactKey = this.generateKey(key, suffix);
    return this.artifacts.get(artifactKey);
  }

  /**
   * List all artifact keys
   * @returns Array of all stored artifact key strings
   */
  list(): string[] {
    return Array.from(this.artifacts.keys());
  }
}
