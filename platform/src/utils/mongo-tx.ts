// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose, { type ClientSession } from 'mongoose';

/**
 * Wrap a MongoDB transaction body. Centralises the 7-copy
 * `startSession / withTransaction / endSession` boilerplate previously
 * scattered across `auth-service`, `organization-service`,
 * `invitation-service`, and `org-members-service`.
 *
 * The session is automatically committed / aborted by `withTransaction`
 * (Mongoose retries transient errors per the driver contract) and is
 * always ended even when the body throws.
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
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
