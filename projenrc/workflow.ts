import { Component } from 'projen';
import { GithubWorkflow } from 'projen/lib/github';
import { JobPermission, JobStep } from 'projen/lib/github/workflows-model';
import { TypeScriptProject } from 'projen/lib/typescript';

const IMAGE_PROJECTS = ['frontend', 'platform', 'quota', 'pipeline', 'plugin'] as const;
const LIBRARY_PROJECTS = ['api-core', 'api-server', 'pipeline-core', 'pipeline-data', 'pipeline-manager'] as const;

export class Workflow extends Component {
    private readonly pnpmVersion: string;

    constructor(root: TypeScriptProject, options: { pnpmVersion: string }) {
        super(root);
        this.pnpmVersion = options.pnpmVersion;

        const workflow = new GithubWorkflow(root.github!, 'release');
        workflow.on({ workflowDispatch: {} });

        workflow.addJobs({
            init: this.createInitJob(),
            build: this.createBuildJob(),
            publish: this.createPublishJob(),
        });
    }

    /**
     * Creates the initialization job that determines affected projects
     */
    private createInitJob() {
        return {
            name: 'init',
            runsOn: ['ubuntu-latest'],
            permissions: {
                actions: JobPermission.READ,
                contents: JobPermission.WRITE,
                packages: JobPermission.READ,
            },
            outputs: {
                NX_BASE: { stepId: 'nx_base', outputName: 'NX_BASE' },
                AFFECTED_IMAGES: { stepId: 'affected', outputName: 'AFFECTED_IMAGES' },
                AFFECTED_PROJECTS: { stepId: 'affected', outputName: 'AFFECTED_PROJECTS' },
                PUBLISH_IMAGE: { stepId: 'publish', outputName: 'PUBLISH_IMAGE' },
            },
            steps: [
                ...this.bootstrapSteps(),
                {
                    id: 'sha',
                    name: 'Derive SHAs for NX:BASE, NX:HEAD',
                    uses: 'nrwl/nx-set-shas@v4',
                    with: { 'main-branch-name': 'main' },
                },
                {
                    id: 'affected',
                    name: 'Affected projects and images',
                    run: 'echo AFFECTED_PROJECTS=$(pnpm nx show projects --affected --json) >> $GITHUB_OUTPUT && echo AFFECTED_IMAGES=$(jq -n --arg LIST "$(comm -12 <(pnpm nx show projects --affected | sort) <(echo $IMAGE_PROJECTS | jq -r \'.[]\' | sort))" \'$LIST | split("\n") | map(select(length>0))\') >> $GITHUB_OUTPUT',
                    env: {
                        IMAGE_PROJECTS: JSON.stringify(IMAGE_PROJECTS),
                    },
                },
                {
                    id: 'affected_details',
                    name: 'Affected details',
                    run: 'echo AFFECTED_PROJECTS=${{ steps.affected.outputs.AFFECTED_PROJECTS }} && echo AFFECTED_IMAGES=${{ steps.affected.outputs.AFFECTED_IMAGES }}',
                },
                {
                    id: 'nx_base',
                    name: 'Exported NX:BASE',
                    run: 'echo NX_BASE=${{ env.NX_BASE }} >> $GITHUB_OUTPUT',
                },
                {
                    id: 'publish',
                    name: 'Check publish images',
                    run: `echo PUBLISH_IMAGE=$(pnpm nx show projects --affected --json | jq 'any(contains(${IMAGE_PROJECTS.map(p => `"${p}"`).join(',')}))') >> $GITHUB_OUTPUT`,
                },
                {
                    id: 'publish_details',
                    name: 'Publish details',
                    run: 'echo PUBLISH_IMAGE: ${{ steps.publish.outputs.PUBLISH_IMAGE }}',
                },
            ],
        };
    }

    /**
     * Creates the build job that builds affected projects and publishes libraries
     */
    private createBuildJob() {
        return {
            name: 'build',
            needs: ['init'],
            runsOn: ['ubuntu-latest'],
            permissions: {
                actions: JobPermission.READ,
                contents: JobPermission.WRITE,
                packages: JobPermission.READ,
            },
            if: '${{ needs.init.outputs.AFFECTED_PROJECTS != \'[]\' || needs.init.outputs.AFFECTED_IMAGES != \'[]\' }}',
            steps: [
                ...this.bootstrapSteps(),
                {
                    id: 'set_nx_base',
                    name: 'Set NX:BASE, NX:HEAD',
                    run: 'echo NX_BASE=${{ needs.init.outputs.NX_BASE }} >> $GITHUB_ENV && echo NX_HEAD=$(git rev-parse HEAD) >> $GITHUB_ENV',
                },
                {
                    id: 'details_nx_base',
                    name: 'Details NX_BASE, NX_HEAD',
                    run: 'echo "NX_BASE: ${{ env.NX_BASE }}, NX_HEAD: ${{ env.NX_HEAD }}"',
                },
                {
                    id: 'build_target',
                    name: 'Run build target',
                    run: 'pnpm nx affected --target build --base ${{ env.NX_BASE }} --head ${{ env.NX_HEAD }} --verbose',
                    env: {
                        GITHUB_TOKEN: '${{ secrets.PAT_TOKEN }}',
                    },
                },
                {
                    id: 'semantic_version',
                    name: 'Semantic version',
                    run: 'pnpm nx release --first-release --skip-publish --verbose',
                    env: {
                        GITHUB_TOKEN: '${{ secrets.PAT_TOKEN }}',
                    },
                },
                {
                    id: 'check',
                    name: 'Check publish library',
                    run: `echo PUBLISH_LIB=$(pnpm nx show projects --affected --json | jq 'any(contains(${LIBRARY_PROJECTS.map(p => `"${p}"`).join(',')}))')  >> $GITHUB_OUTPUT`,
                },
                {
                    id: 'publish',
                    name: 'Publish library',
                    if: '${{ steps.check.outputs.PUBLISH_LIB == \'true\' }}',
                    run: 'pnpm publish --access restricted --filter @mwashburn160/* --no-git-checks --verbose',
                },
                {
                    id: 'upload_artifact',
                    name: 'Upload artifact',
                    uses: 'actions/upload-artifact@v6',
                    with: {
                        name: 'artifacts',
                        path: './**/lib/\n./**/dist/\n!./**/node_modules/',
                    },
                },
                {
                    id: 'push_changes',
                    name: 'Push new tag to the repository',
                    run: 'git push --follow-tags',
                },
            ],
        };
    }

    /**
     * Creates the publish job that builds and pushes Docker images
     */
    private createPublishJob() {
        return {
            name: 'publish image',
            needs: ['init', 'build'],
            runsOn: ['ubuntu-latest'],
            permissions: {
                actions: JobPermission.READ,
                contents: JobPermission.WRITE,
                packages: JobPermission.READ,
            },
            if: '${{ needs.init.outputs.PUBLISH_IMAGE == \'true\' }}',
            strategy: {
                failFast: false,
                maxParallel: 4,
                matrix: {
                    domain: {
                        project_name: '${{ fromJson(needs.init.outputs.AFFECTED_IMAGES) }}',
                    },
                },
            },
            steps: [
                ...this.bootstrapSteps(),
                {
                    id: 'dnload_artifact',
                    name: 'Download artifact',
                    uses: 'actions/download-artifact@v7',
                    with: {
                        name: 'artifacts',
                        path: 'dnload',
                    },
                },
                {
                    id: 'copy_artifact',
                    name: 'Copy artifacts to destination',
                    run: 'cp -rv dnload/* ./',
                },
                {
                    id: 'login_registry',
                    name: 'Login into container registry',
                    uses: 'docker/login-action@v3',
                    with: {
                        registry: 'ghcr.io',
                        username: '${{ github.actor }}',
                        password: '${{ secrets.PAT_TOKEN }}',
                    },
                },
                {
                    id: 'setup_buildx',
                    name: 'Setup buildx',
                    uses: 'docker/setup-buildx-action@v3',
                    with: {
                        cleanup: true,
                        'cache-binary': false,
                    },
                },
                {
                    id: 'build',
                    name: 'Build docker image',
                    run: 'pnpm nx run ${PROJECT_NAME}:docker:build --verbose',
                    env: {
                        PROJECT_NAME: '${{ matrix.project_name }}',
                    },
                },
                {
                    id: 'tag',
                    name: 'Tag docker image',
                    run: 'pnpm nx run ${PROJECT_NAME}:docker:tag --verbose',
                    env: {
                        REGISTRY: 'ghcr.io/mwashburn160',
                        PROJECT_NAME: '${{ matrix.project_name }}',
                    },
                },
                {
                    id: 'push',
                    name: 'Push docker image',
                    run: 'pnpm nx run ${PROJECT_NAME}:docker:push --verbose',
                    env: {
                        REGISTRY: 'ghcr.io/mwashburn160',
                        PROJECT_NAME: '${{ matrix.project_name }}',
                    },
                },
            ],
        };
    }

    /**
     * Creates common bootstrap steps used across all jobs
     */
    private bootstrapSteps(): JobStep[] {
        const project = this.project as TypeScriptProject;

        return [
            {
                name: 'Clear cache',
                uses: 'actions/github-script@v8',
                with: {
                    'github-token': '${{ secrets.PAT_TOKEN }}',
                    script: `
                        const caches = await github.rest.actions.getActionsCacheList({repo: context.repo.repo,owner: context.repo.owner})
                        for (const cache of caches.data.actions_caches) {
                        try {
                            await github.rest.actions.deleteActionsCacheById({repo: context.repo.repo,owner: context.repo.owner,cache_id: cache.id})
                            console.log('Successfully deleted cache with ID: ',cache.id);
                        } catch (error) { 
                            console.log('Error deleting cache with ID: ',cache.id, error);
                        }
                    }`,
                },
            },
            {
                name: 'Checkout repository',
                uses: 'actions/checkout@v6',
                with: {
                    ref: 'main',
                    'fetch-depth': 0,
                },
            },
            {
                name: 'Setup pnpm',
                uses: 'pnpm/action-setup@v4',
                with: {
                    version: this.pnpmVersion,
                },
            },
            {
                name: 'Setup node',
                uses: 'actions/setup-node@v6',
                with: {
                    cache: 'pnpm',
                    'node-version': project.minNodeVersion,
                    'package-manager-cache': 'pnpm',
                },
            },
            {
                name: 'Configure .npmrc',
                run: 'export NODE_AUTH_TOKEN=$(echo ${{ secrets.ENCODED_TOKEN }} | base64 -d) && npm config delete resolution-mode && npm config set //npm.pkg.github.com/\:_authToken $NODE_AUTH_TOKEN && npm config set \@mwashburn160\:registry https://npm.pkg.github.com/',
            },
            {
                name: 'Install dependencies',
                run: 'pnpm install --no-frozen-lockfile',
            },
            {
                name: 'Set git user',
                run: 'git config user.name "ci" && git config user.email "mwashburn160@gmail.com"',
            },
            {
                name: 'Prune tags older than 30 days',
                run: 'CUTOFF_DATE=$(date -d "30 days ago" +%s) && ' +
                    'git for-each-ref --format="%(refname:short) %(creatordate:unix)" refs/tags | while read TAG DATE; do ' +
                    'if [ $DATE -lt $CUTOFF_DATE ]; then ' +
                    'echo "Deleting tag $TAG created on $(date -d @$DATE)"; ' +
                    'git tag -d $TAG; ' +
                    'fi; ' +
                    'done && git push origin --tags --prune',
            },
        ];
    }
}