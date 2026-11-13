# `pipeline-bootstrap` — managed toolchain build image

The CodeBuild runtime image for steps that have no plugin-baked image (the
cold-start synth path, ShellSteps without a registry image, `metadata_only`
plugins). It carries Node, the AWS CLI v2, git, and the pinned
`pipeline-manager`, AWS CDK CLI (`cdk`), `cdk-assets`, `esbuild` and `pnpm`.
`cdk-synth` is built `FROM` this image, so the two always run the same
toolchain.

## One release, two halves

`pipeline-bootstrap` and `cdk-synth` share one **release version** (the
`version` in both `plugin-spec.yaml` files). It is its own semver, not the
pipeline-manager version, which is recorded in `toolchain.pipelineManager`.

- `version`, `toolchain` and `sourceDigest` in `plugin-spec.yaml` are
  **generated, never edit them by hand.** `deploy/bin/sync-image-tags.sh`
  writes `toolchain` from the Dockerfile `ARG`s, and hashes both directories'
  build inputs (Dockerfiles with their `ARG`s and base digests, and the specs
  minus the generated fields) into `sourceDigest`. When the hash changes it
  bumps the **patch** of both specs. Bump minor or major by hand, in both specs
  together, for a notable or breaking change.
- A version is **immutable**. `build-plugin-images.sh` refuses to re-push a
  `library/pipeline-bootstrap:<version>` that is already published with
  different bits, and there is no in-place `--force` for managed images.
- The image's `org.pipeline-builder.toolchain.*` labels come from the same
  `ARG`s, and upload refuses a spec whose `toolchain` disagrees with them.

## How it is built and loaded

```
deploy/bin/build-plugin-images.sh --only pipeline-bootstrap,cdk-synth
deploy/bin/load-plugins.sh --category toolchain
```

Both halves live in `deploy/toolchain/`, the managed toolchain's own source
root, not in the plugin catalog (`deploy/plugins/`): the pair is one release,
not catalog plugins. `build-plugin-images.sh` and `load-plugins.sh` handle it
first, outside their per-plugin catalog walk; `--category toolchain` selects it.

The base stage of `build-plugin-images.sh` builds this image after the
`_base` images and before any plugin, grype-gates it
(`--only-fixed --fail-on "$GRYPE_FAIL_ON"`), pushes
`library/pipeline-bootstrap:<version>`, saves `image.tar`, and builds
`cdk-synth` with `BOOTSTRAP_IMAGE=<registry>/library/pipeline-bootstrap@<digest>`
in the same run. `load-plugins.sh` uploads this image before `cdk-synth` and
fails when `image.tar` is missing. Managed plugins are never listed in the
ecosystem: no publish request is sent for them.

`image.tar` is gitignored.
