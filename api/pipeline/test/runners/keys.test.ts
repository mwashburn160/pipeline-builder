// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The per-org key store's transitions over an in-memory store that enforces
 * the partial unique indexes: generate, rotate, promote, retire, finish,
 * cancel, revoke (org admin and system), concurrent rotates, the first key on
 * the first runner, inherit/own switches, an ancestry change, a parent's
 * rotation reaching its teams, age reminders and the DTO — and that no audit
 * entry, notice or invalidation message ever carries key material.
 */

import { describe, expect, it } from '@jest/globals';
import { verifyEdDsaJws } from '../../src/runners/jws.js';
import {
  advanceKeyTransitions,
  cancelOrgKeyRotation,
  ensureOrgKeyForFirstRunner,
  finishOrgKeyRotation,
  generateOrgKey,
  listKeyStatus,
  promoteDueKeys,
  publicKeysForRunner,
  retireDueKeys,
  revokeOrgKey,
  rotateOrgKey,
  sendKeyAgeReminders,
  setOrgKeyMode,
  signingKeyDto,
} from '../../src/runners/keys.js';
import { keyedDeps, type KeyedDeps } from '../helpers/key-fakes.js';
import { GRANDPARENT, ORG, PARENT, runnerRow } from '../helpers/runner-fakes.js';

const ROOT = PARENT;
const TEAM = ORG;
const ROOT2 = GRANDPARENT;
const MIN = 60_000;
const user = { userId: 'admin-1' };

const states = (d: KeyedDeps, org: string) => [...d.keyStore.keys.values()].filter((k) => k.orgId === org).map((k) => `${k.state}${k.retiredReason ? `:${k.retiredReason}` : ''}`).sort();
const kids = async (d: KeyedDeps, runnerId: string) => (await publicKeysForRunner(d, runnerId))?.keys.map((k) => k.kid) ?? null;
const signingKid = async (d: KeyedDeps, org: string) => { d.keyCaches.signers.clear(); return (await d.signerFor(org)).kid; };
const at = (d: KeyedDeps, minutes: number) => { d.clock.t += minutes * MIN; return new Date(d.clock.t); };
function runner(d: KeyedDeps, orgId: string, over: Parameters<typeof runnerRow>[0] = {}) {
  const r = runnerRow({ orgId, ...over });
  d.store.runners.set(r.id, r);
  return r;
}

/** Nothing that left the key store carries the private key or its ciphertext. */
function expectNoKeyMaterial(d: KeyedDeps) {
  const out = JSON.stringify([d.audits, d.notified, d.published]);
  expect(out).not.toMatch(/PRIVATE KEY|LS0tLS1CRUdJTi|privateKeyEnc|private_key_enc|"alg":"fake"/);
  for (const k of d.keyStore.keys.values()) if (k.privateKeyEnc) expect(out).not.toContain(k.privateKeyEnc);
}

describe('generate', () => {
  it('creates the first key active; a second generate is RUNNER_KEY_EXISTS; audited and noticed with the kid only', async () => {
    const d = keyedDeps();
    const { kid } = await generateOrgKey(d, ROOT, user);
    expect(states(d, ROOT)).toEqual(['active']);
    const row = [...d.keyStore.keys.values()][0]!;
    expect(row).toMatchObject({ kid, createdBy: 'admin-1', publicJwk: { kty: 'OKP', crv: 'Ed25519', kid, use: 'sig', alg: 'EdDSA' } });
    expect(row.publicJwk).not.toHaveProperty('d');
    expect(d.audits).toContainEqual(expect.objectContaining({ action: 'pipeline.runner.key.generate', orgId: ROOT, targetId: kid, details: { kid, state: 'active' } }));
    expect(d.notified).toContainEqual(expect.objectContaining({ recipientOrgId: ROOT, subject: 'Runner signing key created' }));
    expect(d.published).toContainEqual({ kind: 'keys', orgIds: [ROOT] });
    await expect(generateOrgKey(d, ROOT, user)).rejects.toMatchObject({ code: 'RUNNER_KEY_EXISTS', status: 409 });
    expectNoKeyMaterial(d);
  });

  it('a team in inherit mode cannot generate, rotate, cancel, finish or revoke: RUNNER_KEY_INHERITED', async () => {
    const d = keyedDeps();
    d.parents.set(TEAM, ROOT);
    for (const op of [
      () => generateOrgKey(d, TEAM, user), () => rotateOrgKey(d, TEAM, user), () => cancelOrgKeyRotation(d, TEAM, user),
      () => finishOrgKeyRotation(d, TEAM, user), () => revokeOrgKey(d, TEAM, user, 'abcdef'),
    ]) await expect(op()).rejects.toMatchObject({ code: 'RUNNER_KEY_INHERITED' });
  });

  it('the first runner of a root org creates its key (auto); a team\'s first runner creates its root\'s; once only', async () => {
    const d = keyedDeps();
    await ensureOrgKeyForFirstRunner(d, ROOT, 'u-reg');
    expect(states(d, ROOT)).toEqual(['active']);
    expect(d.audits).toContainEqual(expect.objectContaining({ action: 'pipeline.runner.key.generate', details: expect.objectContaining({ auto: true }) }));
    await ensureOrgKeyForFirstRunner(d, ROOT, 'u-reg');
    expect(states(d, ROOT)).toEqual(['active']);
    d.parents.set(TEAM, ROOT2);
    await ensureOrgKeyForFirstRunner(d, TEAM, 'u-team');
    expect(states(d, ROOT2)).toEqual(['active']);
    expect(states(d, TEAM)).toEqual([]);
  });
});

describe('rotate → promote → finish / retire', () => {
  it('rotate publishes next (signs in 10 min); a second rotate, or one with no key, is refused', async () => {
    const d = keyedDeps();
    await expect(rotateOrgKey(d, ROOT, user)).rejects.toMatchObject({ code: 'RUNNER_KEY_MISSING' });
    const first = await generateOrgKey(d, ROOT, user);
    const r = runner(d, ROOT);
    const next = await rotateOrgKey(d, ROOT, user);
    expect(next.activatesAt.getTime()).toBe(d.clock.t + 10 * MIN);
    expect(states(d, ROOT)).toEqual(['active', 'next']);
    // Published at once (the runner's JWKS cache is 10 min), still signed with the old key.
    expect(await kids(d, r.id)).toEqual([first.kid, next.kid]);
    expect(await signingKid(d, ROOT)).toBe(first.kid);
    await expect(rotateOrgKey(d, ROOT, user)).rejects.toMatchObject({ code: 'RUNNER_KEY_TRANSITION_IN_PROGRESS' });
    expect(d.audits).toContainEqual(expect.objectContaining({ action: 'pipeline.runner.key.rotate', details: { kid: next.kid, activatesAt: next.activatesAt.toISOString(), previousKid: first.kid } }));
  });

  it('concurrent rotate calls: one wins, the other gets 409', async () => {
    const d = keyedDeps();
    await generateOrgKey(d, ROOT, user);
    const results = await Promise.allSettled([rotateOrgKey(d, ROOT, user), rotateOrgKey(d, ROOT, user)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'RUNNER_KEY_TRANSITION_IN_PROGRESS', status: 409 });
    expect(states(d, ROOT)).toEqual(['active', 'next']);
  });

  it('promote waits for activates_at, then next → active and active → retiring for 1 h; finish refuses before retire_after', async () => {
    const d = keyedDeps();
    const first = await generateOrgKey(d, ROOT, user);
    const r = runner(d, ROOT);
    const next = await rotateOrgKey(d, ROOT, user);
    await promoteDueKeys(d, at(d, 9));
    expect(states(d, ROOT)).toEqual(['active', 'next']);
    const promoteAt = at(d, 2);
    await promoteDueKeys(d, promoteAt);
    expect(states(d, ROOT)).toEqual(['active', 'retiring']);
    const retiring = [...d.keyStore.keys.values()].find((k) => k.state === 'retiring')!;
    expect(retiring.kid).toBe(first.kid);
    expect(retiring.retireAfter!.getTime()).toBe(promoteAt.getTime() + 60 * MIN);
    expect(await signingKid(d, ROOT)).toBe(next.kid);
    expect(await kids(d, r.id)).toEqual([next.kid, first.kid]);
    expect(d.audits).toContainEqual(expect.objectContaining({ action: 'pipeline.runner.key.promote', details: { kid: next.kid, previousKid: first.kid } }));
    expect(d.notified).toContainEqual(expect.objectContaining({ subject: 'Runner signing key now active' }));
    await expect(finishOrgKeyRotation(d, ROOT, user)).rejects.toMatchObject({ code: 'RUNNER_KEY_RETIRE_TOO_EARLY' });
    at(d, 61);
    await finishOrgKeyRotation(d, ROOT, user);
    expect(states(d, ROOT)).toEqual(['active', 'retired:finished']);
    expect([...d.keyStore.keys.values()].find((k) => k.kid === first.kid)!.privateKeyEnc).toBeNull();
    expect(await kids(d, r.id)).toEqual([next.kid]);
    await expect(finishOrgKeyRotation(d, ROOT, user)).rejects.toMatchObject({ code: 'RUNNER_KEY_NO_ROTATION' });
    expectNoKeyMaterial(d);
  });

  it('the sweep retires a retiring key once retire_after passes (private key wiped)', async () => {
    const d = keyedDeps();
    await generateOrgKey(d, ROOT, user);
    await rotateOrgKey(d, ROOT, user);
    await promoteDueKeys(d, at(d, 11));
    await retireDueKeys(d, at(d, 30));
    expect(states(d, ROOT)).toEqual(['active', 'retiring']);
    await retireDueKeys(d, at(d, 31));
    expect(states(d, ROOT)).toEqual(['active', 'retired:finished']);
    expect(d.audits).toContainEqual(expect.objectContaining({ action: 'pipeline.runner.key.retire', details: expect.objectContaining({ reason: 'finished' }) }));
  });

  it('cancel withdraws a next key (retired, cancelled; never deleted); nothing to cancel is RUNNER_KEY_NO_ROTATION', async () => {
    const d = keyedDeps();
    await generateOrgKey(d, ROOT, user);
    await expect(cancelOrgKeyRotation(d, ROOT, user)).rejects.toMatchObject({ code: 'RUNNER_KEY_NO_ROTATION' });
    const next = await rotateOrgKey(d, ROOT, user);
    expect(await cancelOrgKeyRotation(d, ROOT, user)).toEqual({ kid: next.kid });
    expect(states(d, ROOT)).toEqual(['active', 'retired:cancelled']);
    // A new rotation may start.
    await rotateOrgKey(d, ROOT, user);
  });
});

describe('revoke', () => {
  it('needs the last 6 characters of the active kid; retires it now and promotes next, or creates a new active key', async () => {
    const d = keyedDeps();
    const first = await generateOrgKey(d, ROOT, user);
    await expect(revokeOrgKey(d, ROOT, user, 'nope00')).rejects.toMatchObject({ code: 'RUNNER_KEY_CONFIRMATION_MISMATCH', status: 400 });
    expect(states(d, ROOT)).toEqual(['active']);
    const out = await revokeOrgKey(d, ROOT, user, first.kid.slice(-6));
    expect(out.revokedKid).toBe(first.kid);
    expect(states(d, ROOT)).toEqual(['active', 'retired:revoked']);
    expect(await signingKid(d, ROOT)).toBe(out.activeKid);
    // With a pending next key, that one is promoted.
    const next = await rotateOrgKey(d, ROOT, user);
    const again = await revokeOrgKey(d, ROOT, user, out.activeKid.slice(-6));
    expect(again).toEqual({ revokedKid: out.activeKid, activeKid: next.kid });
    expect(states(d, ROOT)).toEqual(['active', 'retired:revoked', 'retired:revoked']);
    expect(d.audits).toContainEqual(expect.objectContaining({ action: 'pipeline.runner.key.revoke', details: { kid: out.activeKid, newActiveKid: next.kid } }));
    expectNoKeyMaterial(d);
  });

  it('the system-org revoke needs no confirmation and is audited as system_revoke on the system org naming the operator', async () => {
    const d = keyedDeps();
    const first = await generateOrgKey(d, ROOT, user);
    const out = await revokeOrgKey(d, ROOT, { userId: 'operator-1', system: true, reason: 'leak' }, null);
    expect(out.revokedKid).toBe(first.kid);
    expect(d.audits).toContainEqual(expect.objectContaining({
      action: 'pipeline.runner.key.system_revoke',
      actorId: 'operator-1',
      orgId: '000000000000000000000001',
      affectedOrgId: ROOT,
      details: { kid: first.kid, newActiveKid: out.activeKid, reason: 'leak' },
    }));
    expect(d.notified).toContainEqual(expect.objectContaining({ recipientOrgId: ROOT, subject: 'Runner signing key revoked', priority: 'high' }));
  });
});

describe('inheritance', () => {
  it('a parent\'s rotation reaches inheriting teams (one invalidation naming both, a notice to both) and the DTO counts them', async () => {
    const d = keyedDeps();
    d.parents.set(TEAM, ROOT);
    await generateOrgKey(d, ROOT, user);
    runner(d, ROOT);
    runner(d, TEAM);
    d.published.length = 0;
    d.notified.length = 0;
    await rotateOrgKey(d, ROOT, user);
    expect(d.published).toEqual([{ kind: 'keys', orgIds: [ROOT, TEAM] }]);
    expect(d.notified.map((n) => (n as { recipientOrgId: string }).recipientOrgId).sort()).toEqual([TEAM, ROOT].sort());
    const dto = await signingKeyDto(d, ROOT);
    expect(dto).toMatchObject({ mode: 'own', isRootOrg: true, rotation: 'pending', inheritingTeams: 1, inheritingTeamNames: ['Org 67'], inheritingRunners: 2, unreadable: false, maxAgeDays: 365 });
    const team = await signingKeyDto(d, TEAM);
    expect(team).toMatchObject({ mode: 'inherit', isRootOrg: false, active: null, inheritedFrom: { orgId: ROOT, orgName: 'Org 68', rotation: 'pending' }, inheritingTeams: 0 });
    expect(JSON.stringify([dto, team])).not.toMatch(/privateKeyEnc|PRIVATE KEY|"x":/);
  });

  it('a root org cannot change mode; the same mode is a 400; a switch in progress is a 409', async () => {
    const d = keyedDeps();
    d.parents.set(TEAM, ROOT);
    await generateOrgKey(d, ROOT, user);
    await expect(setOrgKeyMode(d, ROOT, 'inherit', user)).rejects.toMatchObject({ code: 'RUNNER_KEY_MODE_ROOT_ORG', status: 409 });
    await expect(setOrgKeyMode(d, TEAM, 'inherit', user)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    await setOrgKeyMode(d, TEAM, 'own', user);
    await expect(setOrgKeyMode(d, TEAM, 'inherit', user)).rejects.toMatchObject({ code: 'RUNNER_KEY_TRANSITION_IN_PROGRESS' });
  });

  it('inherit → own: the team\'s key is published next beside the parent\'s, signs after 10 min, and the parent\'s keys leave 1 h later', async () => {
    const d = keyedDeps();
    d.parents.set(TEAM, ROOT);
    const parent = await generateOrgKey(d, ROOT, user);
    const r = runner(d, TEAM);
    const sw = await setOrgKeyMode(d, TEAM, 'own', user);
    const own = [...d.keyStore.keys.values()].find((k) => k.orgId === TEAM)!;
    expect(own).toMatchObject({ state: 'next' });
    expect(own.activatesAt).toEqual(sw.switchAt);
    expect(await kids(d, r.id)).toEqual([own.kid, parent.kid]);
    expect(await signingKid(d, TEAM)).toBe(parent.kid);
    // Even past switch_at, until the sweep promotes the team's key, the parent keeps signing.
    at(d, 10);
    expect(await signingKid(d, TEAM)).toBe(parent.kid);
    await promoteDueKeys(d, at(d, 1));
    expect(await signingKid(d, TEAM)).toBe(own.kid);
    expect(await kids(d, r.id)).toEqual([own.kid, parent.kid]);
    // The team's pending key can't be withdrawn while the switch waits on it.
    await advanceKeyTransitions(d, at(d, 61));
    expect(d.keyStore.settingsRows.get(TEAM)).toMatchObject({ mode: 'own', transitionKind: null, effectiveKeyOrgId: TEAM });
    expect(await kids(d, r.id)).toEqual([own.kid]);
    expect(d.audits).toContainEqual(expect.objectContaining({ action: 'pipeline.runner.key.mode', targetType: 'organization', details: expect.objectContaining({ from: 'inherit', to: 'own' }) }));
  });

  it('own → inherit: the parent\'s keys are published now, signing moves after 10 min, the team\'s keys retire 1 h later', async () => {
    const d = keyedDeps();
    d.parents.set(TEAM, ROOT);
    const parent = await generateOrgKey(d, ROOT, user);
    const r = runner(d, TEAM);
    await setOrgKeyMode(d, TEAM, 'own', user);
    await promoteDueKeys(d, at(d, 11));
    await advanceKeyTransitions(d, at(d, 61));
    const own = [...d.keyStore.keys.values()].find((k) => k.orgId === TEAM && k.state === 'active')!;
    await setOrgKeyMode(d, TEAM, 'inherit', user);
    expect(await kids(d, r.id)).toEqual([parent.kid, own.kid]);
    expect(await signingKid(d, TEAM)).toBe(own.kid);
    await advanceKeyTransitions(d, at(d, 11));
    expect(states(d, TEAM)).toEqual(['retiring']);
    expect(await signingKid(d, TEAM)).toBe(parent.kid);
    expect(await kids(d, r.id)).toEqual([parent.kid, own.kid]);
    await retireDueKeys(d, at(d, 61));
    await advanceKeyTransitions(d, new Date(d.clock.t));
    expect(states(d, TEAM)).toEqual(['retired:mode_switch']);
    expect(await kids(d, r.id)).toEqual([parent.kid]);
    expect(d.keyStore.settingsRows.get(TEAM)).toMatchObject({ mode: 'inherit', transitionKind: null });
  });

  it('an ancestry change (team moved to another parent) keeps the old key signing, then switches with the same windows', async () => {
    const d = keyedDeps();
    d.parents.set(TEAM, ROOT);
    const p1 = await generateOrgKey(d, ROOT, user);
    const p2 = await generateOrgKey(d, ROOT2, user);
    const r = runner(d, TEAM);
    await advanceKeyTransitions(d); // first resolution recorded
    expect(d.keyStore.settingsRows.get(TEAM)).toMatchObject({ mode: 'inherit', effectiveKeyOrgId: ROOT, transitionKind: null });
    d.parents.set(TEAM, ROOT2);
    // Not abrupt: before the sweep notices, the old parent still signs and both are published.
    expect(await signingKid(d, TEAM)).toBe(p1.kid);
    expect(await kids(d, r.id)).toEqual([p2.kid, p1.kid]);
    await advanceKeyTransitions(d, at(d, 1));
    expect(d.keyStore.settingsRows.get(TEAM)).toMatchObject({ transitionKind: 'ancestry', previousKeyOrgId: ROOT, effectiveKeyOrgId: ROOT2 });
    expect(await signingKid(d, TEAM)).toBe(p1.kid);
    at(d, 10);
    expect(await signingKid(d, TEAM)).toBe(p2.kid);
    expect(await kids(d, r.id)).toEqual([p2.kid, p1.kid]);
    await advanceKeyTransitions(d, at(d, 61));
    expect(await kids(d, r.id)).toEqual([p2.kid]);
    expect(d.keyStore.settingsRows.get(TEAM)).toMatchObject({ transitionKind: null });
  });

  it('a parent\'s runner shared with teams always uses the parent\'s key, whatever the team\'s mode', async () => {
    const d = keyedDeps();
    d.parents.set(TEAM, ROOT);
    const parent = await generateOrgKey(d, ROOT, user);
    const shared = runner(d, ROOT, { shareWithTeams: true });
    await setOrgKeyMode(d, TEAM, 'own', user);
    await promoteDueKeys(d, at(d, 11));
    expect(await kids(d, shared.id)).toEqual([parent.kid]);
    const jws = (await d.signerFor(shared.orgId)).sign({ runnerId: shared.id, requestId: 'q', action: 'ping', requestedBy: 'u' });
    expect(verifyEdDsaJws(jws, (await publicKeysForRunner(d, shared.id))!.keys).payload.aud).toBe(shared.id);
  });
});

describe('the per-runner JWKS set', () => {
  it('pending runners are served; revoked and unknown runners get null; public halves only', async () => {
    const d = keyedDeps();
    const { kid } = await generateOrgKey(d, ROOT, user);
    const pending = runner(d, ROOT, { status: 'pending', functionUrl: null });
    const revoked = runner(d, ROOT, { status: 'revoked' });
    expect(await kids(d, pending.id)).toEqual([kid]);
    expect(await publicKeysForRunner(d, revoked.id)).toBeNull();
    expect(await publicKeysForRunner(d, '99999999-9999-4999-8999-999999999999')).toBeNull();
    const set = await publicKeysForRunner(d, pending.id);
    expect(Object.keys(set!.keys[0]!).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x']);
    // An owner with no keys at all: null too.
    const lonely = runner(d, ROOT2);
    expect(await publicKeysForRunner(d, lonely.id)).toBeNull();
  });
});

describe('age reminders and gauges', () => {
  it('a notice at RUNNER_KEY_MAX_AGE_DAYS and again 30 days later, each once; gauges for states, oldest age and over-age', async () => {
    const d = keyedDeps();
    d.parents.set(TEAM, ROOT);
    await generateOrgKey(d, ROOT, user);
    d.notified.length = 0;
    await sendKeyAgeReminders(d, at(d, 364 * 24 * 60));
    expect(d.notified).toHaveLength(0);
    await sendKeyAgeReminders(d, at(d, 24 * 60));
    expect(d.notified.map((n) => (n as { subject: string; recipientOrgId: string }))).toEqual([
      expect.objectContaining({ recipientOrgId: ROOT, subject: 'Runner signing key is due for rotation' }),
      expect.objectContaining({ recipientOrgId: TEAM, subject: 'Runner signing key is due for rotation' }),
    ]);
    await sendKeyAgeReminders(d, at(d, 24 * 60));
    expect(d.notified).toHaveLength(2);
    expect(d.gaugeValues.get('pipeline_runner_signing_keys_over_age')).toBe(1);
    expect(d.gaugeValues.get('pipeline_runner_signing_key_age_days')).toBe(366);
    expect(d.gauges).toContainEqual(['pipeline_runner_signing_keys', 1]);
    await sendKeyAgeReminders(d, at(d, 30 * 24 * 60));
    expect(d.notified.filter((n) => (n as { subject: string }).subject === 'Runner signing key is overdue for rotation')).toHaveLength(2);
    await sendKeyAgeReminders(d, at(d, 24 * 60));
    expect(d.notified).toHaveLength(4);
  });
});

describe('operator status table', () => {
  it('lists each org with mode, inherited-from, active kid, age, rotation and flags; filters; no key material', async () => {
    const d = keyedDeps();
    d.parents.set(TEAM, ROOT);
    const { kid } = await generateOrgKey(d, ROOT, user);
    runner(d, TEAM);
    await rotateOrgKey(d, ROOT, user);
    const rows = await listKeyStatus(d);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ orgId: ROOT, mode: 'own', activeKid: kid, keyAgeDays: 0, rotation: 'pending', overAge: false, unreadable: false, runnerCount: 0 }),
      expect.objectContaining({ orgId: TEAM, mode: 'inherit', inheritedFrom: { orgId: ROOT, orgName: 'Org 68' }, activeKid: null, runnerCount: 1 }),
    ]));
    expect(await listKeyStatus(d, { mode: 'inherit' })).toHaveLength(1);
    expect(await listKeyStatus(d, { rotation: 'pending' })).toHaveLength(1);
    expect(await listKeyStatus(d, { unreadable: true })).toHaveLength(0);
    expect(JSON.stringify(rows)).not.toMatch(/privateKeyEnc|PRIVATE KEY/);
  });
});
