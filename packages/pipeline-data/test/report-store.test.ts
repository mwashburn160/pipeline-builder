// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The stakeholder-report store.
 *
 * What is worth pinning here is not "does it build an UPDATE" — it is the handful
 * of invariants that keep a report trustworthy, each of which has a plausible way
 * to regress silently:
 *
 *  - publishing is CONDITIONAL on the run being unpublished, so two clicks send one
 *    report;
 *  - a published run's narrative is FROZEN;
 *  - a share token is stored only as a hash, and a dead link is indistinguishable
 *    from an unknown one;
 *  - re-adding a recipient does NOT undo their unsubscribe;
 *  - the recipient policy is CLOSED by default — an org that configured nothing
 *    delivers to members only;
 *  - a purge takes a definition's runs and their links with it, so no live token
 *    can outlive the row it points at.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fakeTx, type FakeTx } from './helpers/fake-tx.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

let tx: FakeTx;
/** Tenant scopes `runWithTenantContext` was entered with, in order. */
let scopes: Array<{ orgId?: string; isSuperAdmin?: boolean }>;

jest.unstable_mockModule('../src/database/postgres-connection.js', () => ({ db: {} }));

jest.unstable_mockModule('../src/database/tenancy.js', () => ({
  withTenantTx: (fn: (t: unknown) => unknown) => fn(tx.tx),
  runWithTenantContext: <T>(ctx: { orgId?: string; isSuperAdmin?: boolean }, fn: () => T) => {
    scopes.push(ctx);
    return fn();
  },
  getTenantContext: () => undefined,
  tenantContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const {
  StakeholderReportStore,
  hashToken,
  mintToken,
  MAX_BOUNCES,
  MAX_SHARE_LINK_TTL_DAYS,
  DEFAULT_SHARE_LINK_TTL_DAYS,
} = await import('../src/api/reporting/stakeholder/store.js');

type Store = InstanceType<typeof StakeholderReportStore>;

const ORG = 'acme';
const NOW = new Date('2026-09-21T12:00:00.000Z');

/** A definition row, with only the fields a test cares about overridden. */
const definition = (over: Record<string, unknown> = {}) => ({
  id: 'def-1',
  orgId: ORG,
  ownerId: 'user-lead',
  name: 'Weekly delivery',
  template: 'weekly_delivery',
  sections: ['success_rate'],
  cadence: 'weekly',
  timezone: 'America/Chicago',
  weekStart: 'monday',
  scope: { kind: 'org' },
  recipients: [],
  autoSend: false,
  isActive: true,
  pausedReason: null,
  nextRunAt: null,
  lastRunAt: null,
  createdBy: 'user-lead',
  createdAt: NOW,
  updatedBy: null,
  updatedAt: NOW,
  deletedAt: null,
  deletedBy: null,
  purgeAfter: null,
  ...over,
});

const run = (over: Record<string, unknown> = {}) => ({
  id: 'run-1',
  orgId: ORG,
  definitionId: 'def-1',
  periodStart: new Date('2026-09-07T05:00:00.000Z'),
  periodEnd: new Date('2026-09-14T05:00:00.000Z'),
  periodLabel: '2026-W37',
  version: 1,
  status: 'ready_for_review',
  snapshot: { sections: [] },
  aiDraft: null,
  leadNotes: null,
  failureReason: null,
  publishedBy: null,
  publishedAt: null,
  supersededBy: null,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  deletedBy: null,
  purgeAfter: null,
  ...over,
});

const link = (over: Record<string, unknown> = {}) => ({
  id: 'link-1',
  orgId: ORG,
  runId: 'run-1',
  tokenHash: hashToken('a-token'),
  expiresAt: new Date('2026-10-21T12:00:00.000Z'),
  revokedAt: null,
  revokedBy: null,
  redactNames: false,
  viewCount: 0,
  lastViewedAt: null,
  createdBy: 'user-lead',
  createdAt: NOW,
  ...over,
});

const recipient = (over: Record<string, unknown> = {}) => ({
  id: 'rec-1',
  orgId: ORG,
  email: 'manager@acme.test',
  displayName: null,
  verifiedAt: NOW,
  verificationTokenHash: null,
  unsubscribedAt: null,
  bounceCount: 0,
  lastBounceAt: null,
  approvedBy: null,
  createdBy: 'user-lead',
  createdAt: NOW,
  deletedAt: null,
  deletedBy: null,
  purgeAfter: null,
  ...over,
});

describe('StakeholderReportStore', () => {
  let store: Store;

  beforeEach(() => {
    tx = fakeTx();
    scopes = [];
    store = new StakeholderReportStore();
  });

  // ── Tokens ────────────────────────────────────────────────────────────────

  describe('tokens', () => {
    it('stores only a hash, and the hash is not reversible to the token', () => {
      const { token, tokenHash } = mintToken();
      expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(tokenHash).not.toContain(token);
      expect(hashToken(token)).toBe(tokenHash);
    });

    it('mints a distinct token every time', () => {
      const tokens = new Set(Array.from({ length: 50 }, () => mintToken().token));
      expect(tokens.size).toBe(50);
    });
  });

  // ── Definitions ───────────────────────────────────────────────────────────

  describe('definitions', () => {
    it('creates a definition with a generated id and the caller as owner', async () => {
      tx.queue([definition()]);
      const created = await store.createDefinition({
        orgId: ORG,
        name: 'Weekly delivery',
        template: 'weekly_delivery',
        sections: ['success_rate'],
        cadence: 'weekly',
        timezone: 'America/Chicago',
        weekStart: 'monday',
        scope: { kind: 'org' },
        recipients: [],
        autoSend: false,
        ownerId: 'user-lead',
        createdBy: 'user-lead',
      });
      expect(created.id).toBe('def-1');
      const values = tx.of('insert')[0].arg('values') as Record<string, unknown>;
      expect(values.ownerId).toBe('user-lead');
      expect(values.orgId).toBe(ORG);
      expect(typeof values.id).toBe('string');
      expect((values.id as string).length).toBeGreaterThan(10);
    });

    it('reads a definition scoped to the org and excluding tombstones', async () => {
      tx.queue([definition()]);
      await store.getDefinition(ORG, 'def-1');
      expect(tx.of('select')[0].whereSql()).toContain('"deleted_at" is null');
      expect(tx.of('select')[0].whereSql()).toContain('"org_id"');
    });

    it('returns null for a missing definition, and requireDefinition throws', async () => {
      tx.queue([]);
      expect(await store.getDefinition(ORG, 'nope')).toBeNull();
      tx.queue([]);
      await expect(store.requireDefinition(ORG, 'nope')).rejects.toThrow('Report definition not found');
    });

    it('omits undefined patch fields rather than writing nulls over them', async () => {
      tx.queue([definition({ name: 'Renamed' })]);
      await store.updateDefinition(ORG, 'def-1', { name: 'Renamed', cadence: undefined }, 'user-2');
      const set = tx.of('update')[0].arg('set') as Record<string, unknown>;
      expect(set.name).toBe('Renamed');
      expect('cadence' in set).toBe(false);
      expect(set.updatedBy).toBe('user-2');
    });

    it('throws when the update matches nothing', async () => {
      tx.queue([]);
      await expect(store.updateDefinition(ORG, 'gone', { name: 'x' }, 'u')).rejects.toThrow('not found');
    });

    /**
     * A transfer REVIVES a definition paused because its previous owner lost
     * access — otherwise handing the report to someone who does have access would
     * leave it stopped, and the lead would have to know to also flip it back on.
     */
    it('transferring ownership clears a pause and sets the new owner', async () => {
      tx.queue([definition({ ownerId: 'user-new', isActive: true, pausedReason: null })]);
      const moved = await store.transferOwner(ORG, 'def-1', 'user-new', 'admin-1');
      expect(moved.ownerId).toBe('user-new');
      const set = tx.of('update')[0].arg('set') as Record<string, unknown>;
      expect(set).toMatchObject({ ownerId: 'user-new', isActive: true, pausedReason: null, updatedBy: 'admin-1' });
    });

    it('refuses to transfer a definition that is gone', async () => {
      tx.queue([]);
      await expect(store.transferOwner(ORG, 'gone', 'user-new', 'admin-1')).rejects.toThrow('not found');
    });

    it('pauses an owner’s live definitions with the reason recorded', async () => {
      tx.queue([definition({ isActive: false, pausedReason: 'owner_inactive' })]);
      const paused = await store.pauseDefinitionsForOwner(ORG, 'user-lead', 'owner_inactive');
      expect(paused).toHaveLength(1);
      const set = tx.of('update')[0].arg('set') as Record<string, unknown>;
      expect(set).toMatchObject({ isActive: false, pausedReason: 'owner_inactive' });
      // Only the ones that are still on — re-pausing an already-paused definition
      // would overwrite the reason it was paused for the first time.
      expect(tx.of('update')[0].whereSql()).toContain('"is_active" =');
    });

    it('lists the definitions an owner holds', async () => {
      tx.queue([definition(), definition({ id: 'def-2' })]);
      expect(await store.listOwnedDefinitions(ORG, 'user-lead')).toHaveLength(2);
    });

    it('lists definitions by name and hides tombstones', async () => {
      tx.queue([definition()]);
      await store.listDefinitions(ORG);
      expect(tx.of('select')[0].whereSql()).toContain('"deleted_at" is null');
      expect(tx.of('select')[0].arg('orderBy')).toBeDefined();
    });

    /**
     * Deleting a report must also kill its public links. A deleted report whose URL
     * still serves last month's numbers is the gap nobody notices until it matters.
     */
    it('deleting a definition stamps purge_after and revokes its links', async () => {
      tx.queue(
        [{ id: 'def-1' }], // the soft-delete
        [{ id: 'run-1' }], // runs of that definition
        [{ id: 'link-1' }], // links revoked
      );
      await store.deleteDefinition(ORG, 'def-1', 'user-lead');
      const set = tx.of('update')[0].arg('set') as Record<string, unknown>;
      expect(set.deletedBy).toBe('user-lead');
      expect(set.deletedAt).toBeInstanceOf(Date);
      expect(set.purgeAfter).toBeInstanceOf(Date);
      const revoke = tx.of('update')[1].arg('set') as Record<string, unknown>;
      expect(revoke.revokedAt).toBeInstanceOf(Date);
      expect(revoke.revokedBy).toBe('user-lead');
    });

    it('refuses to delete a definition that is already gone', async () => {
      tx.queue([]);
      await expect(store.deleteDefinition(ORG, 'gone', 'u')).rejects.toThrow('not found');
    });

    it('revoking links for a definition with no runs touches nothing', async () => {
      tx.queue([]);
      expect(await store.revokeLinksForDefinition(ORG, 'def-1', 'u')).toBe(0);
      expect(tx.of('update')).toHaveLength(0);
    });
  });

  // ── Runs ──────────────────────────────────────────────────────────────────

  describe('runs', () => {
    it('inserts a run idempotently on (definition, period, version)', async () => {
      tx.queue([run()]);
      const { run: created, created: isNew } = await store.createRun({
        orgId: ORG,
        definitionId: 'def-1',
        periodStart: new Date('2026-09-07T05:00:00.000Z'),
        periodEnd: new Date('2026-09-14T05:00:00.000Z'),
        periodLabel: '2026-W37',
      });
      expect(isNew).toBe(true);
      expect(created.id).toBe('run-1');
      expect(tx.of('insert')[0].arg('onConflictDoNothing')).toBeDefined();
    });

    /**
     * A retry, a catch-up pass and a manual backfill can all ask for the same
     * period. The unique index is the arbiter; the loser re-reads the winner's row
     * instead of inserting a second copy for the lead to review.
     */
    it('re-reads the existing row when the insert conflicts', async () => {
      tx.queue([], [run({ id: 'run-existing' })]);
      const result = await store.createRun({
        orgId: ORG,
        definitionId: 'def-1',
        periodStart: new Date('2026-09-07T05:00:00.000Z'),
        periodEnd: new Date('2026-09-14T05:00:00.000Z'),
        periodLabel: '2026-W37',
      });
      expect(result.created).toBe(false);
      expect(result.run.id).toBe('run-existing');
    });

    it('throws when the insert conflicted but nothing is there to read', async () => {
      tx.queue([], []);
      await expect(store.createRun({
        orgId: ORG,
        definitionId: 'def-1',
        periodStart: NOW,
        periodEnd: NOW,
        periodLabel: '2026-W37',
      })).rejects.toThrow('could not be created');
    });

    it('nextVersion is max(version) + 1, and 1 when the period has no runs', async () => {
      tx.queue([{ version: 3 }]);
      expect(await store.nextVersion('def-1', NOW)).toBe(4);
      tx.reset();
      tx.queue([]);
      expect(await store.nextVersion('def-1', NOW)).toBe(1);
    });

    it('supersede points the old run at the new one', async () => {
      tx.queue([]);
      await store.supersede(ORG, 'run-1', 'run-2');
      expect((tx.of('update')[0].arg('set') as Record<string, unknown>).supersededBy).toBe('run-2');
    });

    it('lists runs newest period first', async () => {
      tx.queue([run(), run({ id: 'run-0', periodLabel: '2026-W36' })]);
      const runs = await store.listRuns(ORG, 'def-1');
      expect(runs.map((r) => r.id)).toEqual(['run-1', 'run-0']);
      expect(tx.of('select')[0].arg('limit')).toBe(50);
    });

    it('requireRun throws for a missing run', async () => {
      tx.queue([]);
      await expect(store.requireRun(ORG, 'nope')).rejects.toThrow('Report run not found');
    });

    it('completeRun stores the snapshot and clears any previous failure', async () => {
      tx.queue([run({ status: 'ready_for_review' })]);
      await store.completeRun(ORG, 'run-1', { sections: [1] });
      const set = tx.of('update')[0].arg('set') as Record<string, unknown>;
      expect(set).toMatchObject({ status: 'ready_for_review', failureReason: null });
      expect(set.snapshot).toEqual({ sections: [1] });
    });

    it('completeRun throws when the run is gone', async () => {
      tx.queue([]);
      await expect(store.completeRun(ORG, 'gone', {})).rejects.toThrow('not found');
    });

    it('failRun records the reason so an empty history is explained', async () => {
      tx.queue([]);
      await store.failRun(ORG, 'run-1', 'no data');
      expect(tx.of('update')[0].arg('set')).toMatchObject({ status: 'failed', failureReason: 'no data' });
    });

    /**
     * THE FROZEN-NARRATIVE RULE. The notes are part of what the recipients read, so
     * editing them after delivery would make the delivered version
     * unreconstructable. The supported correction is a new version.
     */
    it('refuses to edit the notes of a published run, and says how to correct it', async () => {
      tx.queue([run({ status: 'published', publishedAt: NOW })]);
      await expect(store.setRunNotes(ORG, 'run-1', { leadNotes: 'after the fact' }))
        .rejects.toThrow(/already been published[\s\S]*Regenerate/);
      expect(tx.of('update')).toHaveLength(0);
    });

    it('edits the notes of an unpublished run', async () => {
      tx.queue([run()], [run({ leadNotes: 'We paused deploys for the migration.' })]);
      const updated = await store.setRunNotes(ORG, 'run-1', { leadNotes: 'We paused deploys for the migration.' });
      expect(updated.leadNotes).toContain('paused deploys');
      expect(tx.of('update')[0].arg('set')).toMatchObject({ leadNotes: 'We paused deploys for the migration.' });
    });

    it('leaves a field alone when the patch omits it', async () => {
      tx.queue([run()], [run()]);
      await store.setRunNotes(ORG, 'run-1', { aiDraft: 'draft' });
      const set = tx.of('update')[0].arg('set') as Record<string, unknown>;
      expect(set.aiDraft).toBe('draft');
      expect('leadNotes' in set).toBe(false);
    });

    /**
     * TWO CLICKS, ONE PUBLISH. The update is conditional on `published_at IS NULL`,
     * so the second caller learns it lost rather than producing a second set of
     * deliveries and a second audit event.
     */
    it('publishes conditionally, and reports the loser of a race as already published', async () => {
      tx.queue([run()], [run({ status: 'published', publishedAt: NOW, publishedBy: 'lead' })]);
      const first = await store.publishRun(ORG, 'run-1', 'lead');
      expect(first.alreadyPublished).toBe(false);
      expect(tx.of('update')[0].whereSql()).toContain('"published_at" is null');

      tx.reset();
      tx.queue(
        [run()], // requireRun
        [], // the conditional update matched nothing
        [run({ status: 'published', publishedAt: NOW })], // re-read
      );
      const second = await store.publishRun(ORG, 'run-1', 'lead-2');
      expect(second.alreadyPublished).toBe(true);
    });

    it('refuses to publish a run with no snapshot', async () => {
      tx.queue([run({ snapshot: null, status: 'drafting' })]);
      await expect(store.publishRun(ORG, 'run-1', 'lead')).rejects.toThrow('no computed snapshot');
    });

    it('refuses to publish a failed run', async () => {
      tx.queue([run({ status: 'failed' })]);
      await expect(store.publishRun(ORG, 'run-1', 'lead')).rejects.toThrow('nothing to publish');
    });
  });

  // ── Share links ───────────────────────────────────────────────────────────

  describe('share links', () => {
    it('mints a link with the token returned once and only its hash stored', async () => {
      tx.queue([run({ status: 'published', publishedAt: NOW })], [link()]);
      const { link: created, token } = await store.createShareLink({
        orgId: ORG, runId: 'run-1', createdBy: 'lead', now: NOW,
      });
      expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
      const values = tx.of('insert')[0].arg('values') as Record<string, unknown>;
      expect(values.tokenHash).toBe(hashToken(token));
      expect(JSON.stringify(values)).not.toContain(token);
      expect(created.id).toBe('link-1');
    });

    it('defaults the window to 30 days and caps it at the maximum', async () => {
      tx.queue([run({ status: 'published' })], [link()]);
      await store.createShareLink({ orgId: ORG, runId: 'run-1', createdBy: 'lead', now: NOW });
      const day = 24 * 60 * 60 * 1000;
      const defaulted = tx.of('insert')[0].arg('values') as { expiresAt: Date };
      expect(defaulted.expiresAt.getTime() - NOW.getTime()).toBe(DEFAULT_SHARE_LINK_TTL_DAYS * day);

      tx.reset();
      tx.queue([run({ status: 'published' })], [link()]);
      await store.createShareLink({ orgId: ORG, runId: 'run-1', createdBy: 'lead', ttlDays: 9999, now: NOW });
      const capped = tx.of('insert')[0].arg('values') as { expiresAt: Date };
      expect(capped.expiresAt.getTime() - NOW.getTime()).toBe(MAX_SHARE_LINK_TTL_DAYS * day);
    });

    /** A link to a draft would show numbers the lead has not reviewed. */
    it('refuses to share an unpublished run', async () => {
      tx.queue([run({ status: 'ready_for_review' })]);
      await expect(store.createShareLink({ orgId: ORG, runId: 'run-1', createdBy: 'lead' }))
        .rejects.toThrow('Only a published report can be shared');
    });

    it('lists a run’s links newest first', async () => {
      tx.queue([link()]);
      expect(await store.listShareLinks(ORG, 'run-1')).toHaveLength(1);
    });

    it('revokes a live link and refuses a second revoke', async () => {
      tx.queue([link({ revokedAt: NOW, revokedBy: 'lead' })]);
      const revoked = await store.revokeShareLink(ORG, 'link-1', 'lead');
      expect(revoked.revokedAt).toEqual(NOW);
      expect(tx.of('update')[0].whereSql()).toContain('"revoked_at" is null');

      tx.reset();
      tx.queue([]);
      await expect(store.revokeShareLink(ORG, 'link-1', 'lead')).rejects.toThrow('already revoked');
    });

    it('revokes every live link across a definition’s runs', async () => {
      tx.queue([{ id: 'run-1' }, { id: 'run-2' }], [{ id: 'link-1' }, { id: 'link-2' }]);
      expect(await store.revokeLinksForDefinition(ORG, 'def-1', 'lead')).toBe(2);
    });

    /**
     * THE PUBLIC RESOLVE. The token-hash lookup runs as sysadmin because the reader
     * has no tenant, but the RUN is read back under the link's OWN org — so a bug
     * in the second query cannot reach another tenant's rows.
     */
    it('resolves a token as sysadmin, then reads the run under the link’s own org', async () => {
      tx.queue([link()], [run({ status: 'published' })]);
      const resolved = await store.resolveShareLink('a-token', NOW);
      expect(resolved?.run.id).toBe('run-1');
      expect(scopes).toEqual([{ isSuperAdmin: true }, { orgId: ORG, isSuperAdmin: false }]);
      expect(tx.of('select')[1].whereSql()).toContain('"org_id"');
      expect(tx.of('select')[1].whereSql()).toContain('"status"');
    });

    it.each([
      ['an unknown token', () => { tx.queue([]); }],
      ['a revoked link', () => { tx.queue([link({ revokedAt: NOW })]); }],
      ['an expired link', () => { tx.queue([link({ expiresAt: new Date(NOW.getTime() - 1) })]); }],
      ['a run that is no longer published', () => { tx.queue([link()], []); }],
    ])('resolves to null for %s, so a dead link is indistinguishable', async (_case, arrange) => {
      arrange();
      expect(await store.resolveShareLink('a-token', NOW)).toBeNull();
    });

    it('treats an expiry exactly at now as expired', async () => {
      tx.queue([link({ expiresAt: NOW })]);
      expect(await store.resolveShareLink('a-token', NOW)).toBeNull();
    });

    it('counts a view against the link’s own org', async () => {
      tx.queue([]);
      await store.recordShareView(link(), NOW);
      expect(scopes).toEqual([{ orgId: ORG, isSuperAdmin: false }]);
      const set = tx.of('update')[0].arg('set') as Record<string, unknown>;
      expect(set.lastViewedAt).toEqual(NOW);
      // Incremented in SQL, not read-modify-written, so concurrent views all count.
      expect(String(set.viewCount)).not.toBe('1');
    });
  });

  // ── Recipients ────────────────────────────────────────────────────────────

  describe('recipients', () => {
    it('normalizes the address and mints a verification token for a non-member', async () => {
      tx.queue([recipient({ verifiedAt: null, verificationTokenHash: 'placeholder' })]);
      const { verificationToken } = await store.upsertRecipient({
        orgId: ORG, email: '  Manager@Acme.TEST ', createdBy: 'lead',
      });
      const values = tx.of('insert')[0].arg('values') as Record<string, unknown>;
      expect(values.email).toBe('manager@acme.test');
      expect(values.verifiedAt).toBeNull();
      expect(typeof values.verificationTokenHash).toBe('string');
      // The returned row did not take OUR hash, so no token is handed back — a
      // token the row does not carry would never verify anything.
      expect(verificationToken).toBeUndefined();
    });

    /**
     * The token is only handed back when the STORED row took it. A verified row
     * keeps its own state through the conflict update, so returning the token we
     * minted would hand the caller a string that verifies nothing — and the caller
     * would mail it.
     */
    it('hands back the token the stored row actually took', async () => {
      tx.queueFrom((q) => [recipient({
        verifiedAt: null,
        verificationTokenHash: (q.arg('values') as { verificationTokenHash: string }).verificationTokenHash,
      })]);
      const { verificationToken } = await store.upsertRecipient({
        orgId: ORG, email: 'manager@acme.test', createdBy: 'lead',
      });
      expect(typeof verificationToken).toBe('string');
      const used = (tx.of('insert')[0].arg('values') as { verificationTokenHash: string }).verificationTokenHash;
      expect(hashToken(verificationToken as string)).toBe(used);
    });

    it('pre-verifies an org member and mints no token', async () => {
      tx.queue([recipient()]);
      const { verificationToken } = await store.upsertRecipient({
        orgId: ORG, email: 'member@acme.test', createdBy: 'lead', preVerified: true, now: NOW,
      });
      const values = tx.of('insert')[0].arg('values') as Record<string, unknown>;
      expect(values.verifiedAt).toEqual(NOW);
      expect(values.verificationTokenHash).toBeNull();
      expect(verificationToken).toBeUndefined();
    });

    /**
     * AN UNSUBSCRIBE CANNOT BE UNDONE BY RE-ADDING. The conflict SET deliberately
     * leaves `unsubscribed_at` alone; without that, removing and re-adding someone
     * would put them back on the list they asked to leave.
     */
    it('re-adding a recipient never clears the unsubscribe or a prior verification', async () => {
      tx.queue([recipient({ unsubscribedAt: NOW })]);
      await store.upsertRecipient({ orgId: ORG, email: 'manager@acme.test', createdBy: 'lead' });
      const conflict = tx.of('insert')[0].arg('onConflictDoUpdate') as { set: Record<string, unknown> };
      expect('unsubscribedAt' in conflict.set).toBe(false);
      expect('bounceCount' in conflict.set).toBe(false);
      // The tombstone IS lifted, so a removed-then-re-added address comes back with
      // its history rather than as a duplicate row.
      expect(conflict.set.deletedAt).toBeNull();
      expect(conflict.set.purgeAfter).toBeNull();
    });

    it('lists and fetches recipients, and fetching none costs no query', async () => {
      tx.queue([recipient()]);
      expect(await store.listRecipients(ORG)).toHaveLength(1);
      tx.reset();
      expect(await store.getRecipients(ORG, [])).toEqual([]);
      expect(tx.queries).toHaveLength(0);
      tx.queue([recipient()]);
      expect(await store.getRecipients(ORG, ['rec-1'])).toHaveLength(1);
    });

    it('resends a verification only while the address is unverified', async () => {
      tx.queue([recipient({ verifiedAt: null })]);
      const { token } = await store.resendVerification(ORG, 'rec-1');
      expect((tx.of('update')[0].arg('set') as Record<string, unknown>).verificationTokenHash).toBe(hashToken(token));
      expect(tx.of('update')[0].whereSql()).toContain('"verified_at" is null');

      tx.reset();
      tx.queue([]);
      await expect(store.resendVerification(ORG, 'rec-1')).rejects.toThrow('already verified');
    });

    /** Consumed on success, so a forwarded confirmation cannot be replayed. */
    it('verification consumes the token and is scoped by sysadmin over the hash', async () => {
      tx.queue([recipient()]);
      const verified = await store.verifyRecipientByToken('a-token', NOW);
      expect(verified?.id).toBe('rec-1');
      expect(scopes).toEqual([{ isSuperAdmin: true }]);
      const set = tx.of('update')[0].arg('set') as Record<string, unknown>;
      expect(set).toMatchObject({ verifiedAt: NOW, verificationTokenHash: null });
      const where = tx.of('update')[0].whereSql();
      expect(where).toContain('"verified_at" is null');
      expect(where).toContain('"deleted_at" is null');
      expect(where).toContain('"created_at" >');
    });

    it('returns null for a token that matched nothing', async () => {
      tx.queue([]);
      expect(await store.verifyRecipientByToken('nope', NOW)).toBeNull();
    });

    it('unsubscribes by address, once', async () => {
      tx.queue([{ id: 'rec-1' }]);
      expect(await store.unsubscribeByEmail(ORG, ' Manager@ACME.test ', NOW)).toBe(true);
      expect(tx.of('update')[0].whereSql()).toContain('"unsubscribed_at" is null');
      tx.reset();
      tx.queue([]);
      expect(await store.unsubscribeByEmail(ORG, 'manager@acme.test', NOW)).toBe(false);
    });

    it('records a bounce and returns the running count', async () => {
      tx.queue([{ bounceCount: 2 }]);
      expect(await store.recordBounce(ORG, 'manager@acme.test', NOW)).toBe(2);
      tx.reset();
      tx.queue([]);
      expect(await store.recordBounce(ORG, 'nobody@acme.test', NOW)).toBe(0);
    });

    it('soft-deletes a recipient with a purge deadline', async () => {
      tx.queue([{ id: 'rec-1' }]);
      await store.deleteRecipient(ORG, 'rec-1', 'lead');
      expect(tx.of('update')[0].arg('set')).toMatchObject({ deletedBy: 'lead' });
      tx.reset();
      tx.queue([]);
      await expect(store.deleteRecipient(ORG, 'gone', 'lead')).rejects.toThrow('Recipient not found');
    });

    /** One place decides deliverability, so the scheduler and the UI agree. */
    it.each([
      ['a verified address', recipient(), true, undefined],
      ['a removed address', recipient({ deletedAt: NOW }), false, 'removed'],
      ['an unsubscribed address', recipient({ unsubscribedAt: NOW }), false, 'unsubscribed'],
      ['an unverified address', recipient({ verifiedAt: null }), false, 'pending_verification'],
      ['a bouncing address', recipient({ bounceCount: MAX_BOUNCES }), false, 'bouncing'],
    ])('deliverability of %s', (_case, row, deliverable, reason) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(store.deliverability(row as any)).toEqual(reason ? { deliverable, reason } : { deliverable });
    });

    it('treats one bounce below the limit as still deliverable', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(store.deliverability(recipient({ bounceCount: MAX_BOUNCES - 1 }) as any).deliverable).toBe(true);
    });
  });

  // ── Policy ────────────────────────────────────────────────────────────────

  describe('recipient policy', () => {
    /**
     * CLOSED BY DEFAULT. An org that has never configured anything must not be able
     * to mint a public link or mail a report outside itself — a missing settings row
     * is the most common state, not an exceptional one.
     */
    it('an org with no settings row gets the closed defaults', async () => {
      tx.queue([]);
      expect(await store.getReportPolicy(ORG)).toEqual({
        externalSharing: false,
        recipientDomains: null,
        requireApproval: true,
      });
    });

    it('reads a configured policy', async () => {
      tx.queue([{ externalSharing: true, recipientDomains: ['acme.test'], requireApproval: false }]);
      expect(await store.getReportPolicy(ORG)).toEqual({
        externalSharing: true,
        recipientDomains: ['acme.test'],
        requireApproval: false,
      });
    });

    it('upserts the policy and only writes the named fields', async () => {
      tx.queue([]);
      await store.setReportPolicy(ORG, { externalSharing: true });
      const conflict = tx.of('insert')[0].arg('onConflictDoUpdate') as { set: Record<string, unknown> };
      expect(conflict.set.reportExternalSharing).toBe(true);
      expect('reportRecipientDomains' in conflict.set).toBe(false);
    });

    it('can clear the domain list back to members-only', async () => {
      tx.queue([]);
      await store.setReportPolicy(ORG, { recipientDomains: null, requireApproval: true });
      const conflict = tx.of('insert')[0].arg('onConflictDoUpdate') as { set: Record<string, unknown> };
      expect(conflict.set.reportRecipientDomains).toBeNull();
    });

    const closed = { recipientDomains: null, requireApproval: true };
    const open = { recipientDomains: ['partner.test'], requireApproval: false };

    it('always admits a member, with no verification and no approval', () => {
      const members = new Set(['member@acme.test']);
      expect(store.admitRecipient('Member@Acme.test', closed, members))
        .toEqual({ admitted: true, member: true, needsApproval: false });
    });

    it('refuses any external address when no domains are allowed', () => {
      const result = store.admitRecipient('outsider@other.test', closed, new Set());
      expect(result.admitted).toBe(false);
      expect('reason' in result && result.reason).toContain('only delivers reports to its own members');
    });

    it('treats an empty domain list the same as none', () => {
      expect(store.admitRecipient('x@other.test', { recipientDomains: [], requireApproval: true }, new Set()).admitted).toBe(false);
    });

    it('admits an allowed domain and its subdomains', () => {
      expect(store.admitRecipient('vp@partner.test', open, new Set()))
        .toEqual({ admitted: true, member: false, needsApproval: false });
      expect(store.admitRecipient('vp@eu.partner.test', open, new Set()).admitted).toBe(true);
    });

    it('does not admit a lookalike domain that merely ENDS with the allowed one', () => {
      // `notpartner.test` ends with `partner.test` as a STRING but is a different
      // domain — the check is on the label boundary, not the substring.
      expect(store.admitRecipient('vp@notpartner.test', open, new Set()).admitted).toBe(false);
    });

    it('tolerates a leading @ and stray case in the configured domains', () => {
      const policy = { recipientDomains: ['  @Partner.TEST '], requireApproval: true };
      expect(store.admitRecipient('vp@partner.test', policy, new Set()))
        .toEqual({ admitted: true, member: false, needsApproval: true });
    });

    it('refuses something that is not an address at all', () => {
      const result = store.admitRecipient('not-an-email', closed, new Set());
      expect(result).toEqual({ admitted: false, reason: 'Not a valid email address.' });
    });

    it('names the allowed domains when refusing, so the lead can act', () => {
      const result = store.admitRecipient('vp@elsewhere.test', open, new Set());
      expect('reason' in result && result.reason).toContain('partner.test');
    });
  });

  // ── Retention ─────────────────────────────────────────────────────────────

  describe('purge', () => {
    it('registers runs before definitions, and recipients too', () => {
      expect(store.purgeableEntities().map((e) => e.name))
        .toEqual(['report_run', 'report_definition', 'report_recipient']);
    });

    it('purging runs deletes their share links first', async () => {
      tx.queue([{ id: 'run-1' }], [], [{ id: 'run-1' }]);
      const purged = await store.purgeableEntities()[0].purgeExpired(NOW, 10);
      expect(purged).toBe(1);
      const deletes = tx.of('delete');
      expect(deletes[0].table).toBe('report_share_links');
      expect(deletes[1].table).toBe('report_runs');
    });

    it('purging runs does nothing when none are due', async () => {
      tx.queue([]);
      expect(await store.purgeableEntities()[0].purgeExpired(NOW)).toBe(0);
      expect(tx.of('delete')).toHaveLength(0);
    });

    /**
     * A purged definition takes its runs and their links with it, tombstoned or
     * not: a snapshot whose definition is gone can never be listed again, and a
     * live token must never outlive the row it points at.
     */
    it('purging a definition cascades to its runs and links', async () => {
      tx.queue([{ id: 'def-1' }], [{ id: 'run-1' }], [], [], [{ id: 'def-1' }]);
      expect(await store.purgeableEntities()[1].purgeExpired(NOW, 10)).toBe(1);
      expect(tx.of('delete').map((d) => d.table))
        .toEqual(['report_share_links', 'report_runs', 'report_definitions']);
    });

    it('purging a definition with no runs skips the cascade', async () => {
      tx.queue([{ id: 'def-1' }], [], [{ id: 'def-1' }]);
      expect(await store.purgeableEntities()[1].purgeExpired(NOW)).toBe(1);
      expect(tx.of('delete').map((d) => d.table)).toEqual(['report_definitions']);
    });

    it('purging definitions does nothing when none are due', async () => {
      tx.queue([]);
      expect(await store.purgeableEntities()[1].purgeExpired(NOW)).toBe(0);
    });

    it('purges expired recipient tombstones in bounded batches', async () => {
      tx.queue([{ id: 'rec-1' }], [{ id: 'rec-1' }]);
      expect(await store.purgeableEntities()[2].purgeExpired(NOW, 5)).toBe(1);
      expect(tx.of('select')[0].arg('limit')).toBe(5);
      tx.reset();
      tx.queue([]);
      expect(await store.purgeableEntities()[2].purgeExpired(NOW)).toBe(0);
    });

    it('only considers rows past their purge_after deadline', async () => {
      tx.queue([]);
      await store.purgeableEntities()[0].purgeExpired(NOW);
      const where = tx.of('select')[0].whereSql();
      expect(where).toContain('"deleted_at" IS NOT NULL');
      expect(where).toContain('"purge_after" <=');
    });
  });
});
