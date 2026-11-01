// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * GDPR erasure for ecosystem content a deleted person left behind.
 *
 * Its own module rather than a function on the reviews store, because the
 * CALLER is platform's user-deletion cascade and not the plugin service. The
 * reviews store (`api/plugin/src/services/ecosystem/reviews-store.ts`) belongs
 * to the plugin service, which platform cannot import; the erasure has to live
 * where both the schema and platform can reach it.
 *
 * Not `public-directory.ts` either: that module reads through
 * `getPublicReaderDb()`, a deliberately read-only connection for the
 * unauthenticated directory, and a write has no business there.
 */

import { eq } from 'drizzle-orm';
import { schema } from '../database/drizzle-schema.js';
import { withTenantTx } from '../database/tenancy.js';

/**
 * Scrub a deleted user's authorship from their listing reviews.
 *
 * THE RATING SURVIVES; the person does not. A rating is part of a listing's
 * aggregate score that other customers rely on, so deleting the row would
 * silently rewrite a public number for every reader of that listing. What has to
 * go is the personal data: who wrote it, the display name shown beside it, and
 * the prose — free text, and therefore the part that can contain anything about
 * them.
 *
 * `authorOrgId` is DELIBERATELY KEPT. It is never exposed (it feeds the
 * integrity rules — no self-review, the per-org rate limit, verified-use), it
 * identifies the ORGANISATION rather than the person, and dropping it would
 * disarm those anti-gaming rules for every review the account ever left.
 *
 * IDEMPOTENT by construction: the predicate is `author_user_id = $1`, so a
 * second run matches nothing. That is what makes it safe to call POST-COMMIT
 * and at-least-once — which is where the caller must put it, because
 * `withMongoTransaction` RETRIES its body on a transient error and anything
 * inside it runs once per attempt.
 *
 * Returns how many reviews were scrubbed, so the caller can audit the figure and
 * skip the audit row entirely when there were none.
 */
export async function anonymizeReviewsByAuthor(userId: string): Promise<number> {
  if (!userId) return 0;
  const rows = await withTenantTx((tx) => tx
    .update(schema.pluginReview)
    .set({
      authorUserId: null,
      authorDisplayName: null,
      bodyMd: null,
      bodyHtml: null,
    })
    .where(eq(schema.pluginReview.authorUserId, userId))
    .returning({ id: schema.pluginReview.id }));
  return rows.length;
}
