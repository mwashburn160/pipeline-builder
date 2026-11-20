// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseSynthFailure, SYNTH_FAILURE_MARKER, type SynthFailure } from '@pipeline-builder/pipeline-core/runtime';
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

/** What `BatchGetBuilds` answers, for the two things this module reads off it. */
interface BatchGetBuildsOutput {
  builds?: Array<{
    logs?: { groupName?: string; streamName?: string };
    environment?: { computeType?: string };
    phases?: Array<{ phaseType?: string; startTime?: unknown; endTime?: unknown; durationInSeconds?: number }>;
  }>;
}

/**
 * How long a build WAITED before it ran: CodeBuild's QUEUED phase (waiting for
 * capacity) and PROVISIONING phase (the build environment being set up), in ms.
 * A phase AWS did not report is absent, never zero — zero would read as
 * "no wait", which is the most flattering guess.
 */
export interface BuildPhases {
  queuedMs?: number;
  provisioningMs?: number;
}

/** What a terminal CodeBuild action's one `BatchGetBuilds` read yields. */
export interface BuildFacts {
  computeType: string | null;
  phases: BuildPhases | null;
}

/** One phase's length: exact start/end when AWS gave both, else its whole-second duration. */
function phaseMs(p: { startTime?: unknown; endTime?: unknown; durationInSeconds?: number }): number | undefined {
  const toMs = (v: unknown) => (v instanceof Date || typeof v === 'string' || typeof v === 'number' ? new Date(v).getTime() : NaN);
  const exact = toMs(p.endTime) - toMs(p.startTime);
  if (Number.isFinite(exact) && exact >= 0) return Math.round(exact);
  const d = p.durationInSeconds;
  return typeof d === 'number' && Number.isFinite(d) && d >= 0 ? Math.round(d * 1000) : undefined;
}

/** The QUEUED / PROVISIONING durations off a build record, or null when neither is there. */
export function buildPhasesOf(phases: Array<{ phaseType?: string; startTime?: unknown; endTime?: unknown; durationInSeconds?: number }> | undefined): BuildPhases | null {
  if (!Array.isArray(phases)) return null;
  const out: BuildPhases = {};
  for (const p of phases) {
    const ms = phaseMs(p);
    if (ms === undefined) continue;
    if (p.phaseType === 'QUEUED') out.queuedMs = ms;
    else if (p.phaseType === 'PROVISIONING') out.provisioningMs = ms;
  }
  return out.queuedMs === undefined && out.provisioningMs === undefined ? null : out;
}
interface LogsModule {
  CloudWatchLogsClient: new (config: { region: string }) => SdkClient;
  FilterLogEventsCommand: new (input: {
    logGroupName: string; logStreamNames: string[]; filterPattern: string; limit: number; nextToken?: string;
  }) => unknown;
}

/**
 * Pages of `FilterLogEvents` to follow before giving up. The API searches a
 * bounded slice of the stream per call and may answer a page with NO events and
 * a `nextToken` even though a match lies further on — so reading only the first
 * page missed the marker on any build whose log was long enough to span slices.
 */
const MAX_FILTER_PAGES = 10;

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

/**
 * The compute size a finished CodeBuild action ran on, AS AWS SPELLS IT
 * (`BUILD_GENERAL1_MEDIUM`), or null — plus its queue / provisioning wait
 * ({@link BuildPhases}), or null.
 *
 * Returned raw and narrowed server-side rather than here, for one hard reason:
 * this Lambda ships as a SINGLE bundled file, and the vocabulary lives in the
 * pipeline-core barrel, which carries dynamic imports that break that constraint
 * (`test/single-file-constraint.test.ts` is the check). Sending the raw string
 * also keeps the stored `detail.computeType` the observation rather than an
 * interpretation of it.
 *
 * WHY IT IS READ FROM AWS rather than from our own stored pipeline config: the
 * config holds a step's REQUESTED compute type, and what the build actually ran
 * on is what consumed vCPU — a pipeline edited between the start and the finish
 * would otherwise be priced against the new value. `BatchGetBuilds` answers the
 * authoritative one, and this Lambda already holds that permission for the
 * failure-reason read below.
 *
 * Best-effort, like everything else here: a throttle or a missing permission
 * yields null, the event forwards without the field, and the ingest records that
 * action as unmeasured rather than as free. A size that cannot be read must not
 * be guessed — SMALL is the cheapest and therefore the most flattering guess.
 *
 * NOT folded into {@link readSynthFailure}, which makes the same call: that one
 * runs on FAILED actions only, this one on every terminal CodeBuild action, and
 * sharing a cache between them would mean holding build records for the whole
 * batch to save one call on the minority path.
 */
export async function readBuildCompute(region: string, buildId: string): Promise<BuildFacts> {
  try {
    const cb = await client('codebuild', region);
    const out = await cb.client.send(
      new (cb.mod as CodeBuildModule).BatchGetBuildsCommand({ ids: [buildId] }),
    ) as BatchGetBuildsOutput;
    const build = out.builds?.[0];
    // The queue / provisioning wait rides the SAME read: the record already
    // carries its phases, so the Flow report costs no extra AWS call. CodeBuild
    // "Build State Change" events carry the phases too, but they name a build
    // PROJECT, not a pipeline (a project can be shared), so they are dropped
    // before this point — the pipeline's own action event is the one that can
    // be attributed to a (pipeline, stage, action).
    return { computeType: build?.environment?.computeType ?? null, phases: buildPhasesOf(build?.phases) };
  } catch (err) {
    log.warn('Could not read the build\'s compute size (forwarding without it)', {
      buildId, error: String(err),
    });
    return { computeType: null, phases: null };
  }
}

/** Find the `PB_SYNTH_FAILURE` line in a failed build's log, or null. */
export async function readSynthFailure(region: string, buildId: string): Promise<SynthFailure | null> {
  try {
    const cb = await client('codebuild', region);
    const out = await cb.client.send(
      new (cb.mod as CodeBuildModule).BatchGetBuildsCommand({ ids: [buildId] }),
    ) as BatchGetBuildsOutput;
    const logs = out.builds?.[0]?.logs;
    if (!logs?.groupName || !logs.streamName) return null;

    const cw = await client('logs', region);
    let nextToken: string | undefined;
    for (let page = 0; page < MAX_FILTER_PAGES; page++) {
      const res = await cw.client.send(new (cw.mod as LogsModule).FilterLogEventsCommand({
        logGroupName: logs.groupName,
        logStreamNames: [logs.streamName],
        filterPattern: `"${SYNTH_FAILURE_MARKER}"`,
        limit: 5,
        ...(nextToken ? { nextToken } : {}),
      })) as { events?: Array<{ message?: string }>; nextToken?: string };
      for (const event of res.events ?? []) {
        const failure = typeof event.message === 'string' ? parseSynthFailure(event.message) : null;
        if (failure) return failure;
      }
      if (!res.nextToken || res.nextToken === nextToken) return null;
      nextToken = res.nextToken;
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
