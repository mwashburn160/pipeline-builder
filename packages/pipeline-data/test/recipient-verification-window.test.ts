// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The recipient verification window against REAL SQL (the shipped
 * `postgres-init.sql` on PGlite): add → resend → verify through the store
 * itself. The window is measured from when the CURRENT token was minted, so a
 * link re-sent after the first week still verifies, and the original link of
 * a recipient nobody re-sent to still expires.
 */

import type { PGlite } from '@electric-sql/pglite';
import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { drizzle } from 'drizzle-orm/pglite';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { bootInitDb } from './helpers/pglite-init.js';

let pg: PGlite;
let db: ReturnType<typeof drizzle>;

jest.unstable_mockModule('../src/database/postgres-connection.js', () => ({ db: {} }));
jest.unstable_mockModule('../src/database/tenancy.js', () => ({
  withTenantTx: (fn: (t: unknown) => unknown) => fn(db),
  runWithTenantContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  getTenantContext: () => undefined,
  tenantContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { StakeholderReportStore, RECIPIENT_VERIFICATION_TTL_MS } = await import('../src/api/reporting/stakeholder/store.js');

const ORG = 'acme';
const DAY = 24 * 60 * 60 * 1000;
const DAY0 = new Date('2026-09-01T12:00:00.000Z');
const at = (days: number) => new Date(DAY0.getTime() + days * DAY);

beforeAll(async () => {
  pg = await bootInitDb();
  db = drizzle(pg);
}, 120_000);
afterAll(async () => { await pg?.close(); });

describe('recipient verification window', () => {
  const store = new StakeholderReportStore();

  it('is the 7-day window this suite measures against', () => {
    expect(RECIPIENT_VERIFICATION_TTL_MS).toBe(7 * DAY);
  });

  it('a link RE-SENT after day 7 verifies', async () => {
    const { recipient, verificationToken } = await store.upsertRecipient({ orgId: ORG, email: 'late@partner.test', createdBy: 'lead', now: DAY0 });
    expect(verificationToken).toBeDefined();
    const { token } = await store.resendVerification(ORG, recipient.id, at(8));
    // The row was added nine days ago; the token in hand is one day old.
    const verified = await store.verifyRecipientByToken(token, at(9));
    expect(verified?.id).toBe(recipient.id);
    expect(verified?.verifiedAt).toEqual(at(9));
    expect(verified?.verificationIssuedAt).toBeNull();
  });

  it('the re-sent link expires 7 days after it was sent, and the one it replaced is dead', async () => {
    const { recipient, verificationToken } = await store.upsertRecipient({ orgId: ORG, email: 'slow@partner.test', createdBy: 'lead', now: DAY0 });
    const { token } = await store.resendVerification(ORG, recipient.id, at(8));
    expect(await store.verifyRecipientByToken(verificationToken!, at(9))).toBeNull();
    expect(await store.verifyRecipientByToken(token, at(15))).toBeNull();
  });

  it('a link nobody re-sent still expires after 7 days', async () => {
    const { verificationToken } = await store.upsertRecipient({ orgId: ORG, email: 'never@partner.test', createdBy: 'lead', now: DAY0 });
    expect(await store.verifyRecipientByToken(verificationToken!, at(8))).toBeNull();
  });

  it('re-adding an unverified address restarts the window with its new token', async () => {
    await store.upsertRecipient({ orgId: ORG, email: 'again@partner.test', createdBy: 'lead', now: DAY0 });
    const { verificationToken } = await store.upsertRecipient({ orgId: ORG, email: 'again@partner.test', createdBy: 'lead', now: at(10) });
    expect(verificationToken).toBeDefined();
    expect((await store.verifyRecipientByToken(verificationToken!, at(11)))?.email).toBe('again@partner.test');
  });
});
