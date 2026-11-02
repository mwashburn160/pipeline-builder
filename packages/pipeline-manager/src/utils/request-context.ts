// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { correlationHeaders, sanitizeCorrelationValue } from '@pipeline-builder/pipeline-core';

/**
 * The audit-correlation headers every platform call from this CLI carries, so
 * a server-side audit row joins back to the run that caused it.
 *
 * - `X-Request-Id` — the command's execution id (the `[EXE-…]` printed in the
 *   header and the local audit log), or a uuid for this process when no command
 *   header was printed.
 * - `X-CodeBuild-Build-Id` — CODEBUILD_BUILD_ID (`<project>:<uuid>`) when running
 *   inside CodeBuild.
 * - `X-Pipeline-Execution-Id` — PIPELINE_EXECUTION_ID, which the synth injects into
 *   every CodeBuild step from `#{codepipeline.PipelineExecutionId}`. Sent only
 *   when set: CODEBUILD_INITIATOR (`codepipeline/<name>`) names the pipeline, not
 *   the execution, so nothing is derived from it.
 * - `X-Pipeline-Id` — the platform pipeline a command works on (synth, deploy,
 *   plugin verify, security-report), once the command knows it
 *   ({@link setPipelineId}). The quota service's usage ledger records it, so
 *   "what spent our calls?" can answer "this pipeline's builds".
 *
 * Never an ARN — nothing here can carry an AWS account id.
 */

let invocationId: string | undefined;
let pipelineId: string | undefined;

/** The header the platform's quota attribution reads the pipeline from. */
export const PIPELINE_ID_HEADER = 'X-Pipeline-Id';

/** Name the pipeline this invocation's platform calls are made for (unset with `undefined`). */
export function setPipelineId(id: string | undefined): void {
  pipelineId = id;
}

/** Adopt the command's execution id as this invocation's request id. */
export function setInvocationId(id: string): void {
  invocationId = id;
}

/** This invocation's request id — the command's execution id, else a per-process uuid. */
export function getInvocationId(): string {
  invocationId ??= randomUUID();
  return invocationId;
}

/** The correlation headers for this invocation (values sanitized, unknown ids omitted). */
export function requestCorrelationHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const inCodeBuild = Boolean(env.CODEBUILD_BUILD_ID);
  const headers = correlationHeaders({
    requestId: getInvocationId(),
    codeBuildBuildId: inCodeBuild ? env.CODEBUILD_BUILD_ID : undefined,
    pipelineExecutionId: inCodeBuild ? env.PIPELINE_EXECUTION_ID : undefined,
  });
  // Same sanitizer as the other ids: a value that isn't a plain id is dropped,
  // never sent mangled.
  const pipeline = sanitizeCorrelationValue(pipelineId);
  if (pipeline) headers[PIPELINE_ID_HEADER] = pipeline;
  return headers;
}

/** @internal Test-only: forget the invocation id. */
export function _resetInvocationIdForTests(): void {
  invocationId = undefined;
  pipelineId = undefined;
}
