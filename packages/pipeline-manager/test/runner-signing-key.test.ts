// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `runner signing-key status|generate|rotate|finish`: each action calls the
 * contract route (status reads GET /runners, writes POST with a step-up token),
 * refusals are explained, and nothing but key ids, states and dates is ever
 * printed — even when a response carries more.
 */

import { describe, it, expect } from '@jest/globals';

const {
  runSigningKeyAction, explainSigningKeyError, signingKeyView, signingKeyLines, runnerSigningKey, SIGNING_KEY_ACTIONS,
} = await import('../src/commands/runner-signing-key.js');
type SigningKeyDeps = import('../src/commands/runner-signing-key.js').SigningKeyDeps;

const refused = (status: number, data: Record<string, unknown>) => Object.assign(new Error(String(status)), { status, response: { status, data } });

const summary = (kid: string, state: string, over: Record<string, unknown> = {}) => ({
  kid, state, createdAt: '2026-11-01T00:00:00Z', createdBy: 'u1', activatesAt: '2026-11-01T00:00:00Z', retireAfter: null, ageDays: 18, ...over,
});
const DTO = {
  mode: 'own',
  isRootOrg: true,
  active: summary('kid-active', 'active'),
  next: null,
  retiring: null,
  rotation: 'none',
  inheritedFrom: null,
  inheritingTeams: 0,
  inheritingTeamNames: [],
  inheritingRunners: 1,
  transition: null,
  unreadable: false,
  maxAgeDays: 365,
} as const;

function fake(opts: { list?: Record<string, unknown>; post?: Record<string, unknown>; error?: unknown } = {}) {
  const calls: Array<{ method: string; url: string; headers?: Record<string, string> }> = [];
  let stepUps = 0;
  const deps: SigningKeyDeps = {
    stepUp: async () => { stepUps += 1; return `su-${stepUps}`; },
    platform: {
      async get(url) {
        calls.push({ method: 'GET', url });
        if (opts.error) throw opts.error;
        return { data: { available: true, own: [], inherited: [], signingKey: DTO, ...opts.list } } as any;
      },
      async post(url, _data, headers) {
        calls.push({ method: 'POST', url, ...(headers ? { headers } : {}) });
        if (opts.error) throw opts.error;
        return { data: opts.post ?? DTO } as any;
      },
    },
  };
  return { deps, calls, stepUps: () => stepUps };
}

describe('runSigningKeyAction', () => {
  it('status reads signingKey from GET /api/pipelines/runners, with no step-up', async () => {
    const f = fake();
    expect(await runSigningKeyAction('status', f.deps)).toEqual(DTO);
    expect(f.calls).toEqual([{ method: 'GET', url: '/api/pipelines/runners' }]);
    expect(f.stepUps()).toBe(0);
  });

  it.each([
    ['generate', '/api/pipelines/runners/signing-key'],
    ['rotate', '/api/pipelines/runners/signing-key/rotate'],
    ['finish', '/api/pipelines/runners/signing-key/finish'],
  ] as const)('%s POSTs %s with a step-up token', async (action, url) => {
    const f = fake();
    await runSigningKeyAction(action, f.deps);
    expect(f.calls).toEqual([{ method: 'POST', url, headers: { 'X-Step-Up-Token': 'su-1' } }]);
  });

  it('status while runners are unavailable says why', async () => {
    const f = fake({ list: { available: false, unavailableReason: 'paused', signingKey: null } });
    await expect(runSigningKeyAction('status', f.deps)).rejects.toThrow(/paused/);
  });

  it.each([
    ['RUNNER_KEY_EXISTS', /already has a signing key.*rotate/s],
    ['RUNNER_KEY_TRANSITION_IN_PROGRESS', /already in progress/],
    ['RUNNER_KEY_NO_ROTATION', /no rotation to finish/],
    ['RUNNER_KEY_RETIRE_TOO_EARLY', /can't be removed yet/],
    ['RUNNER_KEY_INHERITED', /parent's signing key/],
    ['RUNNER_KEY_MISSING', /signing-key generate/],
    ['RUNNER_KEY_UNREADABLE', /can't be read/],
  ])('%s is explained', async (code, msg) => {
    const f = fake({ error: refused(409, { error: { code } }) });
    await expect(runSigningKeyAction('rotate', f.deps)).rejects.toThrow(msg);
  });

  it('the per-org key-write limit (429) is explained; anything else is rethrown as-is', () => {
    expect(() => explainSigningKeyError(refused(429, {}))).toThrow(/Too many signing-key changes/);
    const e = refused(403, { error: { code: 'INSUFFICIENT_PERMISSIONS' } });
    expect(() => explainSigningKeyError(e)).toThrow(e);
  });

  it('an error code that names an Object.prototype member is not a known refusal: rethrown as-is', () => {
    const e = refused(409, { error: { code: 'constructor' } });
    expect(() => explainSigningKeyError(e)).toThrow(e);
  });
});

describe('output', () => {
  it('prints key ids, states and dates only, by allowlist: extra response fields never leak', () => {
    const leaky = {
      ...DTO,
      privateKeyEnc: 'CIPHERTEXT',
      active: { ...DTO.active, private_key_enc: 'CIPHERTEXT', pem: '-----BEGIN PRIVATE KEY-----' },
      next: summary('kid-next', 'next', { ageDays: 0, privateKey: 'x' }),
    } as any;
    const out = JSON.stringify(signingKeyView(leaky)) + JSON.stringify(signingKeyLines(leaky));
    expect(out).not.toMatch(/CIPHERTEXT|PRIVATE KEY|private|pem/i);
    expect(out).toContain('kid-active');
    expect(out).toContain('kid-next');
  });

  it('shows the rotation overlap, an inherited key and an old key', () => {
    const lines = signingKeyLines({
      ...DTO,
      retiring: summary('kid-old', 'retiring', { retireAfter: '2026-11-19T10:42:00Z' }),
      rotation: 'overlap',
      active: summary('kid-active', 'active', { ageDays: 400 }),
    } as any);
    expect(lines.Retiring).toMatch(/kid-old.*2026-11-19T10:42:00Z/);
    expect(lines['Key Age']).toMatch(/400 days old/);
    const inherited = signingKeyLines({ ...DTO, mode: 'inherit', isRootOrg: false, active: null, inheritedFrom: { orgId: 'p', orgName: 'Acme Corp', activeKid: 'kid-p', rotation: 'none' } } as any);
    expect(inherited['Inherited From']).toBe('Acme Corp (active kid-p)');
    expect(inherited.Active).toBeUndefined();
  });
});

describe('the CLI', () => {
  it('registers runner signing-key status|generate|rotate|finish; only the writes take step-up options', async () => {
    const { Command } = await import('commander');
    const program = new Command();
    runnerSigningKey(program.command('runner'));
    const group = program.commands[0]!.commands.find((c) => c.name() === 'signing-key')!;
    expect(group.commands.map((c) => c.name())).toEqual([...SIGNING_KEY_ACTIONS]);
    const flags = (n: string) => group.commands.find((c) => c.name() === n)!.options.map((o) => o.long);
    expect(flags('status')).not.toContain('--step-up');
    for (const w of ['generate', 'rotate', 'finish']) expect(flags(w)).toEqual(expect.arrayContaining(['--step-up', '--password', '--json']));
  });
});
