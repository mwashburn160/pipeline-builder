// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseSynthFailure, SYNTH_FAILURE_MARKER, type SynthFailure } from '@pipeline-builder/pipeline-core/lib/core/synth-failure.js';
import { loadSdk, log } from './util.js';

// Structured failure reasons for failed CodeBuild actions.
//
// A CodePipeline action-failure event carries only CodeBuild's generic summary
// ("Error while executing command: … exit status 1"), never the build output —
// so WHY a synth refused a plugin (not installed, denied by policy, bad signature)
// was readable only in the build log. `pipeline-manager pipeline synth` prints
// one `PB_SYNTH_FAILURE {…}` line when it fails inside CodeBuild; this module
// finds that line in the failed build's CloudWatch log stream.
//
// In-account and best-effort: BatchGetBuilds → the build's log group/stream →
// FilterLogEvents for the marker. Any failure (no permission, logs not yet
// flushed, no marker) yields null and the event is forwarded without it — a
// missing reason must never hold up event ingestion. Requires
// `codebuild:BatchGetBuilds` + `logs:FilterLogEvents` (events-stack.json).
//
// The SDK clients come from the Lambda runtime (variable-specifier load, like
// CodeCommit/SQS), so they are not dependencies of this package.

interface SdkClient { send(command: unknown): Promise<unknown> }
interface CodeBuildModule {
  CodeBuildClient: new (config: { region: string }) => SdkClient;
  BatchGetBuildsCommand: new (input: { ids: string[] }) => unknown;
}
interface LogsModule {
  CloudWatchLogsClient: new (config: { region: string }) => SdkClient;
  FilterLogEventsCommand: new (input: {
    logGroupName: string; logStreamNames: string[]; filterPattern: string; limit: number;
  }) => unknown;
}

type Loader = <T>(pkg: string) => Promise<T>;
let loader: Loader = loadSdk;
const clients = new Map<string, SdkClient>();

/** @internal Test-only: substitute the SDK loader (and drop cached clients). */
export function _setFailureReasonLoaderForTests(next: Loader | undefined): void {
  loader = next ?? loadSdk;
  clients.clear();
}

async function client(kind: 'codebuild' | 'logs', region: string): Promise<{ client: SdkClient; mod: CodeBuildModule | LogsModule }> {
  const mod = kind === 'codebuild'
    ? await loader<CodeBuildModule>('@aws-sdk/client-codebuild')
    : await loader<LogsModule>('@aws-sdk/client-cloudwatch-logs');
  const key = `${kind}:${region}`;
  let c = clients.get(key);
  if (!c) {
    c = kind === 'codebuild'
      ? new (mod as CodeBuildModule).CodeBuildClient({ region })
      : new (mod as LogsModule).CloudWatchLogsClient({ region });
    clients.set(key, c);
  }
  return { client: c, mod };
}

/** A CodeBuild build id: `<project>:<uuid>`. */
const BUILD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,254}:[0-9a-f-]{36}$/;

/**
 * The build id of a failed CodeBuild action, from the event detail; null for a
 * non-CodeBuild action or an event that carries no external execution id.
 */
export function codeBuildIdOf(detail: Record<string, unknown>): string | null {
  const type = detail.type as { provider?: unknown } | undefined;
  if (type?.provider !== undefined && type.provider !== 'CodeBuild') return null;
  const result = detail['execution-result'] as { 'external-execution-id'?: unknown } | undefined;
  const id = result?.['external-execution-id'];
  return typeof id === 'string' && BUILD_ID_RE.test(id) ? id : null;
}

/** Find the `PB_SYNTH_FAILURE` line in a failed build's log, or null. */
export async function readSynthFailure(region: string, buildId: string): Promise<SynthFailure | null> {
  try {
    const cb = await client('codebuild', region);
    const out = await cb.client.send(new (cb.mod as CodeBuildModule).BatchGetBuildsCommand({ ids: [buildId] })) as {
      builds?: Array<{ logs?: { groupName?: string; streamName?: string } }>;
    };
    const logs = out.builds?.[0]?.logs;
    if (!logs?.groupName || !logs.streamName) return null;

    const cw = await client('logs', region);
    const res = await cw.client.send(new (cw.mod as LogsModule).FilterLogEventsCommand({
      logGroupName: logs.groupName,
      logStreamNames: [logs.streamName],
      filterPattern: `"${SYNTH_FAILURE_MARKER}"`,
      limit: 5,
    })) as { events?: Array<{ message?: string }> };
    for (const event of res.events ?? []) {
      const failure = typeof event.message === 'string' ? parseSynthFailure(event.message) : null;
      if (failure) return failure;
    }
    return null;
  } catch (err) {
    log.warn('Could not read the failed build\'s structured failure reason (forwarding without it)', {
      buildId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
