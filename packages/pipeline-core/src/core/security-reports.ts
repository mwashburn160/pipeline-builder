// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Uploading a step's security reports (SARIF / trivy JSON / grype JSON) to
 * `POST /api/pipelines/:id/security-reports`.
 *
 * A plugin step has no platform credential: plugin images don't carry
 * `pipeline-manager`, and the org's `platform` secret is the full-privilege
 * automation key, which a container that builds user code must not hold. So a
 * step that opts in (`PB_UPLOAD_SECURITY_REPORTS=true` in its env, metadata or
 * the plugin's defaults) gets the org's `reporting:ingest`-SCOPED key instead —
 * the same least-privilege credential the events Lambda reports with, minted by
 * `pipeline-manager infra store-token --scope reporting:ingest` — injected by
 * CodeBuild from Secrets Manager as {@link SECURITY_REPORT_KEY_ENV}. The plugin
 * POSTs with it as a Bearer credential. Opting in without that secret fails the
 * build at DOWNLOAD_SOURCE (CodeBuild requires the secret) — loud, not skipped.
 *
 * Dependency-free so the CLI and the synth share the names.
 */

/** Step env flag that opts a step in to report upload. */
export const SECURITY_REPORT_UPLOAD_ENV = 'PB_UPLOAD_SECURITY_REPORTS';

/** Env var the scoped upload key is injected as. */
export const SECURITY_REPORT_KEY_ENV = 'PB_SECURITY_REPORT_KEY';

/** Secrets Manager leaf of the scoped key (`scopeSecretLeaf('reporting:ingest')`). */
export const SECURITY_REPORT_SECRET_LEAF = 'reporting-ingest';

/** Report formats the ingest endpoint accepts. */
export const SECURITY_REPORT_FORMATS = ['sarif', 'trivy-json', 'grype-json'] as const;
export type SecurityReportFormat = (typeof SECURITY_REPORT_FORMATS)[number];
