// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared plugin base images (deploy/plugins/_base): what `plugin new`
 * scaffolds `FROM` and what AI plugin generation tells the model to start
 * from. Listed here because neither the CLI nor the plugin service ships the
 * repo; a pipeline-manager test fails when the list drifts from the tree.
 */

/** One `pipeline-<eco>-base` image a plugin can start `FROM`. */
export interface PluginBaseImage {
  /** `--base` value. */
  key: string;
  /** Image tag the Dockerfile's `FROM` names. */
  image: string;
  /** Directory under deploy/plugins/_base. */
  dir: string;
  /** What the base provides on top of the root base. */
  provides: string;
  /** A command that proves the runtime is on PATH (the scaffold's smokeTest). */
  smokeTest: string;
}

export const PLUGIN_BASE_IMAGES: readonly PluginBaseImage[] = [
  { key: 'plugin', image: 'pipeline-plugin-base:24.04', dir: '_plugin-base', provides: 'git, curl, jq, unzip, fetch-verified, run-logged (the root base)', smokeTest: 'bash --version && jq --version' },
  { key: 'aws-cli', image: 'pipeline-aws-cli-base:1.0', dir: '_aws-cli-base', provides: 'AWS CLI v2', smokeTest: 'aws --version' },
  { key: 'cpp', image: 'pipeline-cpp-base:1.0', dir: '_cpp-base', provides: 'C/C++ toolchain, CMake, Conan, Meson', smokeTest: 'cc --version && cmake --version' },
  { key: 'dotnet', image: 'pipeline-dotnet-base:1.0', dir: '_dotnet-base', provides: 'one pinned .NET SDK', smokeTest: 'dotnet --version' },
  { key: 'go', image: 'pipeline-go-base:1.0', dir: '_go-base', provides: 'one pinned Go', smokeTest: 'go version' },
  { key: 'jvm', image: 'pipeline-jvm-base:1.0', dir: '_jvm-base', provides: 'Corretto JDK, Maven, Gradle, Kotlin', smokeTest: 'java -version && mvn --version' },
  { key: 'node', image: 'pipeline-node-base:1.0', dir: '_node-base', provides: 'one pinned Node.js + npm', smokeTest: 'node --version && npm --version' },
  { key: 'php', image: 'pipeline-php-base:1.0', dir: '_php-base', provides: 'one pinned PHP + Composer', smokeTest: 'php --version && composer --version' },
  { key: 'python', image: 'pipeline-python-base:1.0', dir: '_python-base', provides: 'one pinned CPython + pip', smokeTest: 'python3 --version && pip3 --version' },
  { key: 'ruby', image: 'pipeline-ruby-base:1.0', dir: '_ruby-base', provides: 'one pinned Ruby + Bundler', smokeTest: 'ruby --version && bundle --version' },
  { key: 'rust', image: 'pipeline-rust-base:1.0', dir: '_rust-base', provides: 'one pinned Rust toolchain + clippy/rustfmt', smokeTest: 'cargo --version && rustc --version' },
  { key: 'trivy', image: 'pipeline-trivy-base:1.0', dir: '_trivy-base', provides: 'trivy (two pinned versions)', smokeTest: 'trivy --version' },
];
