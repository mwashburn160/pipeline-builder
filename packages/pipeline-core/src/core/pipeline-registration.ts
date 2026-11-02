// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The credential a self-mutating synth registers its step manifest with
 * (`POST /api/pipelines/registry`).
 *
 * Not the org's `platform` secret: that key reads pipelines and plugins and
 * nothing else (the Pipeline Automation Role). Registration needs
 * `pipeline_registry:write`, which only the `pipeline-register` service account
 * holds — minted by `pipeline-manager infra store-token --scope
 * pipeline_registry:write` and stored at `<prefix>/<orgId>/pipeline-registry-write`.
 *
 * The synth CodeBuild project gets the secret's NAME as a plain variable, never
 * the value as a SECRETS_MANAGER one: CodeBuild fails a build at DOWNLOAD_SOURCE
 * when a SECRETS_MANAGER variable names a missing secret, and a missing
 * registration key must skip the registration (loudly), not break every build.
 * The synth reads the secret itself with the AWS SDK, so the project role is
 * granted `GetSecretValue` on exactly that secret.
 *
 * Dependency-free so the CLI and the synth share the names.
 */

/** The capability the registration key carries (its key-scope name in `store-token`). */
export const PIPELINE_REGISTRATION_CAPABILITY = 'pipeline_registry:write';

/** Secrets Manager leaf of the registration key (`scopeSecretLeaf('pipeline_registry:write')`). */
export const PIPELINE_REGISTRATION_SECRET_LEAF = 'pipeline-registry-write';

/** Env var the synth CodeBuild project carries the registration secret's NAME in. */
export const PIPELINE_REGISTRATION_SECRET_ENV = 'PIPELINE_REGISTRATION_SECRET_NAME';
