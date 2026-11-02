// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit-correlation headers the platform's clients send so a server-side audit
 * row can be joined back to the run that caused it — the CLI invocation, the
 * CodeBuild build, the CodePipeline execution, the Lambda request, the
 * EventBridge event. api-core reads exactly these names into audit context.
 *
 * None of them may carry an AWS account id: a CodeBuild build id is
 * `<project>:<uuid>`, an execution id is a uuid, a Lambda request id is a uuid.
 * An ARN is NEVER sent here — callers must not pass one.
 *
 * Dependency-free so the plugin-lookup, token-renew and event-ingest Lambdas
 * (each a single bundled file) can import it.
 */
export const REQUEST_ID_HEADER = 'X-Request-Id';
export const PIPELINE_EXECUTION_ID_HEADER = 'X-Pipeline-Execution-Id';
export const CODEBUILD_BUILD_ID_HEADER = 'X-CodeBuild-Build-Id';

/** The longest correlation value sent; the server caps at the same bound. */
export const MAX_CORRELATION_VALUE = 128;

/**
 * A header-safe correlation value, or undefined when nothing usable is left.
 * Keeps printable ASCII only — CR/LF (header injection) and other control or
 * non-ASCII bytes are dropped — and caps the length.
 */
export function sanitizeCorrelationValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[^\x21-\x7e]/g, '').slice(0, MAX_CORRELATION_VALUE);
  return clean.length > 0 ? clean : undefined;
}

/**
 * The correlation headers for a run, each included only when its value
 * survives sanitizing. `requestId` is required in spirit (every caller has one);
 * the build + execution ids only when genuinely known.
 */
export function correlationHeaders(ids: {
  requestId?: string;
  pipelineExecutionId?: string;
  codeBuildBuildId?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  const requestId = sanitizeCorrelationValue(ids.requestId);
  const executionId = sanitizeCorrelationValue(ids.pipelineExecutionId);
  const buildId = sanitizeCorrelationValue(ids.codeBuildBuildId);
  if (requestId) headers[REQUEST_ID_HEADER] = requestId;
  if (executionId) headers[PIPELINE_EXECUTION_ID_HEADER] = executionId;
  if (buildId) headers[CODEBUILD_BUILD_ID_HEADER] = buildId;
  return headers;
}
