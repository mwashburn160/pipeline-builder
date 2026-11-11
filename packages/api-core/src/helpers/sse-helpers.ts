// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Request, Response } from 'express';
import { AppError } from '../errors/app-errors.js';
import { ErrorCode } from '../types/error-codes.js';
import { errorMessage, sendError } from '../utils/response.js';

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

/** How an AI failure is answered: an HTTP status, a code, and a message WE wrote. */
export interface AIErrorResponse {
  status: number;
  code: ErrorCode;
  /** Safe to show: never raw provider response text. */
  message: string;
  /** Seconds, from the provider's own `Retry-After` when it sent one. */
  retryAfterSeconds?: number;
}

/** The fields of an ai-sdk `APICallError` this classifier reads (duck-typed: api-core does not depend on `ai`). */
interface ProviderCallError {
  statusCode?: unknown;
  responseHeaders?: Record<string, string | undefined>;
}

/** `Retry-After` as seconds — either form the header allows (delta-seconds or an HTTP date). */
function retryAfterSeconds(headers: Record<string, string | undefined> | undefined): number | undefined {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (!raw) return undefined;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber >= 0) return Math.ceil(asNumber);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/** True for an abort that came from a TIMEOUT signal rather than a client disconnect. */
function isTimeout(error: unknown): boolean {
  const e = error as { name?: unknown; cause?: { name?: unknown } } | null;
  return e?.name === 'TimeoutError' || e?.cause?.name === 'TimeoutError';
}

/**
 * Classify an AI failure into the response a caller sends.
 *
 * Provider failures are matched on the provider's HTTP STATUS (`APICallError.statusCode`),
 * never on message text, and answered with a sentence of ours: a provider's error body
 * can carry account ids, request ids, quota details or an echo of the prompt, and none
 * of it belongs in a response or an SSE frame. The full error still goes to the
 * caller's log line.
 *
 *  - 429 → 429 (with the provider's `Retry-After`): the provider is rate limiting.
 *  - 529 / 5xx → 503 (with `Retry-After`): the provider is overloaded or down.
 *  - 401 / 403 → 502: the provider refused the credential (a BYO or org key is wrong).
 *  - a timeout signal → 504.
 *  - an {@link AppError} (AIDisabledError, AIConfigurationError, …) → its own status and message.
 *  - otherwise the configuration messages the registry writes (they name env vars,
 *    never values) keep their text; anything else gets `fallbackMessage`.
 */
export function classifyAIError(error: unknown, fallbackMessage: string): AIErrorResponse {
  if (error instanceof AppError) {
    return { status: error.statusCode, code: error.code, message: error.message };
  }
  const providerStatus = typeof (error as ProviderCallError | null)?.statusCode === 'number'
    ? (error as ProviderCallError).statusCode as number
    : undefined;
  if (providerStatus !== undefined) {
    const retryAfter = retryAfterSeconds((error as ProviderCallError).responseHeaders);
    const withRetry = retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {};
    if (providerStatus === 429) {
      return { status: 429, code: ErrorCode.RATE_LIMIT_EXCEEDED, message: 'The AI provider is rate limiting requests. Try again shortly.', ...withRetry };
    }
    if (providerStatus === 529 || providerStatus >= 500) {
      return { status: 503, code: ErrorCode.SERVICE_UNAVAILABLE, message: 'The AI provider is temporarily unavailable. Try again shortly.', ...withRetry };
    }
    if (providerStatus === 401 || providerStatus === 403) {
      return { status: 502, code: ErrorCode.INTERNAL_ERROR, message: 'The AI provider rejected the API key used for this request. Check the key in Settings, or the one you supplied.' };
    }
    // A 4xx that is not 401/403/429: the provider understood us and refused.
    // The BODY never surfaces — it carries org ids, request ids and the prompt
    // (see the leak assertions in handle-ai-error.test.ts) — but the STATUS is
    // a bare number and is the only thing that makes this refusal diagnosable.
    // The case that drove this: a self-hosted OpenAI-compatible server that
    // rejects the `tools` field answers 400, and the Ask AGENT always sends
    // tools, so the whole feature failed with a message that named nothing.
    return {
      status: 502,
      code: ErrorCode.INTERNAL_ERROR,
      message: `${fallbackMessage} — the AI provider refused the request (HTTP ${providerStatus}). Check the service log for the reason.`,
    };
  }
  if (isTimeout(error)) {
    return { status: 504, code: ErrorCode.SERVICE_UNAVAILABLE, message: 'The AI provider did not respond in time. Try again, or ask for something smaller.' };
  }

  const message = typeof error === 'string' ? error : errorMessage(error);
  if (message.includes('not configured') || message.includes('API key')) {
    // Surface the ORIGINAL message. Only the registry's own configuration errors
    // reach here (a provider's response carries a status and was handled above):
    // they name the MISSING CONFIGURATION — "no provider API key is set and
    // OPENAI_COMPATIBLE_BASE_URL is unset", or which env var a named provider
    // wants — never a secret VALUE, and are the only thing that makes this error
    // actionable.
    return { status: 500, code: ErrorCode.INTERNAL_ERROR, message };
  }
  if (message.includes('not available for provider')) {
    return { status: 400, code: ErrorCode.VALIDATION_ERROR, message };
  }
  return { status: 500, code: ErrorCode.INTERNAL_ERROR, message: fallbackMessage };
}

/**
 * Answer an AI generation failure: an HTTP error before the stream started, or an
 * SSE `error` event (then end) once it has. Takes the ERROR, not its message — the
 * provider status is what decides the answer (see {@link classifyAIError}); a string
 * is still accepted for the registry's configuration messages.
 */
export function handleAIError(res: Response, error: unknown, fallbackMessage: string): void {
  const answer = classifyAIError(error, fallbackMessage);
  if (!res.headersSent) {
    if (answer.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(answer.retryAfterSeconds));
    return sendError(res, answer.status, answer.message, answer.code);
  }
  res.write(`data: ${JSON.stringify({
    type: 'error',
    message: answer.message,
    code: answer.code,
    status: answer.status,
    ...(answer.retryAfterSeconds !== undefined ? { retryAfterSeconds: answer.retryAfterSeconds } : {}),
  })}\n\n`);
  res.end();
}
