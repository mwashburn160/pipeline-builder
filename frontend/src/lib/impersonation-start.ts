// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiResponse } from '@/types';
import type { ImpersonationStartDto } from '@/lib/api/domains/admin';

/** What to do with the response to starting, break-glassing, or redeeming a session. */
export type ImpersonationStartOutcome =
  /** Nothing to start yet: someone else must approve first. Not a failure. */
  | { kind: 'waiting'; requestId: string; awaitingSecondAdministrator: boolean }
  /** A token was issued — swap it in, keeping the request id for a server-side stop. */
  | { kind: 'started'; accessToken: string; requestId: string }
  | { kind: 'failed'; message: string };

/**
 * Interpret a session-start response. The one place that decision is made, so
 * every entry point (view as user, emergency access, opening an approved
 * request) treats a waiting request the same way.
 *
 * `waiting` is checked FIRST, and deliberately. Under a consent policy the call
 * succeeds but carries no token; a check that looked only for a token would
 * report the consent flow working as an error, and the operator would retry a
 * request that is actually sitting in someone's approval queue.
 */
export function interpretImpersonationStart(
  res: ApiResponse<ImpersonationStartDto>,
  fallbackMessage: string,
): ImpersonationStartOutcome {
  if (!res.success) return { kind: 'failed', message: res.message || fallbackMessage };

  const data = res.data;
  if (data?.status === 'pending') {
    return {
      kind: 'waiting',
      requestId: data.requestId,
      awaitingSecondAdministrator: data.awaiting === 'second_sysadmin',
    };
  }
  if (data?.accessToken) {
    return { kind: 'started', accessToken: data.accessToken, requestId: data.requestId };
  }
  return { kind: 'failed', message: res.message || fallbackMessage };
}
