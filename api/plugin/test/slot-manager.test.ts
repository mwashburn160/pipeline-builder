// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for queue/slot-manager.
 *
 * Two hardening properties:
 *  (1) the per-org counter TTL is refreshed on EVERY acquire (not just the
 *      0->1 transition), so a continuously-busy org's key can't expire
 *      mid-flight and reset the cap;
 *  (2) the per-org cap is PER CLASS and PER TIER, so `flexible` work cannot eat
 *      the `standard` headroom an urgent fix needs, and a Developer org no
 *      longer gets an Enterprise org's concurrency;
 *  (3) the owner hash + the scrubber's live-set are keyed by a
 *      queue-qualified id (`${queueName}:${jobId}`). BullMQ job ids are
 *      per-queue-monotonic, so the per-tier queues mint colliding bare ids;
 *      a bare-id live-set would treat one tier's job as "live" for a same-id
 *      owner recorded from another tier and never reclaim the leak.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockIncCounter = jest.fn<(...args: any[]) => any>();

// -- In-memory Redis that RUNS the slot manager's real Lua scripts -------------
//
// The scripts are the unit under test (atomicity + idempotency live in them), so
// rather than stub `eval`, this double executes the script text: a small
// Lua→JS translation covering the subset the scripts use (redis.call, local,
// if/then/end, tonumber, 1-based KEYS/ARGV). Mutating a script changes behavior
// here exactly as it would in Redis.

const strings = new Map<string, number>();
const hashes = new Map<string, Map<string, string>>();
/** Count of EXPIRE calls per key — the heartbeat's whole observable effect. */
const expires = new Map<string, number>();

function call(cmd: string, ...args: string[]): unknown {
  switch (cmd.toUpperCase()) {
    case 'INCR': { const v = (strings.get(args[0]) ?? 0) + 1; strings.set(args[0], v); return v; }
    case 'DECR': { const v = (strings.get(args[0]) ?? 0) - 1; strings.set(args[0], v); return v; }
    case 'EXPIRE': expires.set(args[0], (expires.get(args[0]) ?? 0) + 1); return 1;
    case 'SET': strings.set(args[0], Number(args[1])); return 'OK';
    case 'HSET': { const h = hashes.get(args[0]) ?? new Map(); const isNew = !h.has(args[1]); h.set(args[1], args[2]); hashes.set(args[0], h); return isNew ? 1 : 0; }
    case 'HDEL': return hashes.get(args[0])?.delete(args[1]) ? 1 : 0;
    case 'HEXISTS': return hashes.get(args[0])?.has(args[1]) ? 1 : 0;
    default: throw new Error(`fake redis: unsupported ${cmd}`);
  }
}

function runLua(script: string, keys: string[], argv: string[]): unknown {
  const js = script
    .replace(/--[^\n]*/g, '')
    .replace(/\bKEYS\[(\d+)\]/g, (_m, n) => `KEYS[${Number(n) - 1}]`)
    .replace(/\bARGV\[(\d+)\]/g, (_m, n) => `ARGV[${Number(n) - 1}]`)
    .replace(/redis\.call\(/g, 'call(')
    .replace(/\btonumber\(/g, 'Number(')
    .replace(/\blocal\s+/g, 'let ')
    .replace(/\bif\s+([\s\S]+?)\s+then\b/g, 'if ($1) {')
    .replace(/\bend\b/g, '}')
    .replace(/~=/g, '!==')
    .replace(/([^=!<>])==([^=])/g, '$1===$2');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('KEYS', 'ARGV', 'call', js)(keys, argv, call);
}

const mockEval = jest.fn<(...args: any[]) => any>(async (script: string, numKeys: number, ...rest: string[]) =>
  runLua(script, rest.slice(0, numKeys), rest.slice(numKeys)));
const mockDecr = jest.fn<(...args: any[]) => any>(async (key: string) => call('DECR', key));
const mockHdel = jest.fn<(...args: any[]) => any>(async (key: string, field: string) => call('HDEL', key, field));
const mockHgetall = jest.fn<(...args: any[]) => any>(async (key: string) => Object.fromEntries(hashes.get(key) ?? new Map()));

const redis = {
  eval: mockEval,
  decr: mockDecr,
  hdel: mockHdel,
  hgetall: mockHgetall,
};

const mockGetAllTierQueues = jest.fn<() => any[]>(() => []);
const mockGetDeadLetterQueue = jest.fn<() => any>(() => ({ name: 'plugin-build-dlq', getJobs: async () => [] }));

// Registered as a function so the NaN-fallback test can re-apply the mocks
// after `jest.resetModules()` and re-import slot-manager with a garbage env.
// NOTE: api-core's `envInt` is the real one, so the fallback behaviour is
// exercised end-to-end.
function registerMocks() {
  jest.unstable_mockModule('../src/queue/connections.js', () => ({
    getConnectionForDb: () => redis,
    getAllTierQueues: mockGetAllTierQueues,
    getDeadLetterQueue: mockGetDeadLetterQueue,
  }));

  jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
    incCounter: mockIncCounter,
  }));

  jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
    createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  }));
}

registerMocks();

const mod0 = await import('../src/queue/slot-manager.js');
const {
  releaseOrgSlot, scrubOrgSlots, refreshOrgSlot, startOrgSlotHeartbeat, MAX_SLOT_DELAYS, maxBuildsPerOrg,
} = mod0;

// Most cases here are about the Lua, not the ladder, so they acquire on the
// roomiest row (enterprise/standard = 8) and the cases that are about the cap
// name their own tier and class.
const acquire = (orgId: string, jobId: string, tier = 'enterprise', cls = 'standard') =>
  mod0.tryAcquireOrgSlot(orgId, jobId, tier as never, cls as never);

const OWNERS_KEY = 'pb:org-build-owners';
const count = (orgId: string, cls = 'standard') => strings.get(`pb:org-build:${orgId}:${cls}`) ?? 0;
const expiresFor = (orgId: string, cls = 'standard') => expires.get(`pb:org-build:${orgId}:${cls}`);
const owners = () => Object.fromEntries(hashes.get(OWNERS_KEY) ?? new Map());

function resetRedis() {
  strings.clear();
  hashes.clear();
  expires.clear();
}

// -- Tests --------------------------------------------------------------------

describe('scrubOrgSlots reclaim accounting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRedis();
    mockGetAllTierQueues.mockReturnValue([]);
  });

  it('counts every reclaimed slot, because a leak shrinks an org\'s concurrency silently', async () => {
    // Acquire two slots, then let BullMQ forget both jobs (no live queues), which
    // is what a crashed worker looks like to the scrubber.
    await acquire('org-a', 'q:job-1');
    await acquire('org-a', 'q:job-2');
    expect(count('org-a')).toBe(2);

    await scrubOrgSlots();

    expect(count('org-a')).toBe(0);
    // Logged ONLY, before this: a leaked slot permanently reduces that org's
    // build concurrency until a scrub, so the shrink was unalertable.
    expect(mockIncCounter).toHaveBeenCalledTimes(2);
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_build_slot_reclaimed_total', { build_class: 'standard' });
  });

  it('counts nothing when every owner is still live', async () => {
    await acquire('org-a', 'plugin-build-developer:job-1');
    mockGetAllTierQueues.mockReturnValue([
      { tier: 'developer', queue: { name: 'plugin-build-developer', getJobs: async () => [{ id: 'job-1' }] } },
    ]);

    await scrubOrgSlots();

    expect(count('org-a')).toBe(1);
    expect(mockIncCounter).not.toHaveBeenCalled();
  });
});

describe('refreshOrgSlot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRedis();
  });

  it('extends a HELD slot, so the TTL is a crash window and not a build-duration cap', async () => {
    await acquire('org-a', 'q:job-1');
    const afterAcquire = expiresFor('org-a') ?? 0;

    expect(await refreshOrgSlot('org-a', 'q:job-1', 'standard')).toBe(true);

    // The acquire expired it once; the refresh expired it again. Without this a
    // 900s TTL silently uncapped any org whose build ran longer than 15 minutes:
    // the counter vanished WHILE builds ran, the next acquire started from zero,
    // and release then under-counted into the negative clamp.
    expect(expiresFor('org-a')).toBe(afterAcquire + 1);
  });

  it('refuses to refresh a slot this job does not hold, so a stale timer cannot resurrect the counter', async () => {
    // A heartbeat tick can race its own job's release. If the refresh were
    // ungated it would re-EXPIRE a counter key for a slot nobody holds, wedging
    // capacity that only the scrubber could then reclaim.
    expect(await refreshOrgSlot('org-a', 'q:never-acquired', 'standard')).toBe(false);
    expect(expiresFor('org-a')).toBeUndefined();

    await acquire('org-a', 'q:job-1');
    await releaseOrgSlot('org-a', 'q:job-1', 'standard');
    const afterRelease = expiresFor('org-a') ?? 0;

    expect(await refreshOrgSlot('org-a', 'q:job-1', 'standard')).toBe(false);
    expect(expiresFor('org-a')).toBe(afterRelease);
  });

  it('gates the refresh on the owner record inside the Lua, not in JS', async () => {
    await acquire('org-a', 'q:job-1');
    await refreshOrgSlot('org-a', 'q:job-1', 'standard');

    const lua = String(mockEval.mock.calls[mockEval.mock.calls.length - 1][0]);
    // One round trip: the ownership check and the EXPIRE are atomic together.
    expect(lua).toMatch(/HEXISTS/);
    expect(lua).toMatch(/EXPIRE/);
  });
});

describe('startOrgSlotHeartbeat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRedis();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps refreshing while the build runs, and stops when told to', async () => {
    await acquire('org-a', 'q:job-1');
    const baseline = expiresFor('org-a') ?? 0;

    const stop = startOrgSlotHeartbeat('org-a', 'q:job-1', 'standard');

    // Default heartbeat is PLUGIN_ORG_SLOT_TTL_SEC / 3 = 300s.
    await jest.advanceTimersByTimeAsync(300_000);
    expect(expiresFor('org-a')).toBe(baseline + 1);

    await jest.advanceTimersByTimeAsync(300_000);
    expect(expiresFor('org-a')).toBe(baseline + 2);

    stop();
    await jest.advanceTimersByTimeAsync(900_000);
    // No further refreshes: the stopper must run in the processor's `finally`,
    // or a timer outlives every build the worker ever ran.
    expect(expiresFor('org-a')).toBe(baseline + 2);
  });

  it('survives a refresh that rejects, because losing a TTL extension must never fail a build', async () => {
    await acquire('org-a', 'q:job-1');
    mockEval.mockRejectedValueOnce(new Error('redis blip'));

    const stop = startOrgSlotHeartbeat('org-a', 'q:job-1', 'standard');
    await expect(jest.advanceTimersByTimeAsync(300_000)).resolves.toBeUndefined();
    stop();
  });
});

describe('MAX_SLOT_DELAYS', () => {
  it('is the wait budget divided by the retry delay, so the two cannot disagree', () => {
    // Defaults: 1_800_000ms budget / 10_000ms delay = 180 delays (30 minutes).
    expect(MAX_SLOT_DELAYS).toBe(180);
  });

  it('never falls below one delay, however small the budget is set', async () => {
    jest.resetModules();
    process.env.PLUGIN_ORG_SLOT_MAX_WAIT_MS = '1';
    registerMocks();
    const fresh = await import('../src/queue/slot-manager.js');
    delete process.env.PLUGIN_ORG_SLOT_MAX_WAIT_MS;

    // A zero budget would reject every build on its first slot denial.
    expect(fresh.MAX_SLOT_DELAYS).toBe(1);
  });
});

describe('tryAcquireOrgSlot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRedis();
  });

  it('refreshes the counter TTL on EVERY acquire (Lua EXPIRE is unconditional)', async () => {
    await acquire('org-a', 'plugin-build-developer:job-1');

    const lua = String(mockEval.mock.calls[0][0]);
    // EXPIRE is present...
    expect(lua).toMatch(/EXPIRE/);
    // ...and NOT gated behind the 0->1 transition (the old `if count == 1` bug).
    expect(lua).not.toMatch(/count\s*==\s*1/);
  });

  it('records the owner ATOMICALLY with the INCR, keyed by the queue-qualified id', async () => {
    // The HSET used to be a SECOND round trip after the eval. If it threw, the
    // counter was already raised with no owner entry — and the scrubber
    // reclaims by iterating the owner hash, so that slot could only be
    // reclaimed by the 900s TTL, wedging the org's cap until then.
    expect(await acquire('org-a', 'plugin-build-developer:job-1')).toBe(true);

    expect(mockEval).toHaveBeenCalledTimes(1); // one round trip
    expect(count('org-a')).toBe(1);
    expect(owners()).toEqual({ 'plugin-build-developer:job-1': 'org-a|standard' });
  });

  it('records no owner (and holds no slot) when the cap is already reached', async () => {
    // developer/flexible = 3, named explicitly: the cap is the assertion here, so
    // it must come from the ladder rather than from whatever the default row is.
    for (let i = 1; i <= 3; i++) await acquire('org-a', `q:job-${i}`, 'developer', 'flexible');

    expect(await acquire('org-a', 'q:job-9', 'developer', 'flexible')).toBe(false);
    expect(count('org-a', 'flexible')).toBe(3);
    expect(owners()).not.toHaveProperty('q:job-9');
  });

  it('is re-entrant per job: a re-run of a job that already holds a slot takes no second one', async () => {
    // A stalled job re-run by BullMQ keeps its id; a second INCR could never be
    // given back (release is keyed on the single owner record).
    await acquire('org-a', 'q:job-1');
    expect(await acquire('org-a', 'q:job-1')).toBe(true);
    expect(count('org-a')).toBe(1);

    await releaseOrgSlot('org-a', 'q:job-1', 'standard');
    expect(count('org-a')).toBe(0);
  });
});

describe('releaseOrgSlot — idempotent per job', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRedis();
  });

  it('releases a held slot exactly once, however many times release runs for the job', async () => {
    await acquire('org-a', 'q:job-1');
    await acquire('org-a', 'q:job-2');

    expect(await releaseOrgSlot('org-a', 'q:job-1', 'standard')).toBe(true);
    expect(await releaseOrgSlot('org-a', 'q:job-1', 'standard')).toBe(false);
    expect(await releaseOrgSlot('org-a', 'q:job-1', 'standard')).toBe(false);

    // job-2 still holds its slot — a double release used to steal it.
    expect(count('org-a')).toBe(1);
    expect(owners()).toEqual({ 'q:job-2': 'org-a|standard' });
  });

  it('never drives the counter negative (e.g. after the counter key expired)', async () => {
    await acquire('org-a', 'q:job-1');
    strings.delete('pb:org-build:org-a:standard'); // TTL lapsed while the job ran

    await releaseOrgSlot('org-a', 'q:job-1', 'standard');
    expect(count('org-a')).toBe(0);
  });
});

describe('scrubOrgSlots — queue-qualified reconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRedis();
  });

  it('reclaims a same-id slot in a different queue (bare-id collision would leak it)', async () => {
    // Two owners share the bare job id "job-1" but live in different tier queues.
    await acquire('org-a', 'plugin-build-developer:job-1'); // live below
    await acquire('org-b', 'plugin-build-pro:job-1'); // NOT live → must be reclaimed

    // Only the developer queue actually has job-1 in flight; pro is empty.
    mockGetAllTierQueues.mockReturnValueOnce([
      { tier: 'developer', queue: { name: 'plugin-build-developer', getJobs: async () => [{ id: 'job-1' }] } },
      { tier: 'pro', queue: { name: 'plugin-build-pro', getJobs: async () => [] } },
    ]);
    mockGetDeadLetterQueue.mockReturnValueOnce({ name: 'plugin-build-dlq', getJobs: async () => [] });

    await scrubOrgSlots();

    // org-b's leaked slot reclaimed...
    expect(count('org-b')).toBe(0);
    // ...while the genuinely-live developer:job-1 owner is untouched.
    expect(count('org-a')).toBe(1);
    expect(owners()).toEqual({ 'plugin-build-developer:job-1': 'org-a|standard' });
  });

  it('keeps an owner whose job is live in its own queue', async () => {
    await acquire('org-c', 'plugin-build-team:job-5');
    mockGetAllTierQueues.mockReturnValueOnce([
      { tier: 'team', queue: { name: 'plugin-build-team', getJobs: async () => [{ id: 'job-5' }] } },
    ]);
    mockGetDeadLetterQueue.mockReturnValueOnce({ name: 'plugin-build-dlq', getJobs: async () => [] });

    await scrubOrgSlots();

    expect(count('org-c')).toBe(1);
    expect(owners()).toEqual({ 'plugin-build-team:job-5': 'org-c|standard' });
  });

  it('does not double-decrement a job that released its own slot after the owner snapshot', async () => {
    // The race: the scrubber snapshots the owner hash, the job finishes and its
    // processor `finally` releases the slot, THEN the scrubber (seeing the job
    // no longer live) releases it again — stealing another in-flight job's slot.
    await acquire('org-a', 'plugin-build-developer:job-1');
    await acquire('org-a', 'plugin-build-developer:job-2'); // still running

    mockGetAllTierQueues.mockReturnValueOnce([
      {
        tier: 'developer',
        queue: {
          name: 'plugin-build-developer',
          getJobs: async () => {
            // job-1 completes (and releases) between the snapshot and the scrub loop.
            await releaseOrgSlot('org-a', 'plugin-build-developer:job-1', 'standard');
            return [{ id: 'job-2' }];
          },
        },
      },
    ]);
    mockGetDeadLetterQueue.mockReturnValueOnce({ name: 'plugin-build-dlq', getJobs: async () => [] });

    await scrubOrgSlots();

    expect(count('org-a')).toBe(1); // job-2's slot survives
    expect(owners()).toEqual({ 'plugin-build-developer:job-2': 'org-a|standard' });
  });
});

describe('maxBuildsPerOrg — NaN-fallback (bricked-builds regression)', () => {
  const KEY = 'PLUGIN_MAX_BUILDS_DEVELOPER_STANDARD';
  const original = process.env[KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
    jest.clearAllMocks();
  });

  it('falls back to the default cap (3) instead of passing NaN to the acquire Lua', async () => {
    // A garbage env value previously produced `parseInt('garbage', 10) === NaN`,
    // and `String(NaN)` -> the Lua's `tonumber(ARGV[1])` returns nil, so every
    // acquire would throw and brick ALL plugin builds. intFromEnv must instead
    // fall back to the numeric default.
    process.env[KEY] = 'not-a-number';
    jest.resetModules();
    registerMocks();
    const mod = await import('../src/queue/slot-manager.js');

    resetRedis();
    const ok = await mod.tryAcquireOrgSlot('org-x', 'plugin-build-developer:job-1', 'developer', 'standard');

    expect(ok).toBe(true);
    // eval args: (LUA, numKeys, counterKey, ownersKey, String(cap), String(ttl),
    // jobId, ownerValue). The cap must be the tier/class default from the
    // ladder, never the string 'NaN' — one fat-fingered override would
    // otherwise brick every plugin build, not just that tier's.
    const capArg = mockEval.mock.calls.at(-1)![4];
    expect(capArg).toBe('1');
    expect(capArg).not.toBe('NaN');
  });

  it('honours a valid override', async () => {
    process.env[KEY] = '7';
    jest.resetModules();
    registerMocks();
    const mod = await import('../src/queue/slot-manager.js');

    resetRedis();
    await mod.tryAcquireOrgSlot('org-x', 'plugin-build-developer:job-2', 'developer', 'standard');

    expect(mockEval.mock.calls.at(-1)![4]).toBe('7');
  });
});

describe('per-class, per-tier caps', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRedis();
  });

  it('gives each class its OWN counter, so flexible work cannot starve standard', async () => {
    // The regression this blocks: with one shared counter an org that fills it
    // with cheap flexible builds has no slot left for the urgent fix — which is
    // the entire reason every tier carries both classes.
    for (let i = 1; i <= 3; i++) await acquire('org-a', `q:flex-${i}`, 'developer', 'flexible');
    expect(await acquire('org-a', 'q:flex-4', 'developer', 'flexible')).toBe(false);

    // Standard is untouched by the flexible saturation above.
    expect(await acquire('org-a', 'q:std-1', 'developer', 'standard')).toBe(true);
    expect(count('org-a', 'standard')).toBe(1);
    expect(count('org-a', 'flexible')).toBe(3);
  });

  it('caps by TIER, so a Developer org no longer gets an Enterprise org\'s concurrency', async () => {
    // One flat PLUGIN_MAX_BUILDS_PER_ORG before: the per-org semaphore was the
    // one place in the build path that ignored what the tenant pays for.
    expect(maxBuildsPerOrg('developer', 'standard')).toBe(1);
    expect(maxBuildsPerOrg('enterprise', 'standard')).toBe(8);

    expect(await acquire('org-dev', 'q:job-1', 'developer', 'standard')).toBe(true);
    expect(await acquire('org-dev', 'q:job-2', 'developer', 'standard')).toBe(false);
  });

  it('gives flexible more headroom than standard on every tier', async () => {
    // Where the room is: the cheap class is what actually smooths load, so a
    // row with flexible <= standard would make the class pointless to choose.
    for (const tier of ['developer', 'pro', 'team', 'business', 'enterprise', 'unlimited'] as const) {
      expect(maxBuildsPerOrg(tier, 'flexible')).toBeGreaterThan(maxBuildsPerOrg(tier, 'standard'));
    }
  });

  it('records the CLASS in the owner value, so the scrubber reclaims from the right counter', async () => {
    await acquire('org-a', 'q:job-1', 'developer', 'flexible');
    expect(owners()).toEqual({ 'q:job-1': 'org-a|flexible' });

    await scrubOrgSlots();

    // Reclaimed from the flexible counter. With the org alone in the owner value
    // the scrubber could not tell which of the two counters to give back:
    // the real slot leaks and the other counter walks toward its clamp.
    expect(count('org-a', 'flexible')).toBe(0);
    expect(count('org-a', 'standard')).toBe(0);
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_build_slot_reclaimed_total', { build_class: 'flexible' });
  });

  it('reclaims an owner value with no class suffix as standard, without decrementing a class counter it never took', async () => {
    // Defensive: a malformed owner value must not be trusted as a class.
    hashes.set(OWNERS_KEY, new Map([['q:job-legacy', 'org-a']]));
    strings.set('pb:org-build:org-a:standard', 1);

    await scrubOrgSlots();

    expect(count('org-a', 'standard')).toBe(0);
    expect(owners()).toEqual({});
  });
});
