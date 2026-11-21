// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A stored `smoke_test` that looks like a JSON literal ("true" — the canary
 * fixtures' smoke test) reaches the remediation engine as that command, on a
 * REAL Postgres. drizzle used to re-parse the driver's already-parsed jsonb
 * string into boolean `true`, so `smokeCommand` returned '' and every
 * apply-mode fix was forced to propose with `no_smoke_test`.
 */

import { describe, it, expect, afterAll } from '@jest/globals';
import { eq } from 'drizzle-orm';

const realPipelineData = await import('@pipeline-builder/pipeline-data');
const { bootTestDb } = await import('./helpers/pglite-db.js');
const { recordFromRow, smokeCommand } = await import('../src/services/remediation/publish.js');

const testDb = await bootTestDb(() => realPipelineData.getTenantContext());
const ORG = 'aaaaaaaaaaaaaaaaaaaaaaa7';
const asOrg = <T>(fn: (tx: any) => Promise<T>) => realPipelineData.runWithTenantContext({ orgId: ORG, isSuperAdmin: false }, () => testDb.withTenantTx(fn));

afterAll(async () => { await testDb.raw.close(); });

describe('remediation smoke test read from plugins.smoke_test', () => {
  it.each(['true', '1', 'make smoke'])('a stored %j is the smoke command the engine sees', async (stored) => {
    const { schema } = realPipelineData;
    const name = `smoke-${Math.random().toString(36).slice(2, 10)}`;
    const row = await asOrg(async (tx) => {
      await tx.insert(schema.plugin).values({ orgId: ORG, name, version: '1.0.0', smokeTest: stored });
      const [r] = await tx.select().from(schema.plugin).where(eq(schema.plugin.name, name));
      return r;
    });
    expect(smokeCommand(row.smokeTest)).toBe(stored);
    // engine.ts: hasSmokeTest = (plugin.smokeTest ?? '').trim() !== ''
    expect(recordFromRow(row).smokeTest).toBe(stored);
  });
});
