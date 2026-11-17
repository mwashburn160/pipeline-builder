// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ApiError } from './errors';

/**
 * Optimistic concurrency for edit forms.
 *
 * The update endpoints for user-edited records (pipelines, plugins, pipeline
 * templates, compliance rules and policies) take an optional
 * `expectedUpdatedAt` — the `updatedAt` of the copy the form was opened with.
 * If the record changed since, the server refuses the write with a 412
 * `PRECONDITION_FAILED` instead of silently overwriting the other edit; the
 * form then says so and offers a reload.
 */

/** The server's error code for an optimistic-concurrency refusal. A plain
 *  string, not api-core's `ErrorCode` enum (that would pull the server barrel
 *  into the client bundle). */
export const PRECONDITION_FAILED = 'PRECONDITION_FAILED';

/** What an edit form shows when its save was refused as a concurrent edit. */
export const CONCURRENCY_CONFLICT_MESSAGE = 'This was changed by someone else since you opened it. Reload to see the latest.';

/** `true` when `err` is the server's 412 refusal of a stale edit. */
export function isConcurrencyConflict(err: unknown): boolean {
  return err instanceof ApiError && (err.statusCode === 412 || err.code === PRECONDITION_FAILED);
}

/**
 * The `expectedUpdatedAt` to send for a record the form loaded: its
 * `updatedAt`, exactly as read (an ISO string, or a `Date` normalized to one).
 * `undefined` when the record carries none — the write is then last-write-wins.
 */
export function expectedUpdatedAtOf(record: { updatedAt?: string | Date | null } | null | undefined): string | undefined {
  const v = record?.updatedAt;
  if (!v) return undefined;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v.toISOString();
  return v;
}
