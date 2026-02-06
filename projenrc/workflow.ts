/**
 * GitHub Actions Release Workflow Configuration
 *
 * This module generates a comprehensive GitHub Actions workflow for:
 * - Detecting affected projects (using Nx)
 * - Building changed packages and services
 * - Publishing library packages to npm
 * - Building and pushing Docker images to GitHub Container Registry
 * - Semantic versioning with conventional commits
 *
 * Workflow Architecture:
 * 1. **init**: Determines which projects are affected by changes
 * 2. **build**: Builds affected projects, versions them, and publishes libraries
 * 3. **publish**: Builds and pushes Docker images for affected services
 *
 * Project Categories:
 * - **Image Projects**: Services built as Docker images (frontend, platform, quota, pipeline, plugin)
 * - **Library Projects**: npm packages consumed by other projects (api-core, api-server, etc.)
 *
 * Key Features:
 * - Nx affected detection for incremental builds
 * - Parallel Docker image builds (up to 4 concurrent)
 * - Automatic semantic versioning
 * - Independent changelog generation per project
 * - Build artifact caching between jobs
 * - Automatic tag pruning (30+ days old)
 * - Cache clearing to ensure fresh builds
 *
 * @see https://docs.github.com/en/actions
 * @see https://nx.dev/ci/intro/ci-with-nx
 */

import { Component } from 'projen';
import { GithubWorkflow } from 'projen/lib/github';
import { JobPermission, JobStep } from 'projen/lib/github/workflows-model';
import { TypeScriptProject } from 'projen/lib/typescript';

/** Projects that are built as Docker images and pushed to registry */
const IMAGE_PROJECTS = ['frontend', 'platform', 'quota', 'pipeline', 'plugin'] as const;

/** Projects that are published as npm packages */
const LIBRARY_PROJECTS = ['api-core', 'api-server', 'pipeline-core', 'pipeline-data', 'pipeline-manager'] as const;

/**
 * GitHub Actions workflow component for automated releases.
 *
 * Generates a multi-stage workflow that builds, versions, and publishes
 * both library packages and Docker images based on affected projects.
 *
 * @example
 * ```typescript
 * // In .projenrc.ts
 * new Workflow(root, { pnpmVersion: '10.25.0' });
 * ```
 */
export class Workflow extends Component {
    /** PNPM version to use in CI/CD workflow */
    private readonly pnpmVersion: string;

    /**
     * Creates the release workflow configuration.
     *
     * @param root - The root TypeScript project
     * @param options - Configuration options including PNPM version
     */
    constructor(root: TypeScriptProject, options: { pnpmVersion: string }) {
        super(root);
        this.pnpmVersion = options.pnpmVersion;

        // Create the release workflow file
        const workflow = new GithubWorkflow(root.github!, 'release');

        // Trigger: Manual workflow dispatch only (no automatic triggers)
        workflow.on({ workflowDispatch: {} });

        // Define the three-stage workflow
        workflow.addJobs({
            init: this.createInitJob(),       // Stage 1: Detect affected projects
            build: this.createBuildJob(),     // Stage 2: Build and publish libraries
            publish: this.createPublishJob(), // Stage 3: Build and push Docker images
        });
    }

    /**
     * Creates the initialization job that determines affected projects.
     *
     * This job:
     * 1. Clears GitHub Actions cache to ensure fresh builds
     * 2. Checks out the repository with full git history
     * 3. Sets up Node.js and PNPM
     * 4. Installs dependencies
     * 5. Uses Nx to determine which projects are affected
     * 6. Separates affected projects into images and libraries
     * 7. Exports outputs for downstream jobs
     *
     * Outputs:
     * - NX_BASE: The base SHA for Nx comparison
     * - AFFECTED_IMAGES: JSON array of image projects to build
     * - AFFECTED_PROJECTS: JSON array of all affected projects
     * - PUBLISH_IMAGE: Boolean indicating if any images need publishing
     *
     * @returns Job configuration object
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
     * Creates the build job that builds affected projects and publishes libraries.
     *
     * This job:
     * 1. Waits for the init job to complete
     * 2. Checks out the repository
     * 3. Sets up Node.js and PNPM
     * 4. Installs dependencies
     * 5. Runs `nx affected --target build` to build changed projects
     * 6. Generates semantic versions using conventional commits
     * 7. Publishes library packages to npm (if any libraries affected)
     * 8. Uploads build artifacts for the publish job
     * 9. Pushes version tags to the repository
     *
     * Conditional Execution:
     * - Only runs if there are affected projects or images
     * - Library publishing only happens if library projects are affected
     *
     * Artifacts:
     * - Uploads lib/ and dist/ directories for reuse in publish job
     *
     * @returns Job configuration object
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
     * Creates the publish job that builds and pushes Docker images.
     *
     * This job:
     * 1. Waits for both init and build jobs to complete
     * 2. Uses a matrix strategy to build multiple images in parallel
     * 3. Downloads build artifacts from the build job
     * 4. Logs into GitHub Container Registry (ghcr.io)
     * 5. Sets up Docker Buildx for advanced build features
     * 6. Builds Docker images with version tags
     * 7. Tags images for the registry
     * 8. Pushes images to ghcr.io/mwashburn160
     *
     * Matrix Strategy:
     * - Runs up to 4 image builds in parallel
     * - Continues even if one build fails (failFast: false)
     * - Matrix populated with affected image projects from init job
     *
     * Conditional Execution:
     * - Only runs if PUBLISH_IMAGE output from init is 'true'
     *
     * Docker Registry:
     * - Registry: ghcr.io/mwashburn160
     * - Image naming: {project-name}:{version}
     *
     * @returns Job configuration object
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
     * Creates common bootstrap steps used across all jobs.
     *
     * These steps set up the environment for every job:
     * 1. **Clear cache**: Removes old GitHub Actions cache entries
     * 2. **Checkout**: Clones repository with full git history (for Nx affected)
     * 3. **Setup PNPM**: Installs specified PNPM version
     * 4. **Setup Node.js**: Configures Node.js with PNPM caching
     * 5. **Configure .npmrc**: Sets up authentication for private packages
     * 6. **Install deps**: Runs `pnpm install` with lockfile updates allowed
     * 7. **Set git user**: Configures git for version commits
     * 8. **Prune tags**: Deletes git tags older than 30 days
     *
     * Cache Strategy:
     * - Clears all caches at the start to ensure fresh builds
     * - Uses PNPM content-addressable store for dependency caching
     *
     * Authentication:
     * - Uses PAT_TOKEN secret for GitHub package registry
     * - Uses ENCODED_TOKEN secret for npm authentication
     *
     * @returns Array of job steps common to all jobs
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