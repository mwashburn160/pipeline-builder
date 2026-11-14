// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A non-2xx answer from a peer service (internal-http). The message is
 * status-only — never the downstream body, which can carry stack traces, SQL or
 * another request's details; `code` is the peer's machine-readable `ErrorCode`
 * when it sent one (a closed enum, safe to act on) and nothing else from the body.
 *
 * Its own module so the tool layer can recognise it without loading the HTTP
 * client and its config.
 */
export class DownstreamError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'DownstreamError';
  }
}
