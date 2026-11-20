// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The superseded-version retention pass's PURE decision (services/retention/
 * select.ts `decidePlugin`): per-major keep, the newest of every major, the
 * implicit install's major, prereleases, installs, holds, the notice period,
 * reversal and the safety limit. The SQL half is retention-select-sql.test.ts.
 */

import { describe, it, expect } from '@jest/globals';

import { decidePlugin, type DecideInput, type InstallFacts, type VersionFacts } from '../src/services/retention/select.js';

const NOW = new Date('2026-11-14T00:00:00Z');
const DAY = 86_400_000;

let seq = 0;
function v(version: string, over: Partial<VersionFacts> = {}): VersionFacts {
  return { pluginId: `p-${version}-${seq++}`, version, digest: null, yanked: false, deprecated: false, retirement: null, held: null, listing: null, ...over };
}

function decide(versions: VersionFacts[], over: Partial<DecideInput> = {}) {
  return decidePlugin({ versions, installs: [], listed: [], keep: 3, noticeDays: 30, maxFraction: 1, now: NOW, ...over });
}

const states = (out: ReturnType<typeof decide>) => Object.fromEntries(out.decisions.map((d) => [d.version, `${d.state}:${d.rule}`]));

describe('protected from automatic removal', () => {
  it('an active or only version is kept with its reason, after every other keep rule', () => {
    const out = decide([v('1.0.0', { protection: 'active' }), v('1.1.0', { protection: 'only_version' }), v('1.2.0'), v('1.3.0'), v('1.4.0'), v('1.5.0')], { keep: 1 });
    const by = Object.fromEntries(out.decisions.map((d) => [d.version, d]));
    expect(by['1.0.0']).toMatchObject({ state: 'keep', rule: 'active' });
    expect(by['1.1.0']).toMatchObject({ state: 'keep', rule: 'only_version' });
    expect(by['1.2.0']!.state).toBe('deprecate');
    // The ordering rule's own reason stays first.
    expect(decide([v('2.0.0', { protection: 'active' })]).decisions[0]).toMatchObject({ state: 'keep', rule: 'implicit_install' });
  });

  it('a version this pass deprecated that is now protected is reversed, and a pending yank is not finished', () => {
    const out = decide([
      v('1.0.0', { deprecated: true, retirement: { deprecatedAt: new Date(NOW.getTime() - 40 * DAY) }, protection: 'active' }),
      v('1.1.0', { yanked: true, retirement: { deprecatedAt: NOW }, protection: 'active' }),
      v('1.2.0'), v('1.3.0'), v('1.4.0'),
    ], { keep: 1 });
    const by = Object.fromEntries(out.decisions.map((d) => [d.version, d]));
    expect(by['1.0.0']).toMatchObject({ state: 'reverse', rule: 'active' });
    expect(by['1.1.0']).toMatchObject({ state: 'keep', rule: 'active' });
  });
});

describe('ordering: N per live major', () => {
  it('keeps the newest N of each major and the newest of every major, retires the rest', () => {
    const out = decide(['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0', '2.0.0', '2.1.0'].map((x) => v(x)));
    expect(states(out)).toEqual({
      '2.1.0': 'keep:newest_in_major',
      '2.0.0': 'keep:within_keep',
      '1.4.0': 'keep:implicit_install',
      '1.3.0': 'keep:within_keep',
      '1.2.0': 'keep:within_keep',
      '1.1.0': 'deprecate:superseded_in_major',
      '1.0.0': 'deprecate:superseded_in_major',
    });
    expect(out.decisions.map((d) => d.version)).toEqual(['2.1.0', '2.0.0', '1.4.0', '1.3.0', '1.2.0', '1.1.0', '1.0.0']);
    expect(out).toMatchObject({ liveCount: 7, retireCount: 2 });
  });

  it('orders by semver, not by the order the rows come in', () => {
    const out = decide([v('1.10.0'), v('1.2.0'), v('1.9.0'), v('1.1.0')], { keep: 2 });
    expect(states(out)).toMatchObject({ '1.10.0': 'keep:implicit_install', '1.9.0': 'keep:within_keep', '1.2.0': 'deprecate:superseded_in_major' });
  });

  it('with keep=1 still keeps the newest of the old major: the implicit install never crosses a major', () => {
    const out = decide([v('1.0.0'), v('1.1.0'), v('2.0.0')], { keep: 1 });
    expect(states(out)).toEqual({ '2.0.0': 'keep:newest_in_major', '1.1.0': 'keep:implicit_install', '1.0.0': 'deprecate:superseded_in_major' });
  });

  it('a version deprecated by someone else does not count toward N, but the newest of a major is kept even when deprecated', () => {
    const out = decide([v('1.0.0'), v('1.1.0'), v('1.2.0', { deprecated: true }), v('1.3.0', { deprecated: true })], { keep: 1 });
    expect(states(out)).toEqual({
      '1.3.0': 'keep:implicit_install',
      '1.2.0': 'deprecate:superseded_in_major',
      '1.1.0': 'keep:within_keep',
      '1.0.0': 'deprecate:superseded_in_major',
    });
  });

  it('this pass\'s own deprecations still count as live, so a version comes back when newer ones are yanked', () => {
    const pending = { deprecatedAt: new Date(NOW.getTime() - 5 * DAY) };
    const out = decide([v('1.0.0', { deprecated: true, retirement: pending }), v('1.1.0'), v('1.2.0', { yanked: true })], { keep: 2 });
    expect(states(out)).toEqual({ '1.2.0': 'keep:already_yanked', '1.1.0': 'keep:implicit_install', '1.0.0': 'reverse:within_keep' });
  });

  it('a yanked version without a retirement is left alone and is not live', () => {
    const out = decide([v('1.0.0', { yanked: true }), v('1.1.0')]);
    expect(states(out)).toEqual({ '1.1.0': 'keep:implicit_install', '1.0.0': 'keep:already_yanked' });
    expect(out.liveCount).toBe(1);
  });
});

describe('prereleases', () => {
  it('never count toward N; one ahead of every stable version of its major is kept, an overtaken one is retirable', () => {
    const out = decide([v('1.0.0'), v('1.1.0-rc.1'), v('1.1.0'), v('2.0.0-beta.1')], { keep: 1 });
    expect(states(out)).toEqual({
      '2.0.0-beta.1': 'keep:prerelease_ahead_of_stable',
      '1.1.0': 'keep:implicit_install',
      '1.1.0-rc.1': 'deprecate:superseded_prerelease',
      '1.0.0': 'deprecate:superseded_in_major',
    });
  });
});

describe('explicit installs', () => {
  const listed = ['1.0.0', '1.1.0', '1.2.0', '1.2.1', '1.3.0', '1.4.0', '1.5.0'].map((version) => ({ version, yankedAt: null, pausedAt: null, breaking: false }));
  const all = () => listed.map((l) => v(l.version));
  const install = (over: Partial<InstallFacts>): InstallFacts => ({ versionPolicy: 'minor', pinnedVersion: null, resolvedVersion: null, pendingChange: null, ...over });

  it('keeps a pinned install\'s version, its last resolved version and a pending change\'s target', () => {
    const out = decide(all(), {
      listed,
      installs: [
        install({ versionPolicy: 'pinned', pinnedVersion: '1.0.0' }),
        install({ versionPolicy: 'latest', resolvedVersion: '1.1.0' }),
        install({ versionPolicy: 'latest', pendingChange: { version: '1.2.0', versionPolicy: 'pinned' } }),
      ],
    });
    expect(states(out)).toMatchObject({ '1.0.0': 'keep:install_pinned', '1.1.0': 'keep:install_resolved', '1.2.0': 'keep:install_pending_change' });
  });

  it('keeps the newest version a patch install admits, so ~1.2.0 never loses its last 1.2.x', () => {
    const out = decide(all(), { listed, installs: [install({ versionPolicy: 'patch', pinnedVersion: '1.2.0' })] });
    expect(states(out)).toMatchObject({ '1.2.1': 'keep:install_newest_admitted', '1.2.0': 'deprecate:superseded_in_major' });
  });
});

describe('reference holds', () => {
  it('a held version is kept with its rule; holdAll keeps every version', () => {
    const out = decide([v('1.0.0', { held: 'template_pin' }), v('1.1.0'), v('1.2.0'), v('1.3.0'), v('1.4.0')]);
    expect(states(out)['1.0.0']).toBe('keep:template_pin');
    const all = decide([v('1.0.0'), v('1.1.0'), v('1.2.0'), v('1.3.0'), v('1.4.0')], { holdAll: 'declared_without_resolution' });
    expect(new Set(all.decisions.map((d) => d.state))).toEqual(new Set(['keep']));
    expect(states(all)['1.0.0']).toBe('keep:declared_without_resolution');
  });

  it('a pending retirement that a rule now holds is reversed', () => {
    const out = decide([v('1.0.0', { deprecated: true, held: 'pipeline_reference', retirement: { deprecatedAt: NOW } }), v('1.1.0'), v('1.2.0'), v('1.3.0'), v('1.4.0')]);
    expect(states(out)['1.0.0']).toBe('reverse:pipeline_reference');
  });
});

describe('the notice period', () => {
  const rest = () => [v('1.2.0'), v('1.3.0'), v('1.4.0')];
  it('keeps a pending retirement in notice until the notice days pass, then yanks it', () => {
    const recent = decide([v('1.0.0', { deprecated: true, retirement: { deprecatedAt: new Date(NOW.getTime() - 29 * DAY) } }), ...rest()]);
    const d = recent.decisions.find((x) => x.version === '1.0.0')!;
    expect(d.state).toBe('notice');
    expect(d.yankAfter).toEqual(new Date(NOW.getTime() + DAY));
    const due = decide([v('1.0.0', { deprecated: true, retirement: { deprecatedAt: new Date(NOW.getTime() - 30 * DAY) } }), ...rest()]);
    expect(due.decisions.find((x) => x.version === '1.0.0')!.state).toBe('yank');
  });

  it('a version yanked by the pass whose soft-delete did not land is finished', () => {
    const out = decide([v('1.0.0', { yanked: true, retirement: { deprecatedAt: NOW } }), ...rest()]);
    expect(states(out)['1.0.0']).toBe('yank:finish_retirement');
  });
});

describe('the per-plugin throttle', () => {
  const tenInOneMajor = () => Array.from({ length: 10 }, (_, i) => v(`1.${i}.0`));

  it('newly deprecates at most floor(maxFraction × live) versions, oldest first, and defers the rest — never refuses', () => {
    // keep=1: 1.9.0 is kept, nine are retirable; 0.5 × 10 live = 5 deprecate now.
    const out = decide(tenInOneMajor(), { keep: 1, maxFraction: 0.5 });
    expect(out.refusedReason).toBeUndefined();
    const now = out.decisions.filter((d) => d.state === 'deprecate' && !d.deferred).map((d) => d.version);
    const later = out.decisions.filter((d) => d.deferred).map((d) => d.version);
    expect(now).toEqual(['1.4.0', '1.3.0', '1.2.0', '1.1.0', '1.0.0']);
    expect(later).toEqual(['1.8.0', '1.7.0', '1.6.0', '1.5.0']);
    expect(out.decisions.every((d) => d.state !== 'refused')).toBe(true);
    expect(out).toMatchObject({ liveCount: 10, retireCount: 9, deferredCount: 4 });
  });

  it('the next pass deprecates the rest: noticed versions are not throttled and do not use the allowance', () => {
    const pending = { deprecatedAt: NOW };
    const versions = tenInOneMajor().map((x, i) => (i < 5 ? { ...x, deprecated: true, retirement: pending } : x));
    const out = decide(versions, { keep: 1, maxFraction: 0.5 });
    expect(out.decisions.filter((d) => d.state === 'notice')).toHaveLength(5);
    expect(out.decisions.filter((d) => d.state === 'deprecate' && !d.deferred).map((d) => d.version)).toEqual(['1.8.0', '1.7.0', '1.6.0', '1.5.0']);
    expect(out.deferredCount).toBe(0);
  });

  it('always allows at least one, and never throttles a yank of an already-noticed version', () => {
    const due = { deprecatedAt: new Date(NOW.getTime() - 40 * DAY) };
    const out = decide([v('1.0.0', { deprecated: true, retirement: due }), v('1.1.0', { deprecated: true, retirement: due }), v('1.2.0'), v('1.3.0'), v('1.4.0')], { keep: 1, maxFraction: 0.01 });
    expect(out.decisions.filter((d) => d.state === 'yank')).toHaveLength(2);
    expect(out.decisions.filter((d) => d.state === 'deprecate' && !d.deferred).map((d) => d.version)).toEqual(['1.2.0']);
    expect(out.decisions.find((d) => d.version === '1.3.0')).toMatchObject({ state: 'deprecate', deferred: true });
  });

  it('an empty plugin defers nothing', () => {
    expect(decide([])).toMatchObject({ deferredCount: 0, retireCount: 0 });
  });
});
