// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  createSubmission, getSubmissionChallenge, inspectSubmission,
} from '@/lib/api/domains/plugin-submissions';
import { isAbortError } from '@/lib/abort';
import { solveInWorker } from '@/lib/plugin-submissions/proof-of-work';
import {
  classifySubmissionError, fileProblem, formProblems, initialSubmitFlowState, submitFlowReducer,
} from '@/lib/plugin-submissions/submit-flow';
import type { PluginCatalogEdits } from '@/types';
import type { ProofOfWorkSolution } from '@/types/plugin-submissions';

/** Progress re-renders at most this often (a batch finishes every few ms). */
const PROGRESS_INTERVAL_MS = 100;

/**
 * Drives the anonymous submission flow ({@link submitFlowReducer}): every
 * guarded call first fetches a single-use proof-of-work challenge and solves it
 * in a Web Worker, reporting progress. Choosing another file, or unmounting,
 * cancels whatever is running.
 */
export function usePluginSubmission() {
  const [state, dispatch] = useReducer(submitFlowReducer, initialSubmitFlowState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const running = useRef<AbortController | null>(null);

  useEffect(() => () => running.current?.abort(), []);

  const start = () => {
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    return controller.signal;
  };

  const solvePow = useCallback(async (signal: AbortSignal): Promise<ProofOfWorkSolution> => {
    dispatch({ type: 'phase', phase: 'challenge' });
    const challenge = await getSubmissionChallenge({ signal });
    dispatch({ type: 'phase', phase: 'solving', difficulty: challenge.difficulty });
    let last = 0;
    const { nonce } = await solveInWorker(challenge.challenge, challenge.difficulty, {
      signal,
      onProgress: (attempts) => {
        const now = Date.now();
        if (now - last < PROGRESS_INTERVAL_MS) return;
        last = now;
        dispatch({ type: 'progress', attempts });
      },
    });
    dispatch({ type: 'phase', phase: 'uploading' });
    return { challenge: challenge.challenge, nonce };
  }, []);

  /**
   * Run a guarded call with a fresh proof-of-work. A refused proof (expired
   * while the tab slept, or already used) is re-solved once before failing.
   */
  const guarded = useCallback(async <T,>(signal: AbortSignal, call: (pow: ProofOfWorkSolution) => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const pow = await solvePow(signal);
      try {
        return await call(pow);
      } catch (err) {
        if (attempt > 0 || signal.aborted || classifySubmissionError(err).kind !== 'pow') throw err;
      }
    }
  }, [solvePow]);

  const chooseFile = useCallback((file: File) => {
    const signal = start();
    dispatch({ type: 'file', file });
    if (fileProblem(file)) return;
    void (async () => {
      try {
        const result = await guarded(signal, (pow) => inspectSubmission(file, pow, { signal }));
        if (!signal.aborted) dispatch({ type: 'inspected', result });
      } catch (err) {
        if (signal.aborted || isAbortError(err)) return;
        dispatch({ type: 'failed', error: classifySubmissionError(err) });
      }
    })();
  }, [guarded]);

  const submit = useCallback(() => {
    const current = stateRef.current;
    dispatch({ type: 'submit' });
    if (current.step !== 'review' || !current.file) return;
    const problems = formProblems(current);
    if (problems.email || problems.acceptTerms) return;
    const signal = start();
    const { file, email, edits } = current;
    void (async () => {
      try {
        const created = await guarded(signal, (pow) => createSubmission({ file, email: email.trim(), pow, metadata: edits }, { signal }));
        if (!signal.aborted) dispatch({ type: 'submitted', id: created.id });
      } catch (err) {
        if (signal.aborted || isAbortError(err)) return;
        dispatch({ type: 'failed', error: classifySubmissionError(err) });
      }
    })();
  }, [guarded]);

  const setEdits = useCallback((edits: PluginCatalogEdits) => dispatch({ type: 'edits', edits }), []);
  const setEmail = useCallback((email: string) => dispatch({ type: 'email', email }), []);
  const setAcceptTerms = useCallback((accepted: boolean) => dispatch({ type: 'terms', accepted }), []);
  const reset = useCallback(() => { running.current?.abort(); dispatch({ type: 'reset' }); }, []);

  return { state, chooseFile, submit, setEdits, setEmail, setAcceptTerms, reset };
}
