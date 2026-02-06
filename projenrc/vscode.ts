/**
 * VSCode Workspace Settings Configuration
 *
 * This module generates `.vscode/settings.json` with monorepo-specific
 * settings for Visual Studio Code.
 *
 * Key Features:
 * - Configures ESLint to work correctly in a monorepo structure
 * - Sets up working directories for each package
 * - Ensures linting works independently per package
 *
 * The working directories pattern allows ESLint to:
 * - Find the correct .eslintrc.json for each package
 * - Resolve dependencies relative to each package root
 * - Provide accurate linting results per package
 *
 * @see https://code.visualstudio.com/docs/getstarted/settings
 * @see https://github.com/microsoft/vscode-eslint#mono-repository-setup
 */

import path from 'path';
import { Component, JsonFile, Project } from 'projen';

/**
 * VSCode settings component for monorepo configuration.
 *
 * Automatically generates workspace settings that enable proper
 * ESLint integration for each package in the monorepo.
 *
 * @example
 * ```typescript
 * // In .projenrc.ts
 * new VscodeSettings(root);
 * ```
 */
export class VscodeSettings extends Component {
  /**
   * Creates VSCode workspace settings.
   *
   * @param root - The root project containing all subprojects
   */
  constructor(root: Project) {
    super(root);

    // Generate .vscode/settings.json with ESLint working directories
    new JsonFile(root, '.vscode/settings.json', {
      obj: {
        // Configure ESLint to lint each package independently
        'eslint.workingDirectories':
          root.subprojects.map(project => ({
            // Use pattern matching for each package directory
            pattern: path.relative(
              root.outdir, project.outdir
            ),
          })),
      },
    });
  }
}