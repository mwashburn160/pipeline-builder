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
        wf.on({
            workflowDispatch: {
                runsOn: ['ubuntu-latest']
            }
        })
        wf.addJobs({
            build: {
                name: 'build',
                permissions: {
                    actions: JobPermission.READ,
                    contents: JobPermission.WRITE
                },
                steps: [
                    ...this.bootstrapSteps(),
                    {
                        name: 'Run build target',
                        run: 'pnpm nx affected --target build --base ${{ env.NX_BASE }} --head ${{ env.NX_HEAD }} --verbose'
                    }
                ],
            },
            version: {
                name: 'version',
                needs: ['build'],
                permissions: {
                    actions: JobPermission.READ,
                    contents: JobPermission.WRITE
                },
                steps: [
                    ...this.bootstrapSteps(),
                    {
                        name: 'Semantic version',
                        run: 'pnpm nx release --first-release  --skip-publish --verbose',
                        env: {
                            PAT_TOKEN: '${{ secrets.PAT_TOKEN }}'
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
                permissions: {
                    actions: JobPermission.READ,
                    contents: JobPermission.WRITE
                },
                steps: []
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
                name: 'Install pnpm',
                uses: 'pnpm/action-setup@v4',
                with: { version: this.pnpmVersion },
            },
            {
                name: 'Setup node',
                uses: 'actions/setup-node@v4',
                with: {
                    cache: 'pnpm',
                    'node-version': project.minNodeVersion
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