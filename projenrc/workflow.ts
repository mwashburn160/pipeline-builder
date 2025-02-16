import { Component } from 'projen';
import { GithubWorkflow } from 'projen/lib/github';
import { JobPermission, JobStep } from 'projen/lib/github/workflows-model';
import { TypeScriptProject } from 'projen/lib/typescript';

export class Workflow extends Component {
    private pnpmVersion: string;

    constructor(root: TypeScriptProject, options: { pnpmVersion: string; }) {
        super(root);
        this.pnpmVersion = options.pnpmVersion;

        let build = new GithubWorkflow(root.github!, 'build');
        build.on({ workflowDispatch: {} })
        build.addJobs({
            build: {
                name: 'build',
                runsOn: ['ubuntu-latest'],
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
                    'node-version': project.minNodeVersion,
                    cache: 'pnpm',
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