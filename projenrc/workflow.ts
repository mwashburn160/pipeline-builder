// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

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
const IMAGE_PROJECTS = ['frontend', 'platform', 'billing', 'reporting', 'compliance', 'quota', 'message', 'pipeline', 'plugin', 'image-registry', 'ask'] as const;

/**
 * Projects that are published as npm packages. Used by the release workflow
 * to decide whether to run `pnpm publish` at all — only triggers when at
 * least one of these is in the affected set.
 *
 * Includes `ai-core` and `pipeline-events`: the published `pipeline-manager`
 * CLI hard-depends on `ai-core`, and `setup-events` does `npm install
 * @pipeline-builder/pipeline-events` at runtime — so both must publish in
 * lockstep (they were previously private, which left `pipeline-manager` pinning
 * versions that were never published → ETARGET on `npx pipeline-manager`).
 */
const LIBRARY_PROJECTS = ['api-core', 'ai-core', 'api-server', 'pipeline-core', 'pipeline-data', 'pipeline-events', 'pipeline-manager'] as const;

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

        // Define the release workflow stages
        workflow.addJobs({
            init: this.createInitJob(),                  // Stage 1: Detect affected projects
            build: this.createBuildJob(),                // Stage 2: Build, test-gate, and publish libraries
            publish: this.createPublishJob(),              // Stage 3: Build and push Docker images
            verify_release: this.createVerifyReleaseJob(), // Stage 4: Fail if a published npm dep / deploy image tag isn't actually published
            record_build: this.createRecordBuildJob(),     // Stage 5: Advance .nx_base ONLY after a fully-successful publish+verify
        });

        // Separate PR/push merge gate: run affected tests on every pull request
        // (and on pushes to main). `buildWorkflow: false` disables projen's default
        // PR build, so without this nothing runs the 500+ test files before a merge
        // — which is how source/test drift (e.g. accessModifier→visibility, missing
        // mock exports) reached main. Kept out of the manual, dispatch-only release
        // workflow so it actually gates day-to-day changes.
        const testWorkflow = new GithubWorkflow(root.github!, 'test');
        testWorkflow.on({
            pullRequest: {},
            push: { branches: ['main'] },
            workflowDispatch: {},
        });
        testWorkflow.addJobs({ test: this.createTestGateJob() });
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
                NX_HEAD: { stepId: 'nx_head', outputName: 'NX_HEAD' },
                AFFECTED_IMAGES: { stepId: 'affected', outputName: 'AFFECTED_IMAGES' },
                AFFECTED_PROJECTS: { stepId: 'affected', outputName: 'AFFECTED_PROJECTS' },
            },
            steps: [
                ...this.bootstrapSteps(),
                {
                    id: 'nx_base',
                    name: 'Set NX_BASE',
                    run: 'if [ -f .nx_base ] && [ -s .nx_base ]; then echo NX_BASE=$(cat .nx_base) >> $GITHUB_OUTPUT; else echo NX_BASE=$(git rev-parse HEAD~1) >> $GITHUB_OUTPUT; fi',
                },
                {
                    id: 'nx_head',
                    name: 'Set NX_HEAD',
                    run: 'echo NX_HEAD=$(git rev-parse HEAD) >> $GITHUB_OUTPUT',
                },
                {
                    id: 'affected',
                    name: 'Affected projects and images',
                    env: {
                        IMAGE_PROJECTS: JSON.stringify(IMAGE_PROJECTS),
                    },
                    // AFFECTED_IMAGES = nx's transitively-affected set ∩ image
                    // projects. This covers BOTH triggers we want:
                    //   1. Direct service-dir change (e.g. api/billing/src/*) →
                    //      that service's image rebuilds.
                    //   2. Library change (e.g. packages/api-core/*) → only the
                    //      service images whose dep graph touches that library
                    //      rebuild. Unrelated services don't.
                    //
                    // Unrelated changes (.projenrc.ts, deploy/*, docs) don't end
                    // up in nx's affected set, so they trigger zero image builds.
                    // jq set-intersection on the JSON array nx emits (one-line
                    // `["plugin","@pipeline-builder/pipeline-core",...]`). The
                    // previous `comm -12 | sort` approach compared the entire
                    // JSON string to one-per-line names → always empty → no
                    // publishes since 3.4.42.
                    run: 'AFFECTED=$(pnpm nx show projects --affected --json --base ${{ steps.nx_base.outputs.NX_BASE }} --head ${{ steps.nx_head.outputs.NX_HEAD }}) && echo AFFECTED_PROJECTS=$AFFECTED >> $GITHUB_OUTPUT && echo AFFECTED_IMAGES=$(jq -nc --argjson a "$AFFECTED" --argjson l "$IMAGE_PROJECTS" \'[$a[] | select(IN($l[]))]\') >> $GITHUB_OUTPUT',
                },
                {
                    name: 'Affected details',
                    run: 'echo AFFECTED_PROJECTS=${{ steps.affected.outputs.AFFECTED_PROJECTS }} && echo AFFECTED_IMAGES=${{ steps.affected.outputs.AFFECTED_IMAGES }}',
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
                // pnpm 11 attempts npm OIDC ("trusted publishing") and needs an
                // id-token; without this it warns (ERR_PNPM_ID_TOKEN_GITHUB_WORKFLOW_INCORRECT_PERMISSIONS)
                // before falling back to NPM_TOKEN.
                idToken: JobPermission.WRITE,
            },
            if: '${{ needs.init.outputs.AFFECTED_PROJECTS != \'[]\' || needs.init.outputs.AFFECTED_IMAGES != \'[]\' }}',
            steps: [
                ...this.bootstrapSteps(),
                {
                    name: 'Set NX:BASE, NX:HEAD',
                    run: 'echo NX_BASE=${{ needs.init.outputs.NX_BASE }} >> $GITHUB_ENV && echo NX_HEAD=${{ needs.init.outputs.NX_HEAD }}  >> $GITHUB_ENV',
                },
                {
                    name: 'Details NX_BASE, NX_HEAD',
                    run: 'echo "NX_BASE: ${{ env.NX_BASE }}, NX_HEAD: ${{ env.NX_HEAD }}"',
                },
                {
                    name: 'Run build target',
                    run: 'pnpm nx affected --target build --base ${{ env.NX_BASE }} --head ${{ env.NX_HEAD }} --verbose',
                    env: {
                        GITHUB_TOKEN: '${{ secrets.GHRC_TOKEN }}',
                        // The `build` target runs each project's tests, so the DB-backed
                        // suites are in scope here exactly as in the `test` workflow. The
                        // gate (platform/test/helpers/integration-gate.ts) FAILS on a
                        // GitHub Actions runner when this is unset rather than skipping
                        // silently, so every Actions workflow that compiles or tests must
                        // set it — otherwise the release path dies on a green-looking hole.
                        RUN_MONGO_INTEGRATION: 'true',
                    },
                },
                {
                    // Release gate: run the affected projects' tests against the
                    // just-built libs BEFORE versioning/publishing anything. A test
                    // failure fails the build job, which skips `publish` (needs:
                    // build) and `record_build` (which advances .nx_base) — so a
                    // broken commit can neither ship an image nor move the affected
                    // base forward. The `test` target dependsOn ['^build'] (nx.json),
                    // so upstream libs are already built here. The dedicated `test`
                    // workflow is the per-PR merge gate; this is the release-path gate.
                    name: 'Run test target',
                    run: 'pnpm nx affected --target test --base ${{ env.NX_BASE }} --head ${{ env.NX_HEAD }} --verbose',
                    env: {
                        GITHUB_TOKEN: '${{ secrets.GHRC_TOKEN }}',
                        // Same reason as the build step above: the release gate must run
                        // the integration tier, not skip it.
                        RUN_MONGO_INTEGRATION: 'true',
                    },
                },
                {
                    name: 'Semantic version',
                    run: 'pnpm nx release --first-release --skip-publish --verbose',
                    env: {
                        GITHUB_TOKEN: '${{ secrets.GHRC_TOKEN }}',
                    },
                },
                {
                    id: 'check',
                    name: 'Compute affected library packages',
                    env: {
                        LIBRARY_PROJECTS: JSON.stringify(LIBRARY_PROJECTS),
                    },
                    // nx emits scoped names (`@pipeline-builder/pipeline-core`)
                    // while LIBRARY_PROJECTS uses bare names — strip the scope
                    // before intersecting, otherwise the result is empty even
                    // when libraries are affected.
                    run: 'AFFECTED=$(pnpm nx show projects --affected --json --base ${{ env.NX_BASE }} --head ${{ env.NX_HEAD }}) && echo AFFECTED_LIBS=$(jq -nc --argjson a "$AFFECTED" --argjson l "$LIBRARY_PROJECTS" \'[$a[] | sub("^@pipeline-builder/"; "") | select(IN($l[]))]\') >> $GITHUB_OUTPUT',
                },
                {
                    name: 'Publish npm packages',
                    // Skip on both the empty-array `[]` and the empty-string case:
                    // if `nx show projects --json` emits nothing (or a warning that
                    // corrupts the JSON), AFFECTED_LIBS is '' (not '[]'), which would
                    // otherwise pass this guard and run `pnpm publish` with no filter —
                    // publishing the private root package (E403).
                    if: '${{ steps.check.outputs.AFFECTED_LIBS != \'[]\' && steps.check.outputs.AFFECTED_LIBS != \'\' }}',
                    // Belt-and-suspenders: if FILTERS resolves empty, skip rather than
                    // let `pnpm publish` fall back to the current (root) package.
                    run: 'npm config set @pipeline-builder:registry=https://registry.npmjs.org/ && FILTERS=$(echo \'${{ steps.check.outputs.AFFECTED_LIBS }}\' | jq -r \'[.[] | "--filter @pipeline-builder/" + .] | join(" ")\') && if [ -z "$FILTERS" ]; then echo "No affected @pipeline-builder libraries to publish."; else pnpm publish --access public $FILTERS --no-git-checks --verbose; fi',
                },
                {
                    // `nx affected` only builds frontend when it's in the affected set,
                    // so `.next/standalone` is often absent on a given run. hashFiles()
                    // THROWS ("Fail to hash files under directory") when its globbed
                    // directory doesn't exist — it does NOT return '' — which fails
                    // template evaluation. Gate on a plain directory test instead, which
                    // never throws.
                    name: 'Check for frontend standalone bundle',
                    id: 'fe_bundle',
                    run: 'if [ -d ./frontend/.next/standalone ]; then echo "exists=true" >> "$GITHUB_OUTPUT"; else echo "exists=false" >> "$GITHUB_OUTPUT"; fi',
                },
                {
                    // actions/upload-artifact dereferences symlinks, which breaks the
                    // Next.js standalone bundle (its node_modules uses pnpm-style symlinks
                    // — e.g. frontend/node_modules/next → ../../node_modules/.pnpm/next@…
                    // — and Node resolves @swc/helpers via the symlink target's .pnpm
                    // peers). Tar manually with --dereference NOT set so symlinks survive.
                    name: 'Package frontend bundle (preserves symlinks)',
                    if: 'steps.fe_bundle.outputs.exists == \'true\'',
                    run: 'tar -czf frontend-bundle.tar.gz -C ./frontend .next/standalone .next/static',
                },
                {
                    name: 'Upload artifact',
                    uses: 'actions/upload-artifact@v7',
                    with: {
                        name: 'artifacts',
                        // Frontend's standalone+static are bundled into frontend-bundle.tar.gz
                        // above to preserve symlinks; the publish job extracts it back.
                        // ./frontend/.next/ is excluded so the **/lib and **/dist globs don't
                        // pick up dereferenced copies of next/dist, sharp/lib, etc. inside the
                        // standalone tree — those collide with the tarball at extract time.
                        path: './**/lib/\n./**/dist/\n./frontend-bundle.tar.gz\n!./node_modules/\n!./packages/*/node_modules/\n!./api/*/node_modules/\n!./platform/node_modules/\n!./frontend/node_modules/\n!./frontend/.next/',
                        'include-hidden-files': true,
                    },
                },
                {
                    name: 'Push new tag to the repository',
                    run: 'git push --follow-tags',
                },
                // NOTE: `.nx_base` is intentionally NOT advanced here. It is
                // committed by the downstream `record_build` job, which runs only
                // after `publish` (images) and `verify_release` succeed — so a
                // failed image publish can no longer be silently forgotten by an
                // already-advanced base (those images would never be rebuilt).
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
                // WRITE so cosign can push the signature + SBOM attestation as OCI
                // referrers alongside the image on GHCR (was READ — enough to pull).
                packages: JobPermission.WRITE,
                // Keyless cosign: the OIDC token is exchanged with Sigstore Fulcio
                // for an ephemeral signing cert (no long-lived key to manage/leak).
                idToken: JobPermission.WRITE,
            },
            if: '${{ needs.init.outputs.AFFECTED_IMAGES != \'[]\' }}',
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
                    uses: 'actions/download-artifact@v8',
                    with: {
                        name: 'artifacts',
                        path: 'dnload',
                    },
                },
                {
                    name: 'Copy artifacts to destination',
                    run: 'cp -rv dnload/* ./',
                },
                {
                    // Restore the symlink-preserving frontend bundle from the tarball
                    // packaged in the build job. Symlinks are required for the Next.js
                    // standalone runtime to resolve transitive deps like @swc/helpers.
                    // Only runs for the frontend matrix entry — the tarball is in the
                    // shared artifact and would be present (but irrelevant) for every
                    // other image's build context.
                    // --overwrite is needed because pnpm's nested symlink layout
                    // (`.pnpm/node_modules/<x>` → `.pnpm/<x>@<ver>/node_modules/<x>`)
                    // resolves to paths tar has already extracted; without it, GNU tar
                    // aborts the whole extract with "Cannot open: File exists".
                    name: 'Extract frontend bundle',
                    if: '${{ matrix.project_name == \'frontend\' }}',
                    run: 'tar --overwrite -xzf frontend-bundle.tar.gz -C ./frontend && rm frontend-bundle.tar.gz',
                },
                {
                    name: 'Login into container registry',
                    uses: 'docker/login-action@v4',
                    with: {
                        registry: 'ghcr.io',
                        username: '${{ github.actor }}',
                        password: '${{ secrets.GHRC_TOKEN }}',
                    },
                },
                {
                    // QEMU registers binfmt handlers so the amd64 runner can
                    // build the non-native (arm64) leg of the multi-arch image.
                    name: 'Setup QEMU',
                    uses: 'docker/setup-qemu-action@v4',
                },
                {
                    name: 'Setup buildx',
                    uses: 'docker/setup-buildx-action@v4',
                    with: {
                        cleanup: true,
                        'cache-binary': false,
                    },
                },
                {
                    // Multi-arch build + push in one step. --push (not --load) is
                    // mandatory for a manifest list; buildx uploads the OCI index
                    // directly to ghcr. Platforms come from DOCKER_PLATFORMS
                    // (default linux/amd64,linux/arm64 in the docker:publish task).
                    name: 'Build + push multi-arch image',
                    run: 'pnpm nx run ${PROJECT_NAME}:docker:publish --verbose',
                    env: {
                        REGISTRY: 'ghcr.io/mwashburn160',
                        PROJECT_NAME: '${{ matrix.project_name }}',
                        // Enables the GHA-backed buildx layer cache (--cache-to/from
                        // type=gha) so the emulated arm64 leg reuses layers across runs.
                        DOCKER_CACHE: '1',
                    },
                },
                {
                    // Fail the release if the published tag is not a multi-arch
                    // manifest list (guards against a silent single-arch regression).
                    name: 'Verify multi-arch manifest',
                    run: 'pnpm nx run ${PROJECT_NAME}:docker:verify --verbose',
                    env: {
                        REGISTRY: 'ghcr.io/mwashburn160',
                        PROJECT_NAME: '${{ matrix.project_name }}',
                    },
                },
                {
                    // Supply-chain provenance: cryptographically sign the pushed image
                    // and attach an SBOM so a deploy can verify (a) the image is the one
                    // CI built and (b) exactly what's inside it. Keyless (Sigstore
                    // Fulcio/Rekor) — no key material to manage. Signatures/attestations
                    // attach as OCI REFERRERS, so they don't add a platform entry to the
                    // manifest index and `docker:verify` above stays happy (unlike
                    // buildx's native --provenance, which is why that stays disabled).
                    name: 'Install cosign',
                    uses: 'sigstore/cosign-installer@v3',
                },
                {
                    name: 'Install syft (SBOM generator)',
                    uses: 'anchore/sbom-action/download-syft@v0',
                },
                {
                    // Sign + attest by DIGEST (not the mutable tag). Resolve the digest
                    // from the just-pushed manifest list, then cosign sign + SBOM attest.
                    // Enforced (set -e): an unsigned release is a supply-chain gap, so a
                    // signing failure fails the release rather than shipping unsigned.
                    name: 'Sign image + attach SBOM (keyless)',
                    run: [
                        'set -euo pipefail',
                        'PROJ_DIR=$(pnpm nx show project ${PROJECT_NAME} --json | jq -r .root)',
                        'VERSION=$(jq -r .version "$PROJ_DIR/package.json")',
                        'REF="ghcr.io/mwashburn160/${PROJECT_NAME}:${VERSION}"',
                        'DIGEST=$(docker buildx imagetools inspect "$REF" --format \'{{ .Manifest.Digest }}\')',
                        'IMG="ghcr.io/mwashburn160/${PROJECT_NAME}@${DIGEST}"',
                        'echo "Signing $IMG"',
                        'cosign sign --yes "$IMG"',
                        'syft "$IMG" -o spdx-json=sbom.spdx.json',
                        'cosign attest --yes --predicate sbom.spdx.json --type spdxjson "$IMG"',
                    ].join(' && '),
                    env: {
                        PROJECT_NAME: '${{ matrix.project_name }}',
                        COSIGN_YES: 'true',
                    },
                },
            ],
        };
    }

    /**
     * Release gate: every published artifact's pinned versions must actually
     * resolve, catching "published-ahead-of-its-dependency" gaps at release time
     * instead of at install/deploy.
     *  - npm: each published `@pipeline-builder/*` package's internal dep versions
     *    must exist on the registry (the gap that 404'd `pipeline-core@<ver>` /
     *    `ai-core@<ver>` on `npm i`). Runs after `build` (which `pnpm publish`es).
     *  - images: every `ghcr.io/mwashburn160/<svc>:<version>` referenced under
     *    deploy/** must exist on GHCR (the gap that left `compliance:3.4.78`
     *    dangling). Runs after `publish` (the image push).
     *
     * @returns Job configuration object
     */
    private createVerifyReleaseJob() {
        return {
            name: 'verify release',
            needs: ['init', 'build', 'publish'],
            runsOn: ['ubuntu-latest'],
            permissions: {
                contents: JobPermission.READ,
                packages: JobPermission.READ,
            },
            // Run after build + publish whether they succeeded OR were skipped
            // (nothing affected) — stale refs are still caught. Skip only if an
            // upstream job failed or was cancelled.
            if: '${{ always() && needs.init.result == \'success\' && needs.build.result != \'failure\' && needs.build.result != \'cancelled\' && needs.publish.result != \'failure\' && needs.publish.result != \'cancelled\' }}',
            steps: [
                {
                    name: 'Checkout repository',
                    uses: 'actions/checkout@v6',
                    // `build` bumps versions via `nx release` and pushes that commit
                    // mid-run, so the dispatch SHA is already stale by the time this
                    // job starts. Pin `main` (as every other release job does) so the
                    // gate verifies the tree the release actually produced.
                    with: {
                        ref: 'main',
                        'fetch-depth': 0,
                    },
                },
                {
                    name: 'Verify published npm package deps resolve',
                    run: 'bash deploy/bin/verify-npm-deps.sh',
                },
                {
                    name: 'Verify deploy image tags are publicly pullable from ghcr.io',
                    run: 'bash deploy/bin/verify-image-tags.sh',
                    // The verdict comes from an ANONYMOUS probe — deploy/ pulls these
                    // images with no registry login, so "exists" is not the contract,
                    // "public" is. The token below only CLASSIFIES a failure ("private"
                    // vs "never published"); it cannot make a private image pass.
                    env: {
                        GHCR_TOKEN: '${{ secrets.GHRC_TOKEN }}',
                        GHCR_USER: '${{ github.actor }}',
                    },
                },
            ],
        };
    }

    /**
     * Records a successful release by advancing `.nx_base` to the built HEAD.
     *
     * This is deliberately a SEPARATE, final job rather than a step in `build`.
     * The affected-detection base (`.nx_base`) may only move forward once every
     * artifact that was affected actually shipped:
     *  - `build` succeeded (libs built + npm published),
     *  - `publish` did not fail/cancel (images pushed — or legitimately skipped
     *    when nothing image-affected), and
     *  - `verify_release` confirmed the published npm/image refs resolve.
     *
     * Previously the base was committed at the end of `build`, before the
     * downstream image `publish`. A failed publish then left the base advanced,
     * so the next release computed `nx affected` from the advanced base and never
     * rebuilt those images — the failed publish was silently forgotten.
     *
     * @returns Job configuration object
     */
    private createRecordBuildJob() {
        return {
            name: 'record build',
            needs: ['init', 'build', 'publish', 'verify_release'],
            runsOn: ['ubuntu-latest'],
            permissions: {
                contents: JobPermission.WRITE,
            },
            // Advance the base only on a fully-successful release. `always()` so a
            // legitimately SKIPPED publish (nothing image-affected) still records,
            // but any failure/cancel upstream — build, publish, or verify — holds
            // the base where it is so the affected set is recomputed next run.
            if: '${{ always() && needs.build.result == \'success\' && needs.publish.result != \'failure\' && needs.publish.result != \'cancelled\' && needs.verify_release.result == \'success\' }}',
            steps: [
                {
                    name: 'Checkout repository',
                    uses: 'actions/checkout@v6',
                    with: {
                        ref: 'main',
                        'fetch-depth': 0,
                    },
                },
                {
                    name: 'Set git user',
                    run: 'git config user.name "ci" && git config user.email "mwashburn160@gmail.com"',
                },
                {
                    // main may have advanced (build pushed version-bump commits);
                    // record the current tip so the next run's affected set starts
                    // from exactly what this release built and verified.
                    name: 'Advance .nx_base to the released HEAD',
                    run: 'git pull --ff-only origin main && echo $(git rev-parse HEAD) > .nx_base && git add .nx_base && git commit -m "chore: updated last successfully built commit" && git push',
                },
            ],
        };
    }

    /**
     * Per-PR / push-to-main merge gate: run the affected projects' test target.
     *
     * Independent of the (manual, dispatch-only) release workflow so that every
     * pull request and every push to main actually executes the test suite before
     * it can merge/land. `nx affected --target test` builds upstream libs first
     * (the `test` target's `dependsOn: ['^build']`), so tests see current exports.
     *
     * This job is intentionally SIDE-EFFECT-FREE (no tag pruning, no npm publish,
     * no cache deletion, no git pushes) — it only checks out, installs, and tests.
     *
     * @returns Job configuration object
     */
    private createTestGateJob() {
        const project = this.project as TypeScriptProject;
        return {
            name: 'test',
            runsOn: ['ubuntu-latest'],
            permissions: {
                contents: JobPermission.READ,
                packages: JobPermission.READ,
            },
            steps: [
                {
                    name: 'Disable Nx telemetry and daemon',
                    run: 'echo NX_TELEMETRY_DISABLED=1 >> $GITHUB_ENV && echo NX_DAEMON=false >> $GITHUB_ENV',
                },
                {
                    // Full history so `nx affected --base origin/main` can diff.
                    name: 'Checkout repository',
                    uses: 'actions/checkout@v6',
                    with: {
                        'fetch-depth': 0,
                    },
                },
                {
                    name: 'Setup pnpm',
                    uses: 'pnpm/action-setup@v6',
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
                    name: 'Configure npm registry',
                    run: 'export NPM_TOKEN=$(echo ${{ secrets.NPM_TOKEN_ENCODED }} | base64 -d) && npm config set //registry.npmjs.org/\:_authToken=$NPM_TOKEN && npm config set \@pipeline-builder\:registry=https://registry.npmjs.org/',
                },
                {
                    name: 'Install dependencies',
                    run: 'pnpm install --frozen-lockfile',
                },
                {
                    // On a PR, GITHUB_BASE_REF is the target branch; fall back to
                    // origin/main for pushes/dispatch. `nx affected` builds upstream
                    // libs (test dependsOn ^build) then runs each affected test.
                    name: 'Run affected tests',
                    run: 'BASE="origin/${GITHUB_BASE_REF:-main}" && git rev-parse --verify "$BASE" >/dev/null 2>&1 || BASE="origin/main" && pnpm nx affected --target test --base "$BASE" --head HEAD --verbose',
                    // Run the DB-backed integration suites too. They self-skip unless
                    // this is set and use mongodb-memory-server (an ephemeral in-process
                    // mongod — no external service), so CI is the right place to run
                    // them; local `pnpm test` stays fast (env unset). The pipeline-manager
                    // integration test needs a LIVE platform (PLATFORM_URL) and correctly
                    // stays skipped here.
                    env: {
                        RUN_MONGO_INTEGRATION: 'true',
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
     * - Uses GHRC_TOKEN secret for GitHub package registry
     * - Uses GHRC_TOKEN_ENCODED secret for npm authentication
     *
     * @returns Array of job steps common to all jobs
     */
    private bootstrapSteps(): JobStep[] {
        const project = this.project as TypeScriptProject;

        return [
            {
                // Disable Nx telemetry prompt and daemon for non-interactive CI.
                // Without these the first nx invocation hangs on "Share usage data?"
                // and the daemon adds startup overhead + stale-state risk in
                // ephemeral runners. Set via $GITHUB_ENV so all subsequent steps
                // (and any tools they spawn) inherit the values.
                name: 'Disable Nx telemetry and daemon',
                run: 'echo NX_TELEMETRY_DISABLED=1 >> $GITHUB_ENV && echo NX_DAEMON=false >> $GITHUB_ENV',
            },
            {
                name: 'Clear cache',
                uses: 'actions/github-script@v9',
                with: {
                    'github-token': '${{ secrets.GHRC_TOKEN }}',
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
                uses: 'pnpm/action-setup@v6',
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
                name: 'Configure npm registry',
                run: 'export NPM_TOKEN=$(echo ${{ secrets.NPM_TOKEN_ENCODED }} | base64 -d) && npm config set //registry.npmjs.org/\:_authToken=$NPM_TOKEN && npm config set \@pipeline-builder\:registry=https://registry.npmjs.org/',
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
                name: 'Prune tags older than 15 days',
                run: 'CUTOFF_DATE=$(date -d "15 days ago" +%s) && ' +
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