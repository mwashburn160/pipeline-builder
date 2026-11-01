// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The GDPR scrub of a deleted user's listing reviews.
 *
 * What it keeps matters as much as what it removes, and both are deliberate:
 *
 *  - the RATING survives, because it is part of a listing's public aggregate
 *    that other customers rely on — deleting the row would silently rewrite a
 *    number every reader of that listing sees;
 *  - `authorOrgId` survives, because it is never exposed, it identifies the
 *    ORGANISATION rather than the person, and it is what the anti-gaming rules
 *    (no self-review, per-org rate limit, verified-use) run on;
 *  - everything that names the person goes: the user id, the display name shown
 *    beside the review, and the body, which is free text and therefore the part
 *    that can contain anything at all about them.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fakeTx, type FakeTx } from './helpers/fake-tx.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

let tx: FakeTx;
jest.unstable_mockModule('../src/database/postgres-connection.js', () => ({ db: {} }));
jest.unstable_mockModule('../src/database/tenancy.js', () => ({
  withTenantTx: (fn: (t: unknown) => unknown) => fn(tx.tx),
  runWithTenantContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  getTenantContext: () => undefined,
  tenantContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { anonymizeReviewsByAuthor } = await import('../src/api/ecosystem-privacy.js');

beforeEach(() => { tx = fakeTx(); });

const set = () => tx.queries[0]?.arg('set') as Record<string, unknown> | undefined;

describe('anonymizeReviewsByAuthor', () => {
  it('nulls every field that names the person', async () => {
    tx.queue([{ id: 'r1' }, { id: 'r2' }]);
    await expect(anonymizeReviewsByAuthor('u-1')).resolves.toBe(2);
    expect(set()).toEqual({
      authorUserId: null,
      authorDisplayName: null,
      bodyMd: null,
      bodyHtml: null,
    });
  });

  it('KEEPS the rating — it is a public aggregate, not personal data', async () => {
    // Deleting the row, or nulling the rating, would silently rewrite the score
    // every reader of that listing sees.
    tx.queue([{ id: 'r1' }]);
    await anonymizeReviewsByAuthor('u-1');
    expect(set()).not.toHaveProperty('rating');
  });

  it('KEEPS authorOrgId, which the anti-gaming rules run on', async () => {
    // Never exposed, identifies the org rather than the person — and dropping it
    // would disarm no-self-review, the per-org rate limit and verified-use for
    // every review the account ever left.
    tx.queue([{ id: 'r1' }]);
    await anonymizeReviewsByAuthor('u-1');
    expect(set()).not.toHaveProperty('authorOrgId');
  });

  it('matches on the AUTHOR, which is what makes it idempotent', async () => {
    // The predicate is `author_user_id = $1`, so a second run matches nothing.
    // That is what lets the caller run it POST-COMMIT and at-least-once —
    // `withMongoTransaction` retries its body, so anything inside the cascade
    // would run once per attempt.
    tx.queue([{ id: 'r1' }]);
    await anonymizeReviewsByAuthor('u-1');
    expect(tx.queries[0]?.whereSql()).toMatch(/author_user_id/i);
  });

  it('reports 0 for a user who left no reviews, without pretending otherwise', async () => {
    tx.queue([]);
    await expect(anonymizeReviewsByAuthor('u-1')).resolves.toBe(0);
  });

  it('short-circuits an empty user id without querying', async () => {
    await expect(anonymizeReviewsByAuthor('')).resolves.toBe(0);
    expect(tx.queries).toHaveLength(0);
  });
});
