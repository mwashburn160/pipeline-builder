// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `PLUGIN_VULN_WAIVERS`: a scoped, expiring exemption from the vulnerability
 * floor.
 *
 * This is a control that makes the gate PASS, so every test here is about what
 * it must refuse to do. The dangerous failures are all silent — a waiver that
 * quietly covers more than it was meant to looks exactly like a clean image:
 *
 *   - a typo must not become a wildcard;
 *   - an entry with no package list must not mean "waive this plugin";
 *   - a waiver for one plugin must not touch another;
 *   - an expired entry must stop working on its own, with no action from anyone.
 *
 * The parser therefore DROPS anything it does not fully understand rather than
 * interpreting it loosely, and these tests pin that direction.
 */

import { describe, expect, it } from '@jest/globals';
import { SYSTEM_ORG_ID } from '../src/middleware/system-org.js';
import { applyVulnWaivers, parseVulnWaivers, parseVulnWaiversVerbose, type PluginScanFinding } from '../src/types/plugin-scan.js';

const crit = (pkg: string, fixed = ['9.9.9']): PluginScanFinding => ({
  id: `CVE-${pkg}`, severity: 'critical', packageName: pkg, packageVersion: '1.0.0', fixedIn: fixed,
});

const FUTURE = '2099-01-01';
const PAST = '2020-01-01';

describe('parseVulnWaivers', () => {
  it('reads a well-formed entry, and several at once', () => {
    const w = parseVulnWaivers(`artillery:${FUTURE}:chromium,chrome;playwright:${FUTURE}:firefox`);
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ plugin: 'artillery', packages: ['chromium', 'chrome'] });
    expect(w[1]).toMatchObject({ plugin: 'playwright', packages: ['firefox'] });
  });

  it('expires at the END of the named day, not its start', () => {
    // A date-only expiry that resolved to 00:00 would make the waiver dead on
    // the day an operator wrote it, which reads as "the waiver does not work".
    const [w] = parseVulnWaivers('artillery:2030-06-01:chromium');
    expect(w!.expires.toISOString()).toBe('2030-06-01T23:59:59.999Z');
  });

  it('drops an entry with no package list instead of waiving the whole plugin', () => {
    // The one thing this format must not be able to express.
    expect(parseVulnWaivers(`artillery:${FUTURE}`)).toEqual([]);
    expect(parseVulnWaivers(`artillery:${FUTURE}:`)).toEqual([]);
    expect(parseVulnWaivers(`artillery:${FUTURE}:,,`)).toEqual([]);
  });

  it('drops malformed entries rather than guessing', () => {
    expect(parseVulnWaivers('artillery')).toEqual([]);
    expect(parseVulnWaivers(`:${FUTURE}:chromium`)).toEqual([]);
    expect(parseVulnWaivers('artillery:soon:chromium')).toEqual([]);
    expect(parseVulnWaivers('artillery:2026-13-45:chromium')).toEqual([]);
    expect(parseVulnWaivers('')).toEqual([]);
    expect(parseVulnWaivers(undefined)).toEqual([]);
  });

  it('keeps the good entries when one in the list is malformed', () => {
    // A single typo must not disable the waivers either — that would push an
    // operator toward the blunt instrument (PLUGIN_VULN_MAX_CRITICAL).
    const w = parseVulnWaivers(`bad-entry;playwright:${FUTURE}:firefox`);
    expect(w.map((x) => x.plugin)).toEqual(['playwright']);
  });
});

describe('applyVulnWaivers', () => {
  const findings = [crit('chromium'), crit('openssl')];

  it('exempts only the named package, leaving the rest to the floor', () => {
    const r = applyVulnWaivers('artillery', findings, parseVulnWaivers(`artillery:${FUTURE}:chromium`), undefined, SYSTEM_ORG_ID);
    expect(r.waived.map((f) => f.packageName)).toEqual(['chromium']);
    expect(r.counted.map((f) => f.packageName)).toEqual(['openssl']);
  });

  it('does not leak across plugins', () => {
    const r = applyVulnWaivers('playwright', findings, parseVulnWaivers(`artillery:${FUTURE}:chromium`), undefined, SYSTEM_ORG_ID);
    expect(r.waived).toEqual([]);
    expect(r.counted).toHaveLength(2);
  });

  it('stops applying once expired, with nothing to revoke', () => {
    const r = applyVulnWaivers('artillery', findings, parseVulnWaivers(`artillery:${PAST}:chromium`), undefined, SYSTEM_ORG_ID);
    expect(r.waived).toEqual([]);
    expect(r.counted).toHaveLength(2);
  });

  it('applies on the expiry day itself and not the day after', () => {
    const w = parseVulnWaivers('artillery:2030-06-01:chromium');
    expect(applyVulnWaivers('artillery', findings, w, new Date('2030-06-01T12:00:00Z'), SYSTEM_ORG_ID).waived).toHaveLength(1);
    expect(applyVulnWaivers('artillery', findings, w, new Date('2030-06-02T00:00:00Z'), SYSTEM_ORG_ID).waived).toHaveLength(0);
  });

  it('ignores UNFIXABLE findings, which never counted toward the floor anyway', () => {
    // Waiving one would overstate what the waiver did, and make the counts
    // disagree with the scanner for no reason.
    const unfixable = [{ ...crit('chromium'), fixedIn: [] }];
    const r = applyVulnWaivers('artillery', unfixable, parseVulnWaivers(`artillery:${FUTURE}:chromium`), undefined, SYSTEM_ORG_ID);
    expect(r.waived).toEqual([]);
    expect(r.counted).toHaveLength(1);
  });

  it('matches package names case-insensitively', () => {
    const r = applyVulnWaivers('artillery', [crit('Chromium')], parseVulnWaivers(`artillery:${FUTURE}:chromium`), undefined, SYSTEM_ORG_ID);
    expect(r.waived).toHaveLength(1);
  });

  it('is a no-op with no waivers configured', () => {
    const r = applyVulnWaivers('artillery', findings, [], undefined, SYSTEM_ORG_ID);
    expect(r.waived).toEqual([]);
    expect(r.counted).toEqual(findings);
  });
});

/**
 * The tenancy bound, which is the one that stops this being a hole.
 *
 * Plugin names are unique per (name, version, orgId) — NOT globally. So a
 * waiver matched on the name alone would be inherited by every tenant who
 * happened to choose the same name: an org could call its plugin `artillery`
 * and have the operator's chromium exemption wave its own Criticals through.
 * Waivers are for the Official catalog the operator curates, which lives in the
 * system org, and nothing else.
 */
describe('applyVulnWaivers — tenancy', () => {
  const findings = [crit('chromium')];
  const waivers = parseVulnWaivers(`artillery:${FUTURE}:chromium`);

  it('applies in the system org', () => {
    expect(applyVulnWaivers('artillery', findings, waivers, undefined, SYSTEM_ORG_ID).waived).toHaveLength(1);
  });

  it('does NOT apply to another org that happens to use the same plugin name', () => {
    expect(applyVulnWaivers('artillery', findings, waivers, undefined, '000000000000000000000999').waived).toEqual([]);
  });

  it('does not apply when the caller cannot say which org it is', () => {
    // A caller that forgets to pass the org gets MORE enforcement, not less.
    expect(applyVulnWaivers('artillery', findings, waivers).waived).toEqual([]);
    expect(applyVulnWaivers('artillery', findings, waivers, undefined, '').waived).toEqual([]);
  });

  it('matches the system org id case-insensitively', () => {
    expect(applyVulnWaivers('artillery', findings, waivers, undefined, SYSTEM_ORG_ID.toUpperCase()).waived).toHaveLength(1);
  });
});

/**
 * Version pinning, and telling the operator what was thrown away.
 *
 * Dropping a malformed entry is the safe direction, but dropping it SILENTLY is
 * the likeliest way this feature fails in practice: a waiver is written, the
 * gate keeps blocking, and nothing anywhere says why. The verbose parse exists
 * so boot can report it.
 */
describe('parseVulnWaiversVerbose', () => {
  it('pins a version when one is given, and covers every version when not', () => {
    expect(parseVulnWaiversVerbose(`artillery@2.0.34:${FUTURE}:chromium`).waivers[0]).toMatchObject({ version: '2.0.34' });
    expect(parseVulnWaiversVerbose(`artillery:${FUTURE}:chromium`).waivers[0]).toMatchObject({ version: null });
  });

  it('reports WHY each dropped entry was dropped', () => {
    const { waivers, problems } = parseVulnWaiversVerbose(`artillery;playwright:soon:firefox;cypress:${FUTURE}:`);
    expect(waivers).toEqual([]);
    expect(problems.map((p) => p.entry)).toEqual(['artillery', 'playwright:soon:firefox', `cypress:${FUTURE}:`]);
    expect(problems[1]!.reason).toContain('YYYY-MM-DD');
  });

  it('rejects a trailing @ rather than reading it as "every version"', () => {
    // Ambiguous between a typo and an intent to cover everything. Refusing says
    // so; guessing would silently widen the waiver.
    const { waivers, problems } = parseVulnWaiversVerbose(`artillery@:${FUTURE}:chromium`);
    expect(waivers).toEqual([]);
    expect(problems[0]!.reason).toContain('omit it');
  });
});

describe('applyVulnWaivers — version pinning', () => {
  const findings = [crit('chromium')];
  const pinned = parseVulnWaivers(`artillery@2.0.34:${FUTURE}:chromium`);

  it('applies to the pinned version', () => {
    expect(applyVulnWaivers('artillery', findings, pinned, undefined, SYSTEM_ORG_ID, '2.0.34').waived).toHaveLength(1);
  });

  it('does NOT carry to another version', () => {
    expect(applyVulnWaivers('artillery', findings, pinned, undefined, SYSTEM_ORG_ID, '2.1.0').waived).toEqual([]);
    expect(applyVulnWaivers('artillery', findings, pinned, undefined, SYSTEM_ORG_ID).waived).toEqual([]);
  });

  it('an unpinned waiver still covers any version', () => {
    const any = parseVulnWaivers(`artillery:${FUTURE}:chromium`);
    expect(applyVulnWaivers('artillery', findings, any, undefined, SYSTEM_ORG_ID, '9.9.9').waived).toHaveLength(1);
  });
});
