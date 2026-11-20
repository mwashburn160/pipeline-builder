// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * In-memory doubles for the per-org signing keys: a {@link RunnerKeyStore}
 * that enforces the same one-per-state and kid uniqueness the partial unique
 * indexes do (and rolls a failed transaction back), a reversible fake secret
 * encryption bound to the org, an org tree for the hierarchy client, and
 * {@link keyedDeps}: a test bundle whose `signerFor` is the REAL per-org signer
 * cache over those fakes.
 */

import type { RunnerKeyState } from '@pipeline-builder/api-core/pipeline-runners';
import { testDeps, type TestDeps } from './runner-fakes.js';
import { createKeyDeps, type HierarchyClient, type RunnerDeps } from '../../src/runners/deps.js';
import type { KeySecrets } from '../../src/runners/key-crypto.js';
import type { KeyInsert, KeyRow, KeySettingsRow, KeyTx, PauseRow, RunnerKeyStore } from '../../src/runners/key-store.js';
import type { RunnerRow } from '../../src/runners/store.js';

export interface FakeKeyStore extends RunnerKeyStore {
  keys: Map<string, KeyRow>;
  settingsRows: Map<string, KeySettingsRow>;
  pauseRow: PauseRow | null;
  /** Transactions run (to assert one per change). */
  txCount: number;
}

const uniqueViolation = (what: string) => Object.assign(new Error(`duplicate key value violates unique constraint (${what})`), { code: '23505' });
const PUBLISHED = ['next', 'active', 'retiring'];

let idSeq = 0;

export function fakeKeyStore(opts: { runners?: () => RunnerRow[]; now?: () => number } = {}): FakeKeyStore {
  const now = opts.now ?? Date.now;
  let keys = new Map<string, KeyRow>();
  let settingsRows = new Map<string, KeySettingsRow>();
  let seq = 0;
  let chain: Promise<unknown> = Promise.resolve();

  const check = (all: Map<string, KeyRow>, row: KeyRow) => {
    for (const other of all.values()) {
      if (other.id === row.id) continue;
      if (other.kid === row.kid) throw uniqueViolation('kid');
      if (PUBLISHED.includes(row.state) && other.orgId === row.orgId && other.state === row.state) throw uniqueViolation(`one_${row.state}`);
    }
    if ((row.state === 'retired') !== (row.privateKeyEnc === null)) throw Object.assign(new Error('wiped check'), { code: '23514' });
    if (row.state === 'retiring' && !row.retireAfter) throw Object.assign(new Error('retire_after check'), { code: '23514' });
  };

  const tx = (): KeyTx => ({
    lockKeys: async (orgId) => [...keys.values()].filter((k) => k.orgId === orgId && k.state !== 'retired'),
    lockKeyById: async (id) => keys.get(id) ?? null,
    lockSettings: async (orgId) => settingsRows.get(orgId) ?? null,
    insertKey: async (row: KeyInsert) => {
      const t = new Date(now());
      const full: KeyRow = {
        id: row.id ?? `key-${++idSeq}`,
        orgId: row.orgId,
        kid: row.kid,
        publicJwk: row.publicJwk,
        privateKeyEnc: row.privateKeyEnc ?? null,
        state: row.state,
        activatesAt: row.activatesAt,
        retireAfter: row.retireAfter ?? null,
        retiredAt: row.retiredAt ?? null,
        retiredReason: row.retiredReason ?? null,
        runnerKeyVersion: ++seq,
        ageReminderSentAt: row.ageReminderSentAt ?? null,
        ageFollowupSentAt: row.ageFollowupSentAt ?? null,
        createdBy: row.createdBy ?? null,
        createdAt: row.createdAt ?? t,
        updatedAt: t,
      };
      check(keys, full);
      keys.set(full.id, full);
      return full;
    },
    updateKey: async (id, patch) => {
      const old = keys.get(id);
      if (!old) throw new Error(`no key ${id}`);
      const next = { ...old, ...patch, runnerKeyVersion: ++seq, updatedAt: new Date(now()) } as KeyRow;
      check(keys, next);
      keys.set(id, next);
      return next;
    },
    upsertSettings: async (orgId, patch) => {
      const old = settingsRows.get(orgId);
      const t = new Date(now());
      const next: KeySettingsRow = {
        orgId,
        mode: patch.mode,
        modeChangedAt: patch.modeChangedAt ?? old?.modeChangedAt ?? t,
        effectiveKeyOrgId: patch.effectiveKeyOrgId !== undefined ? patch.effectiveKeyOrgId : old?.effectiveKeyOrgId ?? null,
        transitionKind: patch.transitionKind !== undefined ? patch.transitionKind : old?.transitionKind ?? null,
        previousKeyOrgId: patch.previousKeyOrgId !== undefined ? patch.previousKeyOrgId : old?.previousKeyOrgId ?? null,
        switchAt: patch.switchAt !== undefined ? patch.switchAt : old?.switchAt ?? null,
        transitionUntil: patch.transitionUntil !== undefined ? patch.transitionUntil : old?.transitionUntil ?? null,
        runnerKeyVersion: ++seq,
        updatedBy: patch.updatedBy !== undefined ? patch.updatedBy : old?.updatedBy ?? null,
        updatedAt: t,
      };
      settingsRows.set(orgId, next);
      return next;
    },
  });

  const store: FakeKeyStore = {
    get keys() { return keys; },
    get settingsRows() { return settingsRows; },
    pauseRow: null,
    txCount: 0,
    async tablesPresent() { return true; },
    transaction<T>(fn: (t: KeyTx) => Promise<T>): Promise<T> {
      // Serialized like row locks would serialize writers of one org; rolled back on a throw.
      const run = chain.then(async () => {
        store.txCount++;
        const savedKeys = new Map(keys);
        const savedSettings = new Map(settingsRows);
        try {
          return await fn(tx());
        } catch (err) {
          keys = savedKeys;
          settingsRows = savedSettings;
          throw err;
        }
      });
      chain = run.catch(() => undefined);
      return run;
    },
    async publishedKeys(orgIds) { return [...keys.values()].filter((k) => orgIds.includes(k.orgId) && k.state !== 'retired'); },
    async settings(orgIds) { return [...settingsRows.values()].filter((s) => orgIds.includes(s.orgId)); },
    async version(orgIds) {
      let v = 0;
      for (const k of keys.values()) if (orgIds.includes(k.orgId)) v = Math.max(v, k.runnerKeyVersion);
      for (const s of settingsRows.values()) if (orgIds.includes(s.orgId)) v = Math.max(v, s.runnerKeyVersion);
      return v;
    },
    async orgsWithDueNext(t) { return [...new Set([...keys.values()].filter((k) => k.state === 'next' && k.activatesAt <= t).map((k) => k.orgId))]; },
    async orgsWithDueRetiring(t) { return [...new Set([...keys.values()].filter((k) => k.state === 'retiring' && k.retireAfter && k.retireAfter <= t).map((k) => k.orgId))]; },
    async transitions() { return [...settingsRows.values()].filter((s) => s.transitionKind); },
    async activeKeys() { return [...keys.values()].filter((k) => k.state === 'active'); },
    async countByState() {
      const out: Record<RunnerKeyState, number> = { next: 0, active: 0, retiring: 0, retired: 0 };
      for (const k of keys.values()) out[k.state]++;
      return out;
    },
    async encryptedKeyIds(orgId) { return [...keys.values()].filter((k) => k.state !== 'retired' && (!orgId || k.orgId === orgId)).map(({ id, orgId: o, kid }) => ({ id, orgId: o, kid })); },
    async runnerCounts(orgIds) {
      const out = new Map<string, number>();
      for (const r of opts.runners?.() ?? []) {
        if (r.status === 'revoked' || (orgIds && !orgIds.includes(r.orgId))) continue;
        out.set(r.orgId, (out.get(r.orgId) ?? 0) + 1);
      }
      return out;
    },
    async keyOrgIds() { return [...new Set([...[...keys.values()].map((k) => k.orgId), ...settingsRows.keys()])]; },
    async getPause() { return store.pauseRow; },
    async setPause({ paused, by, reason, at }) {
      store.pauseRow = { singleton: true, deliveriesPaused: paused, pausedAt: paused ? at : null, pausedBy: paused ? by : null, pauseReason: paused ? reason : null, updatedAt: at };
      return store.pauseRow;
    },
  };
  return store;
}

/** A reversible fake encryption bound to the org (no master key needed); `unreadable` orgs fail to decrypt. */
export function fakeSecrets(unreadable: Set<string> = new Set()): KeySecrets & { unreadable: Set<string> } {
  return {
    unreadable,
    encrypt: async (pem, orgId) => JSON.stringify({ alg: 'fake', org: orgId, data: Buffer.from(pem).toString('base64') }),
    decrypt: async (stored, orgId) => {
      const b = JSON.parse(stored) as { org: string; data: string };
      if (unreadable.has(orgId) || b.org !== orgId) throw new Error('Unsupported state or unable to authenticate data');
      return Buffer.from(b.data, 'base64').toString();
    },
  };
}

/** A hierarchy over a child → parent map (and names `Org <last 2>`). */
export function treeHierarchy(parents: Map<string, string>): HierarchyClient {
  return {
    async ancestors(orgId) {
      const out: string[] = [];
      let p = parents.get(orgId);
      while (p && !out.includes(p)) { out.push(p); p = parents.get(p); }
      return out;
    },
    async descendants(orgId) {
      const out: string[] = [];
      const walk = (o: string) => { for (const [c, p] of parents) if (p === o && !out.includes(c)) { out.push(c); walk(c); } };
      walk(orgId);
      return out;
    },
    async names(ids) { return Object.fromEntries(ids.map((i) => [i, `Org ${i.slice(-2)}`])); },
  };
}

export interface KeyedDeps extends TestDeps {
  keyStore: FakeKeyStore;
  secrets: ReturnType<typeof fakeSecrets>;
  parents: Map<string, string>;
  published: Array<Record<string, unknown>>;
}

/**
 * A bundle whose signer, availability-independent key caches and key store are
 * the real code over fakes. `parents` is the org tree (child → parent).
 */
export function keyedDeps(over: Partial<RunnerDeps> = {}, opts: { keyStore?: FakeKeyStore } = {}): KeyedDeps {
  const parents = new Map<string, string>();
  const published: KeyedDeps['published'] = [];
  const base = testDeps(over) as KeyedDeps;
  base.parents = parents;
  base.published = published;
  base.hierarchy = treeHierarchy(parents);
  base.keyStore = opts.keyStore ?? fakeKeyStore({ runners: () => [...base.store.runners.values()], now: base.now });
  base.secrets = fakeSecrets();
  base.publishKeyInvalidation = (m) => { published.push(m as Record<string, unknown>); };
  const parts = createKeyDeps(() => base, { encryptionReady: () => true });
  base.keyCaches = parts.keyCaches;
  base.signerFor = parts.signerFor;
  base.deliveriesPaused = parts.deliveriesPaused;
  return base;
}
