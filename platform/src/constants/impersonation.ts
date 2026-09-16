// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Impersonation timing constants.
 *
 * Deliberately in a module with NO imports. The token helper and the request
 * service both need these, and many test suites mock the models barrel with a
 * partial object — importing a constant through that barrel broke every such
 * suite each time a new one was added. A dependency-free module is never mocked
 * and pulls in no mongoose, so it cannot fail that way.
 */

/**
 * How long an issued impersonation SESSION token lives. The single source of
 * truth: the token helper mints with it and the sessions list bounds "live" by
 * it. Two copies would drift, and the list would then offer to revoke sessions
 * that already ended, or hide ones still running.
 */
export const IMPERSONATION_SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes
