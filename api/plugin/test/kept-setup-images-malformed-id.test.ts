// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `promoteKeptSetupImage` against a REAL Postgres (PGlite) with a malformed id.
 *
 * `plugin_kept_setup_image.id` is a `uuid` column and the id arrives straight
 * from the route param (`POST /plugins/kept-setup-images/:id/promote`).
 * Comparing a uuid column to a non-uuid string is a Postgres cast error
 * (22P02), which `withRoute` answers with a 400 — so a typo'd or probing id read
 * as a bad request instead of the 404 an unknown id gets. The in-memory fake
 * db compares strings and never showed it.
 */

import { describe, it, expect, afterAll, jest } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';

const realPipelineData = await import('@pipeline-builder/pipeline-data');
const { SYSTEM_ORG_ID } = await import('@pipeline-builder/api-core');
const { bootTestDb } = await import('./helpers/pglite-db.js');
const testDb = await bootTestDb(() => realPipelineData.getTenantContext());

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  ...realPipelineData,
  withTenantTx: testDb.withTenantTx,
}));

const { promoteKeptSetupImage } = await import('../src/services/kept-setup-images.js');

afterAll(async () => { await testDb.raw.close(); });

const actor = { orgId: SYSTEM_ORG_ID, userId: 'mod-1' };
const asSystemOrg = <T>(fn: () => Promise<T>): Promise<T> =>
  realPipelineData.runWithTenantContext({ orgId: SYSTEM_ORG_ID, isSuperAdmin: false }, fn);

describe('promoteKeptSetupImage with a malformed id', () => {
  it.each([['not-a-uuid'], [''], ['1111']])('answers 404 NOT_FOUND (not a cast error) for %j', async (id) => {
    await expect(asSystemOrg(() => promoteKeptSetupImage(id, actor))).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('still answers 404 for an unknown, well-formed id (the query runs)', async () => {
    await expect(asSystemOrg(() => promoteKeptSetupImage('00000000-0000-4000-8000-000000000000', actor)))
      .rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });
});
