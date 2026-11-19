// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import api from '@/lib/api';
import type { ApiResponse } from '@/types';
import type { QueuedRunRequest, RunRequest, RunRequestStatus } from '@/lib/api/domains/pipelines';
import { ApiError } from '@/lib/api/errors';
import { TERMINAL_RUN_REQUEST_STATUSES, isTerminalExecutionStatus } from '@/lib/pipeline-runners';

/** Poll cadence: 1 s, then ×1.5 up to 5 s between reads. A request the server
 *  still reports pending a minute past its `expiresAt` is treated as expired
 *  (the sweep may lag); and nothing is followed for more than 15 minutes (a
 *  request whose reads were failing when a limit hit is "lost", not expired).
 *  Once a run has STARTED, its `executionStatus` is followed every 10 s while
 *  it is non-terminal, for at most an hour. */
export const RUN_REQUEST_POLL = {
  initialMs: 1000,
  factor: 1.5,
  maxMs: 5000,
  expiryGraceMs: 60_000,
  hardCapMs: 15 * 60_000,
  executionMs: 10_000,
  executionCapMs: 60 * 60_000,
} as const;

/** A queued Re-run / Stop the page is following. `phase: 'running'` = the run
 *  started and its execution is being followed until it finishes. */
export interface TrackedRunRequest {
  requestId: string;
  action: 'start' | 'stop';
  runnerLabel: string;
  status: RunRequestStatus;
  phase: 'queued' | 'running';
  executionId?: string | null;
  executionStatus?: string | null;
}

/** How a followed request moved on. `started` may be followed by `finished`
 *  (the execution's terminal state) when the server reports `executionStatus`.
 *  `lost`: the page could no longer READ the request (a final refusal of the
 *  status read, or reads still failing at a limit) — its outcome is unknown,
 *  and it may still go ahead. */
export type RunRequestOutcome =
  | { kind: 'started' | 'stopped'; request: TrackedRunRequest; executionId: string | null }
  | { kind: 'finished'; request: TrackedRunRequest; executionId: string | null; executionStatus: string }
  | { kind: 'failed'; request: TrackedRunRequest; errorCode: string | null }
  | { kind: 'lost'; request: TrackedRunRequest; error: unknown };

type PollResult =
  | { status: 'started' | 'stopped'; executionId: string | null; executionStatus: string | null; runnerLabel: string | null }
  | { status: 'failed'; errorCode: string | null; runnerLabel: string | null }
  | { status: 'lost'; error: unknown; runnerLabel: string | null };

/** An execution state a Stop ends in (normalized like `isTerminalExecutionStatus`). */
function isStoppedExecutionStatus(s: string): boolean {
  return ['stopped', 'canceled', 'cancelled'].includes(s.toLowerCase().replace(/[\s_-]/g, ''));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/** Network errors, 429 and 5xx are worth another read; any other refusal is final. */
function isTransient(e: unknown): boolean {
  return !(e instanceof ApiError) || e.statusCode === 429 || e.statusCode >= 500 || e.statusCode === 0;
}

/**
 * Read a run request with backoff until it reaches a terminal state. Resolves
 * `null` once `signal` aborts (unmount) — no read is made after that. A
 * transient failure (network, 429, 5xx) is retried; any other refusal of the
 * READ ends it as `lost` — it says nothing about the request itself.
 */
export async function pollRunRequest(
  read: (signal: AbortSignal) => Promise<ApiResponse<RunRequest>>,
  opts: { signal: AbortSignal; onUpdate?: (r: RunRequest) => void; now?: () => number },
): Promise<PollResult | null> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  let delay: number = RUN_REQUEST_POLL.initialMs;
  let expiresAt: number | null = null;
  let label: string | null = null;
  /** The last read's failure; `undefined` once a read succeeds. */
  let lastFailure: unknown;
  for (;;) {
    await sleep(delay, opts.signal);
    if (opts.signal.aborted) return null;
    delay = Math.min(Math.round(delay * RUN_REQUEST_POLL.factor), RUN_REQUEST_POLL.maxMs);
    try {
      const res = await read(opts.signal);
      if (opts.signal.aborted) return null;
      lastFailure = res.success && res.data ? undefined : new Error(res.message || 'The request could not be read');
      if (res.success && res.data) {
        const r = res.data;
        label = r.runnerLabel ?? label;
        opts.onUpdate?.(r);
        if (TERMINAL_RUN_REQUEST_STATUSES.has(r.status)) {
          if (r.status === 'started' || r.status === 'stopped') {
            return { status: r.status, executionId: r.executionId, executionStatus: r.executionStatus ?? null, runnerLabel: label };
          }
          if (r.status === 'expired') return { status: 'failed', errorCode: r.errorCode || 'RUN_REQUEST_EXPIRED', runnerLabel: label };
          return { status: 'failed', errorCode: r.errorCode, runnerLabel: label };
        }
        const exp = Date.parse(r.expiresAt);
        if (Number.isFinite(exp)) expiresAt = exp;
      }
    } catch (e) {
      if (opts.signal.aborted) return null;
      if (!isTransient(e)) return { status: 'lost', error: e, runnerLabel: label };
      lastFailure = e;
    }
    const t = now();
    if ((expiresAt !== null && t > expiresAt + RUN_REQUEST_POLL.expiryGraceMs) || t - startedAt > RUN_REQUEST_POLL.hardCapMs) {
      // "Expired" (nothing was started or stopped) only on the server's word:
      // a request whose reads were failing may have been delivered meanwhile.
      if (lastFailure !== undefined) return { status: 'lost', error: lastFailure, runnerLabel: label };
      return { status: 'failed', errorCode: 'RUN_REQUEST_EXPIRED', runnerLabel: label };
    }
  }
}

/**
 * After a run STARTED: re-read the request every 10 s while its
 * `executionStatus` is non-terminal. Resolves the terminal status, or `null`
 * on abort, a final refusal, a missing status, or the hour cap.
 */
export async function pollExecutionStatus(
  read: (signal: AbortSignal) => Promise<ApiResponse<RunRequest>>,
  opts: { signal: AbortSignal; onUpdate?: (r: RunRequest) => void; now?: () => number },
): Promise<string | null> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  for (;;) {
    await sleep(RUN_REQUEST_POLL.executionMs, opts.signal);
    if (opts.signal.aborted) return null;
    try {
      const res = await read(opts.signal);
      if (opts.signal.aborted) return null;
      if (res.success && res.data) {
        opts.onUpdate?.(res.data);
        const s = res.data.executionStatus;
        if (!s) return null;
        if (isTerminalExecutionStatus(s)) return s;
      }
    } catch (e) {
      if (opts.signal.aborted || !isTransient(e)) return null;
    }
    if (now() - startedAt > RUN_REQUEST_POLL.executionCapMs) return null;
  }
}

/**
 * Follow the queued Re-run / Stop requests of ONE pipeline (the detail page is
 * keyed by pipeline id, so a switch remounts it). Every poll stops on a
 * terminal state or when the component unmounts; `onSettled` fires per
 * transition (never after unmount). A followed execution that ends stopped
 * after THIS page's Stop of it settled is not reported again (the Stop already
 * was).
 */
export function useRunRequestTracker(pipelineId: string, onSettled: (outcome: RunRequestOutcome) => void) {
  const [active, setActive] = useState<TrackedRunRequest[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const settledRef = useRef(onSettled);
  /** Executions a Stop from this page was delivered for. */
  const stoppedHere = useRef(new Set<string>());
  useEffect(() => { settledRef.current = onSettled; });
  useEffect(() => {
    const map = controllers.current;
    return () => {
      for (const c of map.values()) c.abort();
      map.clear();
    };
  }, []);

  const track = useCallback((queued: QueuedRunRequest, action: 'start' | 'stop') => {
    const { requestId } = queued;
    controllers.current.get(requestId)?.abort();
    const ctl = new AbortController();
    controllers.current.set(requestId, ctl);
    const entry: TrackedRunRequest = { requestId, action, runnerLabel: queued.runnerLabel, status: queued.status, phase: 'queued' };
    setActive((a) => [...a.filter((x) => x.requestId !== requestId), entry]);
    const read = (signal: AbortSignal) => api.getRunRequest(pipelineId, requestId, { signal });
    const patch = (r: RunRequest) => setActive((a) => a.map((x) => (x.requestId === requestId
      ? { ...x, status: r.status, runnerLabel: r.runnerLabel || x.runnerLabel, executionId: r.executionId ?? x.executionId, executionStatus: r.executionStatus ?? x.executionStatus }
      : x)));
    const done = () => {
      controllers.current.delete(requestId);
      setActive((a) => a.filter((x) => x.requestId !== requestId));
    };

    void (async () => {
      const result = await pollRunRequest(read, { signal: ctl.signal, onUpdate: patch });
      if (!result || ctl.signal.aborted) return;
      const label = result.runnerLabel || entry.runnerLabel;
      if (result.status === 'lost') {
        done();
        settledRef.current({ kind: 'lost', request: { ...entry, runnerLabel: label }, error: result.error });
        return;
      }
      if (result.status === 'failed') {
        done();
        settledRef.current({ kind: 'failed', request: { ...entry, status: 'failed', runnerLabel: label }, errorCode: result.errorCode });
        return;
      }
      if (result.status === 'stopped' && result.executionId) stoppedHere.current.add(result.executionId);
      const request: TrackedRunRequest = { ...entry, status: result.status, runnerLabel: label, executionId: result.executionId, executionStatus: result.executionStatus };
      settledRef.current({ kind: result.status, request, executionId: result.executionId });
      // A started run whose execution is still going: keep following it, slower.
      if (result.status !== 'started' || !result.executionStatus || isTerminalExecutionStatus(result.executionStatus)) {
        done();
        return;
      }
      setActive((a) => a.map((x) => (x.requestId === requestId ? { ...request, phase: 'running' } : x)));
      const final = await pollExecutionStatus(read, { signal: ctl.signal, onUpdate: patch });
      if (ctl.signal.aborted) return;
      done();
      if (!final) return;
      if (result.executionId && isStoppedExecutionStatus(final) && stoppedHere.current.has(result.executionId)) return;
      settledRef.current({ kind: 'finished', request: { ...request, executionStatus: final }, executionId: result.executionId, executionStatus: final });
    })();
  }, [pipelineId]);

  return { active, track };
}
