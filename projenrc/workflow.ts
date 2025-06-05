import { Component } from 'projen';
import { GithubWorkflow } from 'projen/lib/github';
import { JobPermission, JobStep } from 'projen/lib/github/workflows-model';
import { TypeScriptProject } from 'projen/lib/typescript';

export class Workflow extends Component {
    private pnpmVersion: string;

    constructor(root: TypeScriptProject, options: { pnpmVersion: string; }) {
        super(root);
        this.pnpmVersion = options.pnpmVersion;

        let wf = new GithubWorkflow(root.github!, 'release');
        wf.on({ workflowDispatch: {} })
        wf.addJobs({
            init: {
                name: 'init',
                runsOn: ['ubuntu-latest'],
                permissions: {
                    actions: JobPermission.READ,
                    contents: JobPermission.WRITE
                },
                steps: [
                    ...this.bootstrapSteps(),
                    {
                        name: 'Affected projects',
                        run: 'echo TOTAL_AFFECTED=$(pnpm nx show projects --affected --json | jq length) >> $GITHUB_OUTPUT && echo AFFECTED_PROJECTS=$(pnpm nx show projects --affected --json) >> $GITHUB_OUTPUT'
                    },
                    {
                        name: 'Affected info',
                        run: 'echo TOTAL_AFFECTED=$(pnpm nx show projects --affected --json | jq length) && echo AFFECTED_PROJECTS=$(pnpm nx show projects --affected --json)'
                    }
                ]
            },
            build: {
                name: 'build',
                needs: ['init'],
                runsOn: ['ubuntu-latest'],
                permissions: {
                    actions: JobPermission.READ,
                    contents: JobPermission.WRITE
                },
                steps: [
                    ...this.bootstrapSteps(),
                    {
                        name: 'Run build target',
                        run: 'pnpm nx affected --target build --base ${{ env.NX_BASE }} --head ${{ env.NX_HEAD }} --verbose',
                        env: {
                            GITHUB_TOKEN: '${{ secrets.PAT_TOKEN }}'
                        }
                    }
                ],
            },
            version: {
                name: 'version',
                needs: ['build'],
                runsOn: ['ubuntu-latest'],
                permissions: {
                    actions: JobPermission.READ,
                    contents: JobPermission.WRITE
                },
                if: '${{ needs.init.outputs.TOTAL_AFFECTED != \"0\" }}',
                steps: [
                    ...this.bootstrapSteps(),
                    {
                        name: 'Semantic version',
                        run: 'pnpm nx release --first-release  --skip-publish --verbose',
                        env: {
                            GITHUB_TOKEN: '${{ secrets.PAT_TOKEN }}'
                        }
                    },
                    {
                        name: 'Push new tag to the repository',
                        run: 'git push && git push --tags'
                    }
                ]
            },
            publish: {
                name: 'publish',
                needs: ['version'],
                runsOn: ['ubuntu-latest'],
                permissions: {
                    actions: JobPermission.READ,
                    contents: JobPermission.WRITE
                },
                if: 'contains(fromJSON(\'${{ needs.init.outputs.AFFECTED_PROJECTS }}\'), \'@mwashburn160/pipeline-lib\' )',
                steps: [
                    ...this.bootstrapSteps(),
                    {
                        name: 'Publish packages',
                        run: 'pnpm nx release publish --projects=@mwashburn160/pipeline-lib',
                        env: {
                            GITHUB_TOKEN: '${{ secrets.PAT_TOKEN }}'
                        }
                    }
                ]
            }
        })
    }

    private bootstrapSteps(): JobStep[] {
        let project = this.project as TypeScriptProject;
        return [
            {
                name: 'Checkout repository',
                uses: 'actions/checkout@v4',
                with: {
                    'ref': 'main',
                    'fetch-depth': 0
                },
            },
            {
                name: 'Setup pnpm',
                uses: 'pnpm/action-setup@v4',
                with: { version: this.pnpmVersion },
            },
            {
                name: 'Setup node',
                uses: 'actions/setup-node@v4',
                with: {
                    cache: 'pnpm',
                    'node-version': project.minNodeVersion,
                    'registry-url': 'https://npm.pkg.github.com/'
                },
                env: {
                    GITHUB_TOKEN: '${{ secrets.PAT_TOKEN }}',
                    NODE_AUTH_TOKEN: '${{ secrets.PAT_TOKEN }}'
                }
            },
            {
                name: 'Setup AWS SAM Cli',
                uses: 'aws-actions/setup-sam@v2',
                with: {
                    version: '1.139.0',
                    'use-installer': true,
                    token: '${{ secrets.PAT_TOKEN }}'
                }
            },
            {
                name: 'Nx cache',
                uses: 'actions/cache@v4',
                with: {
                    'fail-on-cache-miss': false,
                    path: 'node_modules/.cache/nx',
                    key: 'nx-${{ github.repository_id }}-${{ github.sha }}',
                },
            },
            {
                name: 'Derive SHAs for nx affected commands',
                uses: 'nrwl/nx-set-shas@v4',
                with: { 'main-branch-name': 'main' },
            },
            {
                name: 'Install dependencies',
                run: 'pnpm install --no-frozen-lockfile',
            },
            {
                name: 'Set git user',
                run: 'git config user.name "ci" && git config user.email "mwashburn160@gmail.com"'
            }
        ]
    }
}