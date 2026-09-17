// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The slice of an Express/Node response needed to observe a client disconnect. */
interface ClosableResponse {
  on(event: 'close', listener: () => void): unknown;
  readonly writableFinished: boolean;
}

/**
 * An AbortSignal that fires when the client disconnects before the response
 * finished — cancels the provider call (avoids wasted spend) and tells the
 * route to stop writing.
 *
 * Listens on the RESPONSE, not the request: on Node >= 16 `req` emits 'close'
 * as soon as its body has been fully consumed (express.json() does that before
 * the handler runs), so a `req.on('close')` listener attached in the handler
 * never fires on a later disconnect. `res` 'close' fires on disconnect OR after
 * a normal end — `writableFinished` distinguishes the two.
 */
export function clientAbortSignal(res: ClosableResponse): AbortSignal {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}
