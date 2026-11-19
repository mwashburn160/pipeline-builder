// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Ecosystem by-id reads against a REAL Postgres (PGlite) with a malformed id.
 *
 * Every ecosystem table is keyed by a `uuid` column, and the ids arrive straight
 * from route params (`/plugins/installs/:id`, `/plugins/publisher/listings/:listingId/pause`,
 * `/plugins/publish-requests/:id/withdraw`, the console's `/requests/:id`, …).
 * Comparing a uuid column to a non-uuid string is a Postgres cast error
 * (22P02), which `withRoute` answers with a 400 — so a typo'd or probing id
 * read as a bad request instead of the 404 an unknown id gets. The in-memory
 * double compares strings and never showed it.
 */

import { describe, it, expect, afterAll, jest } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';

const realPipelineData = await import('@pipeline-builder/pipeline-data');
const { bootTestDb } = await import('./helpers/pglite-db.js');
const testDb = await bootTestDb(() => realPipelineData.getTenantContext());

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  ...realPipelineData,
  withTenantTx: testDb.withTenantTx,
}));

const store = await import('../src/services/ecosystem/store.js');
const { installRows } = await import('../src/services/ecosystem/installs-store.js');
const { advisoryStore } = await import('../src/services/ecosystem/advisories-store.js');
const { reviews } = await import('../src/services/ecosystem/reviews-store.js');
const { submissions } = await import('../src/services/ecosystem/submissions-store.js');

afterAll(async () => { await testDb.raw.close(); });

const readers: Array<[string, (id: string) => Promise<unknown>]> = [
  ['publishers', (id) => store.publishers.byId(id)],
  ['listings', (id) => store.listings.byId(id)],
  ['requests', (id) => store.requests.byId(id)],
  ['rules', (id) => store.rules.byId(id)],
  ['plugins', (id) => store.plugins.byId(id)],
  ['installs', (id) => installRows.byId(id)],
  ['advisories', (id) => advisoryStore.byId(id)],
  ['reviews', (id) => reviews.byId(id)],
  ['submissions', (id) => submissions.byId(id)],
];

describe('ecosystem by-id reads with a malformed id', () => {
  it.each(readers)('%s.byId answers null (not a cast error) for a non-uuid id', async (_name, read) => {
    await expect(read('not-a-uuid')).resolves.toBeNull();
    await expect(read('')).resolves.toBeNull();
  });

  it.each(readers)('%s.byId still answers null for an unknown, well-formed id', async (_name, read) => {
    await expect(read('00000000-0000-4000-8000-000000000000')).resolves.toBeNull();
  });
});
