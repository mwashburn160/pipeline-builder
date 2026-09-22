// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * One HTTP path for the observability backends (Prometheus, Loki,
 * Alertmanager) and one mapping from their failures to HTTP responses.
 *
 * Failures are categorized, not thrown as raw exceptions, so the route layer
 * can tell "our query was rejected" from "the backend is not there":
 *
 *   - `upstream-4xx` — the backend answered and refused the request. No
 *     user-supplied text reaches a backend query unescaped, so this is our bug.
 *   - `unreachable`  — connection failure, timeout, or a 5xx. On a LEAN deploy
 *     (no prometheus/alertmanager/loki) this is the normal state, and a 5xx is
 *     the backend being unhealthy — neither is a catalog bug.
 */

import { createLogger, errorMessage, sendError, sendSuccess } from '@pipeline-builder/api-core';
import type { Response } from 'express';

const logger = createLogger('observability-upstream');

export type UpstreamError =
  | { kind: 'upstream-4xx'; status: number; message: string }
  | { kind: 'unreachable'; message: string };

export function isUpstreamError(err: unknown): err is UpstreamError {
  return !!err && typeof err === 'object'
    && ((err as { kind?: unknown }).kind === 'upstream-4xx' || (err as { kind?: unknown }).kind === 'unreachable');
}

/** Build the "backend answered but refused" error (also used for a 200 carrying a non-success envelope). */
export function upstreamRejected(status: number, message: string): UpstreamError {
  return { kind: 'upstream-4xx', status, message };
}

export interface CallUpstreamOptions {
  /** Backend name for log lines and fallback messages ("Prometheus", "Loki", …). */
  backend: string;
  timeoutMs: number;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** `json` (default) parses the 2xx body; `none` discards it (e.g. a bodiless DELETE). */
  parse?: 'json' | 'none';
  /** Extra fields for the warn log (never put tenant lists here). */
  logContext?: Record<string, unknown>;
}

/** Pull a readable message out of an error body: a JSON `error`/`message` field, else the raw text. */
function errorBodyMessage(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error;
    if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return text.slice(0, 300) || undefined;
}

/**
 * Call a backend and return its parsed body. Throws an {@link UpstreamError}
 * for connection failures, timeouts and non-2xx responses (5xx → `unreachable`,
 * 4xx → `upstream-4xx`).
 */
export async function callUpstream<T>(url: string, opts: CallUpstreamOptions): Promise<T> {
  let res: globalThis.Response;
  try {
    res = await fetch(url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    const e: UpstreamError = { kind: 'unreachable', message: errorMessage(err) };
    logger.warn(`${opts.backend} unreachable`, { ...opts.logContext, error: e.message });
    throw e;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const message = errorBodyMessage(text) || `${opts.backend} returned ${res.status}`;
    const e: UpstreamError = res.status >= 500
      ? { kind: 'unreachable', message }
      : upstreamRejected(res.status, message);
    logger.warn(res.status >= 500 ? `${opts.backend} unhealthy` : `${opts.backend} rejected request`, {
      ...opts.logContext, status: res.status, message,
    });
    throw e;
  }

  if (opts.parse === 'none') return undefined as T;
  return await res.json() as T;
}

export interface UpstreamFailureMessages {
  /** 500 body when the backend rejected our request. */
  rejected: string;
  /** 502 body when the backend is unreachable and the route does not degrade. */
  unreachable: string;
}

/**
 * Map a backend failure to a response. With `degradeTo`, an unreachable
 * backend yields `200 { ...degradeTo, degraded: true }` so a dashboard renders a
 * clean empty state; without it (writes) it is a 502. A rejection is always a
 * 500, since only our own query building can produce one.
 */
export function sendUpstreamFailure(
  res: Response,
  err: unknown,
  messages: UpstreamFailureMessages,
  degradeTo?: Record<string, unknown>,
): void {
  const kind = isUpstreamError(err) ? err.kind : undefined;
  if (kind === 'unreachable' && degradeTo) {
    sendSuccess(res, 200, { ...degradeTo, degraded: true });
    return;
  }
  if (kind === 'upstream-4xx') {
    sendError(res, 500, messages.rejected);
    return;
  }
  sendError(res, 502, messages.unreachable);
}
