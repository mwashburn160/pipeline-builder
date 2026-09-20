// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The entitlement watermark store must issue NO runtime DDL. Services connect as
 * a non-superuser app role without CREATE on schema `public`; the table is owned
 * by postgres-init.sql. A lazy `CREATE TABLE IF NOT EXISTS` fails every
 * entitlement sync with "permission denied for schema public".
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { drizzleMock } from '@pipeline-builder/api-core/lib/testing/mock-drizzle.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

/** Every SQL text the store sends, reconstructed from the tagged-template chunks. */
const executed: string[] = [];
let selectRows: Array<{ last_occurred_at: string }> = [];

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('drizzle-orm', () => drizzleMock({
  sql: (strings: TemplateStringsArray, ..._values: unknown[]) => ({ text: strings.join('?') }),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  drizzleRows: <T>(rows: T[]) => rows,
  runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn(),
  withTenantTx: async (fn: (tx: unknown) => unknown) => fn({
    execute: async (q: { text: string }) => {
      executed.push(q.text);
      return { rows: /SELECT/i.test(q.text) ? selectRows : [] };
    },
  }),
}));

const { EntitlementWatermarkStore } = await import('../src/services/entitlement-watermark-store.js');

const DDL = /\b(CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/i;

describe('EntitlementWatermarkStore — no runtime DDL', () => {
  beforeEach(() => { executed.length = 0; selectRows = []; });

  it('getLastOccurredAt issues only a SELECT', async () => {
    selectRows = [{ last_occurred_at: '2026-09-01T00:00:00.000Z' }];
    const at = await new EntitlementWatermarkStore().getLastOccurredAt('org-1');
    expect(at).toEqual(new Date('2026-09-01T00:00:00.000Z'));
    expect(executed).toHaveLength(1);
    expect(executed.some((q) => DDL.test(q))).toBe(false);
  });

  it('record issues only the conditional upsert', async () => {
    await new EntitlementWatermarkStore().record('org-1', new Date('2026-09-02T00:00:00.000Z'));
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatch(/INSERT INTO compliance_entitlement_watermark/);
    expect(executed.some((q) => DDL.test(q))).toBe(false);
  });
});
