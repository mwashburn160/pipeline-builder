// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, type MutableRefObject } from 'react';
import type { StreamEvent } from '@/lib/api/core';
import { formatError, formatJSON } from '@/lib/constants';

/** Per-invocation configuration for a single AI streaming generation run. */
export interface AiStreamRun<TDone> {
  /** The SSE generator to consume (e.g. `api.streamPluginGeneration(...)`). */
  stream: AsyncGenerator<StreamEvent>;
  /** Called on the terminal `done` event with the typed payload. */
  onDone: (payload: TDone) => void;
  /**
   * Optional side-effect on each `partial` event, in addition to the preview
   * update the hook already performs (e.g. deriving a stage count).
   */
  onPartial?: (data: unknown) => void;
  /**
   * Optional handler for non-core event types (`analyzing`, `analyzed`,
   * `checking-plugins`, `creating-plugins`). Core types (`partial`/`done`/
   * `error`) are handled by the hook and never forwarded here.
   */
  onEvent?: (event: StreamEvent) => void;
  /**
   * Optional cancellation guard. When `.current` is true the loop stops
   * consuming events and the hook skips all terminal setState calls (used when
   * the component unmounts or the user switches tabs mid-stream).
   */
  cancelledRef?: MutableRefObject<boolean>;
  /**
   * Optional extra cleanup run in `finally` (guarded by `cancelledRef`), e.g.
   * clearing an "analyzing" flag or the streaming preview.
   */
  onSettled?: () => void;
}

/** Return value of {@link useAiStreamGeneration}. */
export interface UseAiStreamGenerationResult {
  /** Whether a generation stream is currently in flight. */
  generating: boolean;
  /** Latest error message, or null. */
  error: string | null;
  /** Latest JSON preview string (from `partial`/`done`), or null. */
  preview: string | null;
  /** Set the error message (e.g. for client-side validation failures). */
  setError: (message: string | null) => void;
  /** Set the preview string directly (e.g. from a tab-specific `onDone`). */
  setPreview: (value: string | null) => void;
  /** Consume an SSE stream, driving generating/error/preview state. */
  generate: <TDone>(run: AiStreamRun<TDone>) => Promise<void>;
}

/**
 * Owns the shared generating/error/preview state and the SSE consumption loop
 * used by the AI generation tabs (prompt, git-url, plugin).
 *
 * `generate` sets `generating` true and clears error/preview up front, then
 * iterates the stream: `partial` updates the preview (plus optional
 * `onPartial`), `done` invokes the typed `onDone`, `error` sets the error, and
 * any other event type is forwarded to `onEvent`. Errors are caught into the
 * error state and `generating` is cleared in `finally` — both guarded by the
 * optional `cancelledRef` so a dead component is never updated.
 */
export function useAiStreamGeneration(): UseAiStreamGenerationResult {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const generate = async <TDone>(run: AiStreamRun<TDone>): Promise<void> => {
    const { stream, onDone, onPartial, onEvent, cancelledRef, onSettled } = run;
    const isCancelled = () => cancelledRef?.current ?? false;

    setError(null);
    setGenerating(true);
    setPreview(null);

    try {
      for await (const event of stream) {
        if (isCancelled()) break; // unmounted/tab-switched mid-stream — stop reading
        switch (event.type) {
          case 'partial':
            if (event.data) {
              setPreview(formatJSON(event.data));
              onPartial?.(event.data);
            }
            break;
          case 'done':
            if (event.data) onDone(event.data as TDone);
            break;
          case 'error':
            setError(event.message || 'Generation failed');
            break;
          default:
            onEvent?.(event);
        }
      }
    } catch (err: unknown) {
      if (!isCancelled()) setError(formatError(err, 'Generation failed'));
    } finally {
      if (!isCancelled()) {
        setGenerating(false);
        onSettled?.();
      }
    }
  };

  return { generating, error, preview, setError, setPreview, generate };
}
