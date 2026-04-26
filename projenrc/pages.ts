// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * GitHub Pages deployment workflow.
 *
 * Replaces GitHub Pages' implicit auto-deploy (which still uses
 * actions/checkout@v4 and actions/upload-artifact@v4 — both deprecated for
 * Node 20). All actions below are pinned to versions that run on Node 24.
 *
 * Setup (one-time): Settings → Pages → Build and deployment → Source =
 * "GitHub Actions" so this workflow becomes the deployment source.
 *
 * Workflow Architecture:
 * 1. **build**: Checkout repo, configure Pages, build Jekyll site, upload artifact.
 * 2. **deploy**: Take the artifact and deploy to the github-pages environment.
 *
 * @see https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
 */

import { Component } from 'projen';
import { GithubWorkflow } from 'projen/lib/github';
import { JobPermission } from 'projen/lib/github/workflows-model';
import { TypeScriptProject } from 'projen/lib/typescript';

/**
 * GitHub Actions workflow component for the Jekyll site on GitHub Pages.
 *
 * @example
 * ```typescript
 * // In .projenrc.ts
 * new Pages(root);
 * ```
 */
export class Pages extends Component {
  constructor(root: TypeScriptProject) {
    super(root);

    const workflow = new GithubWorkflow(root.github!, 'pages');

    // Trigger on pushes to main + manual run from the Actions tab.
    workflow.on({
      push: { branches: ['main'] },
      workflowDispatch: {},
    });

    // Allow only one concurrent deployment; don't cancel one in flight so
    // the live site isn't left in a half-applied state.
    workflow.file?.addOverride('concurrency', {
      group: 'pages',
      'cancel-in-progress': false,
    });

    workflow.addJobs({
      build: {
        name: 'build',
        runsOn: ['ubuntu-latest'],
        permissions: {
          contents: JobPermission.READ,
          pages: JobPermission.WRITE,
          idToken: JobPermission.WRITE,
        },
        steps: [
          {
            name: 'Checkout',
            uses: 'actions/checkout@v6',
          },
          {
            id: 'pages',
            name: 'Setup Pages',
            uses: 'actions/configure-pages@v6',
          },
          {
            name: 'Build with Jekyll',
            uses: 'actions/jekyll-build-pages@v1',
            with: {
              source: './',
              destination: './_site',
            },
          },
          {
            name: 'Upload artifact',
            uses: 'actions/upload-pages-artifact@v4',
          },
        ],
      },
      deploy: {
        name: 'deploy',
        needs: ['build'],
        runsOn: ['ubuntu-latest'],
        permissions: {
          contents: JobPermission.READ,
          pages: JobPermission.WRITE,
          idToken: JobPermission.WRITE,
        },
        environment: {
          name: 'github-pages',
          url: '${{ steps.deployment.outputs.page_url }}',
        },
        steps: [
          {
            id: 'deployment',
            name: 'Deploy to GitHub Pages',
            uses: 'actions/deploy-pages@v4',
          },
        ],
      },
    });
  }
}
