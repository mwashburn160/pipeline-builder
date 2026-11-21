// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * In-memory doubles for the runner subsystem: a {@link RunnerStore} over plain
 * maps, a scripted `safeFetch`, a manual clock, and a full {@link RunnerDeps}
 * bundle built from them. Nothing here touches the network or a database.
 */

import { generateKeyPairSync } from 'node:crypto';
import { jest } from '@jest/globals';
import type { RunnersUnavailableReason } from '@pipeline-builder/api-core/pipeline-runners';
import { fakeKeyStore, fakeSecrets } from './key-fakes.js';
import type { RunnerDeps, SafeFetchFn } from '../../src/runners/deps.js';
import { createOrgSignerCache, createRunRequestSigner, type RunRequestSigner } from '../../src/runners/signing.js';
import type { RegistryLink, RunRequestRow, RunnerRow, RunnerStore } from '../../src/runners/store.js';

export const ORG = '0123456789abcdef01234567';
export const PARENT = '0123456789abcdef01234568';
export const GRANDPARENT = '0123456789abcdef01234569';
export const PIPE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const URL_A = 'https://abc123.lambda-url.us-east-1.on.aws/';

export function ed25519() {
  return generateKeyPairSync('ed25519');
}

let seq = 0;
export const uuid = (): string => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

export function runnerRow(over: Partial<RunnerRow> = {}): RunnerRow {
  const t = new Date('2026-11-19T00:00:00Z');
  return {
    id: uuid(),
    orgId: ORG,
    label: 'prod-account',
    functionUrl: URL_A,
    shareWithTeams: true,
    version: '1.0.0',
    regions: ['us-east-1'],
    health: 'healthy',
    status: 'active',
    consecutiveFailures: 0,
    createdBy: 'u1',
    createdAt: t,
    updatedAt: t,
    lastDeliveryAt: null,
    updateRequiredSince: null,
    ...over,
  };
}

export interface FakeStore extends RunnerStore {
  runners: Map<string, RunnerRow>;
  requests: Map<string, RunRequestRow>;
  registry: Map<string, RegistryLink & { orgId: string }>;
}

const PENDING = ['queued', 'delivering'];

export function fakeStore(): FakeStore {
  const runners = new Map<string, RunnerRow>();
  const requests = new Map<string, RunRequestRow>();
  const registry = new Map<string, RegistryLink & { orgId: string }>();
  const store: FakeStore = {
    runners,
    requests,
    registry,
    async insertRunner(row) { const r = runnerRow(row as Partial<RunnerRow>); runners.set(r.id, r); return r; },
    async getRunner(id) { return runners.get(id) ?? null; },
    async listRunners(orgIds, opts) {
      return [...runners.values()].filter((r) => orgIds.includes(r.orgId) && (!opts?.activeOnly || r.status === 'active'));
    },
    async listActiveRunners() { return [...runners.values()].filter((r) => r.status === 'active'); },
    async countRunners(orgId) { return [...runners.values()].filter((r) => r.orgId === orgId && r.status !== 'revoked').length; },
    async updateRunner(id, patch) {
      const r = runners.get(id); if (!r) return null;
      const next = { ...r, ...patch } as RunnerRow; runners.set(id, next); return next;
    },
    async recordRunnerFailure(id) {
      const r = runners.get(id); if (!r) return null;
      const next = { ...r, consecutiveFailures: r.consecutiveFailures + 1 }; runners.set(id, next); return next;
    },
    async markRunnerUnreachable(id) {
      const r = runners.get(id); if (!r || r.health !== 'healthy') return null;
      const next = { ...r, health: 'unreachable' as const }; runners.set(id, next); return next;
    },
    async countUnhealthyRunners() { return [...runners.values()].filter((r) => r.status === 'active' && r.health !== 'healthy').length; },
    async insertRequest(row) {
      const r: RunRequestRow = {
        id: row.id ?? uuid(),
        orgId: row.orgId,
        pipelineId: row.pipelineId,
        action: row.action,
        executionId: row.executionId ?? null,
        parentRequestId: row.parentRequestId ?? null,
        requestedBy: row.requestedBy,
        requestedAt: row.requestedAt ?? new Date(),
        expiresAt: row.expiresAt,
        status: row.status ?? 'queued',
        runnerId: row.runnerId ?? null,
        attempts: row.attempts ?? 0,
        nextAttemptAt: row.nextAttemptAt ?? null,
        lastDeliveryError: row.lastDeliveryError ?? null,
        resultExecutionId: row.resultExecutionId ?? null,
        errorCode: row.errorCode ?? null,
        acceptedAt: row.acceptedAt ?? null,
      };
      requests.set(r.id, r); return r;
    },
    async getRequest(id) { return requests.get(id) ?? null; },
    async updateRequest(id, patch, from) {
      const r = requests.get(id); if (!r) return null;
      if (from && from.length > 0 && !from.includes(r.status)) return null;
      const next = { ...r, ...patch } as RunRequestRow; requests.set(id, next); return next;
    },
    async listExpired(now) { return [...requests.values()].filter((r) => PENDING.includes(r.status) && r.expiresAt <= now); },
    async listRunnerRequests(runnerId, statuses) { return [...requests.values()].filter((r) => r.runnerId === runnerId && statuses.includes(r.status)); },
    async listQueued(limit) { return [...requests.values()].filter((r) => r.status === 'queued').slice(0, limit); },
    async countPending(orgId) { return [...requests.values()].filter((r) => r.orgId === orgId && PENDING.includes(r.status) && r.action !== 'probe').length; },
    async countDelivering(runnerId) { return [...requests.values()].filter((r) => r.runnerId === runnerId && r.status === 'delivering' && r.action !== 'probe').length; },
    async findPendingStart(orgId, pipelineId) {
      return [...requests.values()].find((r) => r.orgId === orgId && r.pipelineId === pipelineId && r.action === 'start' && PENDING.includes(r.status)) ?? null;
    },
    async hasChildRequests(id) { return [...requests.values()].some((r) => r.parentRequestId === id); },
    async deletePendingRunnersBefore(before) {
      let n = 0;
      for (const [k, r] of runners) if (r.status === 'pending' && r.createdAt! < before) { runners.delete(k); n++; }
      return n;
    },
    async deleteRequestsBefore(statuses, before) {
      let n = 0;
      for (const [k, r] of requests) if (statuses.includes(r.status) && r.requestedAt! < before) { requests.delete(k); n++; }
      return n;
    },
    async getRegistryLink(pipelineId, orgId) {
      const l = registry.get(pipelineId);
      if (!l || l.orgId !== orgId) return null;
      return {
        pipelineName: l.pipelineName,
        region: l.region,
        runnerId: l.runnerId,
        linkStatus: l.linkStatus ?? 'unlinked',
        linkCheckedAt: l.linkCheckedAt ?? null,
        linkDetail: l.linkDetail ?? null,
      };
    },
    async setRegistryRunner(pipelineId, orgId, runnerId, onlyIf) {
      const l = registry.get(pipelineId); if (!l || l.orgId !== orgId) return false;
      if (onlyIf && l.runnerId !== onlyIf) return false;
      registry.set(pipelineId, { ...l, runnerId, linkStatus: runnerId ? 'linked' : 'unlinked' }); return true;
    },
    async writeRunnerLink(pipelineId, orgId, write) {
      const l = registry.get(pipelineId); if (!l || l.orgId !== orgId) return false;
      registry.set(pipelineId, {
        ...l, linkStatus: write.status, linkCheckedAt: write.checkedAt, linkDetail: write.detail, ...(write.runnerId ? { runnerId: write.runnerId } : {}),
      });
      return true;
    },
    async resetStaleLinkChecks(before) {
      let n = 0;
      for (const [k, l] of registry) {
        if (l.linkStatus === 'checking' && l.linkCheckedAt && l.linkCheckedAt < before) { registry.set(k, { ...l, linkStatus: l.runnerId ? 'linked' : 'unlinked' }); n++; }
      }
      return n;
    },
    async clearRunnerLinks(runnerId) {
      let n = 0;
      for (const [k, l] of registry) if (l.runnerId === runnerId) { registry.set(k, { ...l, runnerId: null, linkStatus: 'unlinked' }); n++; }
      return n;
    },
    async pipelineCounts(runnerIds) {
      const out = new Map<string, number>();
      for (const l of registry.values()) if (l.runnerId && runnerIds.includes(l.runnerId)) out.set(l.runnerId, (out.get(l.runnerId) ?? 0) + 1);
      return out;
    },
    async listRunnerPipelines(runnerId, limit, offset) {
      const all = [...registry.entries()].filter(([, l]) => l.runnerId === runnerId)
        .map(([id, l]) => ({ id, name: l.pipelineName })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      return { rows: all.slice(offset, offset + limit), total: all.length };
    },
    async linkedOrgIds(runnerId, ownerOrgId) {
      return [...new Set([...registry.values()].filter((l) => l.runnerId === runnerId && l.orgId !== ownerOrgId).map((l) => l.orgId))];
    },
    async runnerLinks(pipelineIds, orgId) {
      const out = new Map<string, { id: string; label: string }>();
      for (const id of pipelineIds) {
        const l = registry.get(id);
        const r = l?.runnerId ? runners.get(l.runnerId) : undefined;
        if (l && l.orgId === orgId && r) out.set(id, { id: r.id, label: r.label });
      }
      return out;
    },
  };
  return store;
}

/** A safeFetch reply. */
export function reply(status: number, body: unknown, extra: { redirected?: boolean } = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    redirected: !!extra.redirected,
    headers: {},
    body: buf,
    text: () => buf.toString(),
    json: <T>() => JSON.parse(buf.toString()) as T,
  };
}

export interface TestDeps extends RunnerDeps {
  store: FakeStore;
  clock: { t: number };
  fetchMock: jest.Mock<SafeFetchFn>;
  enqueued: Array<{ requestId: string; delayMs?: number }>;
  notified: unknown[];
  audits: Array<Record<string, unknown>>;
  counters: Array<[string, Record<string, string>]>;
  /** Every `inc` with its value (1 unless given). */
  counterAdds: Array<[string, Record<string, string>, number]>;
  gauges: Array<[string, number]>;
  /** The gauges this replica currently EXPORTS (a reset removes the series). */
  gaugeValues: Map<string, number>;
  ancestors: string[];
  /** What `runnersAvailable()` answers (mutable: flip `available` to pause). */
  availability: { available: boolean; reason?: RunnersUnavailableReason };
  /** The signer `signerFor()` returns for every org (one test key). */
  testSigner: RunRequestSigner;
  /** The org ids `signerFor()` was asked for, in order. */
  signerOrgs: string[];
}

/** A full deps bundle over fakes. `fetch` answers 200 pong unless scripted. */
export function testDeps(over: Partial<RunnerDeps> = {}): TestDeps {
  const keys = ed25519();
  const clock = { t: Date.parse('2026-11-19T12:00:00Z') };
  const now = () => clock.t;
  const signer = createRunRequestSigner(keys.privateKey, undefined, now);
  const fetchMock = jest.fn<SafeFetchFn>(async () => reply(200, { outcome: 'pong', runnerVersion: '1.2.3', regions: ['us-east-1'] }));
  const enqueued: TestDeps['enqueued'] = [];
  const notified: unknown[] = [];
  const audits: TestDeps['audits'] = [];
  const counters: TestDeps['counters'] = [];
  const counterAdds: TestDeps['counterAdds'] = [];
  const gauges: TestDeps['gauges'] = [];
  const gaugeValues = new Map<string, number>();
  const ancestors: string[] = [];
  const locks = new Set<string>();
  const availability: TestDeps['availability'] = { available: true };
  const signerOrgs: string[] = [];
  const hits = new Map<string, number>();
  const deps: TestDeps = {
    signerFor: async (orgId: string) => { signerOrgs.push(orgId); return signer; },
    signerOrgs,
    testSigner: signer,
    runnersAvailable: async (opts?: { ignorePause?: boolean }) => (opts?.ignorePause && !availability.available && (availability.reason ?? 'paused') === 'paused' ? { available: true } : { ...availability }),
    deliveriesPaused: async () => !availability.available && availability.reason === 'paused',
    availability,
    // The per-org key parts (the real signer cache over them: key-fakes.ts `keyedDeps`).
    keyStore: fakeKeyStore({ runners: () => [...deps.store.runners.values()], now }),
    secrets: fakeSecrets(),
    keyCaches: { signers: createOrgSignerCache({ resolve: async () => ({ signer, versionOrgIds: [], version: 0 }), version: async () => 0 }), jwks: new Map(), pause: null, unreadable: new Set() },
    publishKeyInvalidation: () => undefined,
    store: fakeStore(),
    fetch: fetchMock,
    fetchMock,
    now,
    clock,
    sleep: async (ms) => { clock.t += ms; },
    queue: { enqueue: async (requestId, delayMs) => { enqueued.push({ requestId, ...(delayMs !== undefined ? { delayMs } : {}) }); } },
    enqueued,
    lock: {
      acquire: async (p) => { if (locks.has(p)) return null; locks.add(p); return `tok-${p}`; },
      release: async (p) => { locks.delete(p); },
    },
    limiter: { hit: async (key, max) => { const n = (hits.get(key) ?? 0) + 1; hits.set(key, n); return n <= max; } },
    hierarchy: { ancestors: async () => [...ancestors], descendants: async () => [], names: async (ids) => Object.fromEntries(ids.map((i) => [i, `Org ${i.slice(-2)}`])) },
    ancestors,
    notify: async (n) => { notified.push(n); return true; },
    notified,
    audit: (e) => { audits.push(e as unknown as Record<string, unknown>); },
    audits,
    metrics: { inc: (n, l, v = 1) => { counters.push([n, l]); counterAdds.push([n, l, v]); }, gauge: (n, _l, v) => { gauges.push([n, v]); gaugeValues.set(n, v); }, resetGauge: (n) => { gaugeValues.delete(n); } },
    gaugeValues,
    counters,
    counterAdds,
    gauges,
    newId: uuid,
    ...over,
  } as TestDeps;
  return deps;
}

/** Decode a compact JWS's payload (tests only). */
export function claimsOf(jws: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jws.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
}
export function headerOf(jws: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jws.split('.')[0]!, 'base64url').toString()) as Record<string, unknown>;
}
