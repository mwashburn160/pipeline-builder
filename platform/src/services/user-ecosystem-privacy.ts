// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * GDPR erasure of a deleted user's ecosystem content.
 *
 * WHY THIS EXISTED ONLY AS A COMMENT UNTIL NOW. `plugin_reviews` documented the
 * behaviour in its own schema — "GDPR user deletion anonymizes: `authorUserId`
 * and the body go NULL, the rating stays" — and `plugin.review.anonymize` was
 * declared in the audit-action list for it. Nothing implemented either.
 * `deleteUserCascade` is Mongo-only and never reaches Postgres, so a deleted
 * user's review body and user id persisted indefinitely while the code asserted
 * the opposite.
 *
 * BEST-EFFORT, NOT FATAL. The user is already gone from Mongo by the time this
 * runs; throwing here would turn a completed deletion into a failed request and
 * invite the operator to retry a delete that already happened. A failure is
 * logged and counted so it is visible and recoverable instead.
 *
 * Its own module rather than inline in `user-admin-service`, because this is the
 * place a SECOND erasure target gets added — and the next person should find one
 * function that names everything scrubbed, not a growing block inside a delete
 * method.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { anonymizeReviewsByAuthor, runWithTenantContext } from '@pipeline-builder/pipeline-data';
import { incCounter } from '../observability/metrics.js';
import { audit } from '../helpers/audit.js';
import type { Request } from 'express';

const logger = createLogger('user-ecosystem-privacy');

/**
 * Scrub everything in Postgres that identifies `userId`.
 *
 * Runs under a SUPERADMIN tenant context, which is required rather than
 * convenient: reviews are RLS-scoped by `authorOrgId`, and one person may have
 * reviewed from several organisations over time. A deletion that only reached
 * the org the request happened to carry would leave the rest of their prose in
 * place — a partial erasure, which is worse than a failed one because nothing
 * reports it.
 *
 * Returns the number of reviews scrubbed. `req` is optional so the audit row
 * carries a real actor when a person drove the deletion, and is simply omitted
 * when the caller is a sweep.
 */
export async function anonymizeUserEcosystemContent(userId: string, req?: Request): Promise<number> {
  try {
    const reviews = await runWithTenantContext(
      { orgId: 'system', isSuperAdmin: true },
      () => anonymizeReviewsByAuthor(userId),
    );
    if (reviews > 0) {
      logger.info('Anonymized ecosystem content for a deleted user', { userId, reviews });
      // Audited because an erasure is the one thing a data-protection request
      // has to be able to EVIDENCE. Metadata only: the count, never the prose
      // that was removed — putting the scrubbed body in the audit trail would
      // defeat the erasure it is recording.
      if (req) {
        audit(req, 'plugin.review.anonymize', {
          targetType: 'user',
          targetId: userId,
          details: { reviews },
        });
      }
    }
    return reviews;
  } catch (err) {
    // Counted, not thrown: the user is already deleted from Mongo by now, and
    // failing the request would invite a retry of a delete that already
    // happened. This is the signal that an erasure needs finishing by hand.
    //
    // THE REPORTING ITSELF MUST NOT THROW. `incCounter` raises when the metrics
    // registry has not been wired, so an unguarded call here turned a LOGGED
    // failure into a THROWN one — straight out of the catch block, past the
    // "never throws" contract above, and into a failed `deleteUserById` for a
    // user who had in fact been deleted. An integration test against a real
    // replica set caught it; the unit tests could not, because they mock
    // `incCounter`. A failure handler that can fail is not a failure handler.
    try {
      incCounter('user_erasure_incomplete_total', { store: 'postgres' });
    } catch {
      // Nothing useful left to do: the log line below is the last resort.
    }
    logger.error('Failed to anonymize ecosystem content for a deleted user', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}
