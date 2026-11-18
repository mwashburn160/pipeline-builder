// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose, { type ClientSession } from 'mongoose';

/**
 * Wrap a MongoDB transaction body: the one place a transaction is opened.
 *
 * Delegates to mongoose's `connection.transaction(fn)`, which runs the
 * driver's `session.withTransaction` (commit / abort, retry of the WHOLE body
 * on `TransientTransactionError`, retry of the commit on
 * `UnknownTransactionCommitResult`) AND resets the mongoose state
 * (`isNew`, modified paths, version key, array atomics) of every document
 * `save({ session })`d in an attempt whose body threw. Without that reset a
 * retried body that re-saves a document would see it as "already saved",
 * write nothing, while the body's query-level writes re-apply — a partial
 * commit.
 *
 * Caveat that bodies must still respect: mongoose only resets on a body
 * throw. A `TransientTransactionError` raised by the COMMIT also re-runs the
 * body, without a reset. So a body must be idempotent on its own: load the
 * documents it mutates INSIDE the body (with `{ session }`), or use
 * query-level updates (`updateOne` / `findOneAndUpdate`), rather than
 * mutating a document loaded before the transaction and `save()`-ing it.
 *
 * The session is always ended (mongoose ends it after commit / abort), and the
 * body's rejection — or the driver's commit error — propagates unchanged. The
 * body's return value is the helper's result.
 *
 * @example
 * const result = await withMongoTransaction(async (session) => {
 *   await User.updateOne({ _id }, { ... }, { session });
 *   return await Org.findOne({ _id: orgId }, null, { session });
 * });
 */
export async function withMongoTransaction<T>(
  fn: (session: ClientSession) => Promise<T>,
): Promise<T> {
  let result!: T;
  await mongoose.connection.transaction(async (session: ClientSession) => {
    result = await fn(session);
  });
  return result;
}
