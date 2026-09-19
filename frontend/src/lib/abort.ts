// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Abort helpers shared by the fetch hooks, the query cache and the API client.
 *
 * Aborting is a NORMAL outcome here — a superseded keystroke, a route change, an
 * unmounted panel — so every layer needs one agreed way to recognise it and drop
 * it silently instead of rendering "Failed to load" at somebody who simply typed
 * another character.
 */

/** The canonical abort rejection. `DOMException` where it exists (browsers,
 *  jsdom), a name-tagged `Error` in any environment that lacks it. */
export function abortError(message = 'The operation was aborted'): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError') as unknown as Error;
  }
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/**
 * True when `err` is a deliberate cancellation rather than a failure.
 *
 * Deliberately NOT true for the API client's request timeout: that aborts with a
 * plain string reason ("Request timeout after …ms"), which `fetch` rejects with
 * verbatim. A timeout is a real failure the user must see, so it has to stay
 * distinguishable from "you typed another character".
 */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
