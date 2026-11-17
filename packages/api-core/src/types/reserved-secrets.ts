// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Secrets Manager leaves (`{SECRETS_PATH_PREFIX}/{orgId}/<leaf>`) the PLATFORM
 * owns, which a plugin may never declare as one of its `secrets`.
 *
 * A plugin's declared secret names become `SECRETS_MANAGER` env vars on its
 * CodeBuild step, and CDK grants that step's role `GetSecretValue` on each one.
 * Declaring one of these would hand plugin code the org's automation
 * credentials:
 *
 * - `platform` — the org's full-privilege automation credential;
 * - `registry-push` — the `registry:push` key CodeBuild uses for image pushes;
 * - `pipeline-registry-write` — the synth's pipeline-registration credential;
 * - `reporting-ingest` — the event/security-report ingestion key.
 *
 * Both halves of the defence read this one list: `PluginSpecSchema` refuses a
 * reserved name at upload, and pipeline-core's `toSecretEnvVars` throws at
 * synth (a plugin row can predate the schema check). It lives in api-core
 * because pipeline-core depends on api-core, not the other way round.
 */
export const RESERVED_SECRET_NAMES: ReadonlySet<string> = new Set([
  'platform', 'registry-push', 'pipeline-registry-write', 'reporting-ingest',
]);

/** Whether `name` is a platform-reserved secret leaf (case-insensitive). */
export function isReservedSecretName(name: string): boolean {
  return RESERVED_SECRET_NAMES.has(name.trim().toLowerCase());
}
