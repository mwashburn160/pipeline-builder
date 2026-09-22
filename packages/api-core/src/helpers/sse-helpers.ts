// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Request, Response } from 'express';
import { sendBadRequest, sendInternalError } from '../utils/response.js';

/**
 * Set the four standard SSE response headers (does NOT flush — the caller flushes
 * after any additional per-endpoint setup like `res.setTimeout`). The single
 * source of truth for the `text/event-stream` + no-cache + keep-alive +
 * `X-Accel-Buffering: no` (disable nginx buffering) block.
 */
export function writeSseHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
}

/** The slice of an Express/Node response needed to observe a client disconnect. */
interface ClosableResponse {
  on(event: 'close', listener: () => void): unknown;
  readonly writableFinished: boolean;
}

/**
 * An AbortSignal that fires when the client disconnects before the response
 * finished — cancels a provider call (avoids wasted spend) and tells the route
 * to stop writing.
 *
 * Disconnect is detected on the RESPONSE: `res` emits 'close' when the
 * underlying connection goes away, and `writableFinished` tells an early close
 * (client gone) from the normal close after `res.end()`. The request's own
 * 'close' is not a disconnect signal — on current Node it fires once the request
 * BODY has been consumed (express.json() does that before the handler runs), so
 * a disconnect would never be observed.
 */
export function clientAbortSignal(res: ClosableResponse): AbortSignal {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

/** An open SSE response. */
export interface SseStream {
  /** Aborted when the client disconnects before the stream finished. */
  readonly signal: AbortSignal;
  /** True once the client has disconnected. */
  aborted(): boolean;
  /** Write one `data:` frame carrying `event` as JSON. A no-op after a disconnect. */
  send(event: unknown): void;
  /** Write the terminal `data: [DONE]` frame (preceded by `event`, when given).
   *  A no-op after a disconnect. The caller still ends the response. */
  done(event?: unknown): void;
}

/**
 * Set SSE response headers, flush, and return the stream's writer plus its
 * client-disconnect signal (see {@link clientAbortSignal}).
 */
export function initSSEStream(_req: Request, res: Response, timeoutMs: number): SseStream {
  writeSseHeaders(res);
  res.setTimeout(timeoutMs);
  res.flushHeaders();
  const signal = clientAbortSignal(res);
  const send = (event: unknown): void => {
    if (signal.aborted) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  return {
    signal,
    aborted: () => signal.aborted,
    send,
    done: (event?: unknown): void => {
      if (signal.aborted) return;
      if (event !== undefined) send(event);
      res.write('data: [DONE]\n\n');
    },
  };
}

/**
 * Classify AI generation errors and send the appropriate HTTP response or SSE event.
 * If headers are already sent (streaming), writes an SSE error event and ends the response.
 */
export function handleAIError(res: Response, message: string, fallbackMessage: string): void {
  if (!res.headersSent) {
    if (message.includes('not configured') || message.includes('API key')) {
      // Surface the ORIGINAL message. It names the MISSING CONFIGURATION —
      // "no provider API key is set and OPENAI_COMPATIBLE_BASE_URL is unset",
      // or which env var a named provider wants — never a secret VALUE, so it
      // is safe to show and it is the only thing that makes this error
      // actionable. The generic replacement also mis-described the common case:
      // it said "for the requested provider" when no provider was requested at
      // all, pointing operators at a provider bug instead of at configuration.
      return sendInternalError(res, message);
    }
    if (message.includes('not available for provider')) {
      return sendBadRequest(res, message);
    }
    return sendInternalError(res, fallbackMessage, { details: message });
  }
  res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
  res.end();
}
