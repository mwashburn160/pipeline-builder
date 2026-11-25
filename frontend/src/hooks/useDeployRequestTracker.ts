// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import { RUN_REQUEST_TTL_MS } from '@pipeline-builder/api-core/pipeline-runners';
import api from '@/lib/api';
import type { ApiResponse } from '@/types';
import type { DeployRequestDto, QueuedDeployDto } from '@/lib/api/domains/pipelines';
import { ApiError } from '@/lib/api/errors';
import { isFinishedDeployStatus } from '@/lib/pipeline-deploys';

/**
 * Poll cadence of a deploy: 2 s, then ×1.5 up to 10 s between reads. A deploy
 * is followed until it finishes, or until its deadline plus a grace has passed
 * with it still active — the deadline is `deadlineAt` once the runner accepted
 * it, else the 10-minute delivery lifetime from `requestedAt`. The server's
 * sweep marks it timed out / expired; the page only stops waiting ("lost").
 */
export const DEPLOY_POLL = {
  initialMs: 2000,
  factor: 1.5,
  maxMs: 10_000,
  /** The status poll (30 s) and the leader-locked sweep need a moment past the deadline. */
  deadlineGraceMs: 5 * 60_000,
  /** When neither a deadline nor a request time can be read. */
  fallbackCapMs: 125 * 60_000,
} as const;

export type DeployPollResult =
  | { kind: 'settled'; deploy: DeployRequestDto }
  | { kind: 'lost'; error: unknown; deploy: DeployRequestDto | null };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const onAbort = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Network errors, 429 and 5xx are worth another read; any other refusal is final. */
function isTransient(e: unknown): boolean {
  return !(e instanceof ApiError) || e.statusCode === 429 || e.statusCode >= 500 || e.statusCode === 0;
}

/** When the page stops waiting for `d` (ms since epoch), or null when unknown. */
function giveUpAt(d: DeployRequestDto | null): number | null {
  if (!d) return null;
  const deadline = d.deadlineAt ? Date.parse(d.deadlineAt) : NaN;
  if (Number.isFinite(deadline)) return deadline + DEPLOY_POLL.deadlineGraceMs;
  const requested = Date.parse(d.requestedAt);
  if (Number.isFinite(requested) && (d.status === 'queued' || d.status === 'delivering')) return requested + RUN_REQUEST_TTL_MS + DEPLOY_POLL.deadlineGraceMs;
  return null;
}

/**
 * Read a deploy with backoff until it finishes. Resolves `null` once `signal`
 * aborts (no read after that). Transient failures are retried; any other
 * refusal of the READ ends it as `lost` (it says nothing about the deploy).
 */
export async function pollDeployRequest(
  read: (signal: AbortSignal) => Promise<ApiResponse<DeployRequestDto>>,
  opts: { signal: AbortSignal; onUpdate?: (d: DeployRequestDto) => void; now?: () => number },
): Promise<DeployPollResult | null> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  let delay: number = DEPLOY_POLL.initialMs;
  let last: DeployRequestDto | null = null;
  for (;;) {
    await sleep(delay, opts.signal);
    if (opts.signal.aborted) return null;
    delay = Math.min(Math.round(delay * DEPLOY_POLL.factor), DEPLOY_POLL.maxMs);
    try {
      const res = await read(opts.signal);
      if (opts.signal.aborted) return null;
      if (res.success && res.data && typeof res.data.status === 'string') {
        last = res.data;
        opts.onUpdate?.(res.data);
        if (isFinishedDeployStatus(res.data.status)) return { kind: 'settled', deploy: res.data };
      }
    } catch (e) {
      if (opts.signal.aborted) return null;
      if (!isTransient(e)) return { kind: 'lost', error: e, deploy: last };
    }
    const t = now();
    const until = giveUpAt(last) ?? startedAt + DEPLOY_POLL.fallbackCapMs;
    if (t > until) {
      return { kind: 'lost', error: new Error('The deploy is still running past its deadline; reload to see its result.'), deploy: last };
    }
  }
}

/** A deploy the panel shows from its 202, before the first read. */
function fromQueued(pipelineId: string, q: QueuedDeployDto, runnerId: string | null): DeployRequestDto {
  return {
    requestId: q.requestId, pipelineId, status: q.status, stage: 'queued', runnerId: runnerId ?? '', runnerLabel: q.runnerLabel,
    region: q.region, errorCode: null, failureClass: null, retryable: false, requestedAt: new Date().toISOString(),
    acceptedAt: null, finishedAt: null, deadlineAt: null, logHint: null,
  };
}

/**
 * Follow ONE pipeline's deploy. On mount it resumes the pipeline's latest
 * deploy (GET …/deploys/latest): an active one is followed, a finished one is
 * shown. `track` follows a just-queued one, `follow` an id the server named
 * (an active deploy, a DEPLOY_IN_PROGRESS refusal). Every poll stops on
 * unmount; `onSettled` fires once per finished deploy this hook followed.
 */
export function useDeployRequestTracker(pipelineId: string, opts: { onSettled?: (d: DeployRequestDto) => void } = {}) {
  const [deploy, setDeploy] = useState<DeployRequestDto | null>(null);
  const [following, setFollowing] = useState(false);
  const [lost, setLost] = useState<unknown>(null);
  const [resumed, setResumed] = useState(false);
  const ctl = useRef<AbortController | null>(null);
  const settledRef = useRef(opts.onSettled);
  useEffect(() => { settledRef.current = opts.onSettled; });

  const follow = useCallback((requestId: string, seed?: DeployRequestDto) => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    if (seed) setDeploy(seed);
    setLost(null);
    setFollowing(true);
    void (async () => {
      const result = await pollDeployRequest(
        (signal) => api.getPipelineDeploy(pipelineId, requestId, { signal }),
        { signal: c.signal, onUpdate: (d) => { if (!c.signal.aborted) setDeploy(d); } },
      );
      if (!result || c.signal.aborted) return;
      setFollowing(false);
      if (result.kind === 'lost') { setLost(result.error); return; }
      setDeploy(result.deploy);
      settledRef.current?.(result.deploy);
    })();
  }, [pipelineId]);

  const track = useCallback((queued: QueuedDeployDto, runnerId: string | null = null) => {
    follow(queued.requestId, fromQueued(pipelineId, queued, runnerId));
  }, [follow, pipelineId]);

  /** Forget the shown deploy (Change runner / Deploy again). */
  const clear = useCallback(() => {
    ctl.current?.abort();
    ctl.current = null;
    setDeploy(null);
    setFollowing(false);
    setLost(null);
  }, []);

  useEffect(() => {
    const c = new AbortController();
    void (async () => {
      try {
        const res = await api.getLatestPipelineDeploy(pipelineId, { signal: c.signal });
        if (c.signal.aborted) return;
        const d = res.success ? res.data ?? null : null;
        if (d && typeof d.requestId === 'string' && typeof d.status === 'string') {
          if (isFinishedDeployStatus(d.status)) setDeploy(d);
          else follow(d.requestId, d);
        }
      } catch {
        // 404 (no deploy yet) or a failed read: nothing to resume.
      } finally {
        if (!c.signal.aborted) setResumed(true);
      }
    })();
    return () => {
      c.abort();
      ctl.current?.abort();
    };
  }, [pipelineId, follow]);

  return { deploy, following, lost, resumed, track, follow, clear };
}
