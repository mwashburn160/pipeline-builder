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

import { afterEach, describe, expect, it } from '@jest/globals';
import { SYSTEM_ORG_ID } from '../src/middleware/system-org.js';
import {
  applyVulnWaivers, isGatedFinding, newScanFindings, parseVulnWaivers, parseVulnWaiversVerbose, pluginVulnGateKev, scanFindingKey,
  vulnFlaggedMessage, vulnWaiverLabels, type PluginScanFinding,
} from '../src/types/plugin-scan.js';

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
    // operator toward the blunt instrument (PLUGIN_VULN_MAX_FINDINGS).
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

/**
 * Fleet-wide (`*`) waivers, for one advisory every bundler of a toolchain
 * inherits — a Go stdlib CVE lands in every prebuilt Go binary at once.
 *
 * The danger is the wildcard reaching further than one advisory. `*` with a
 * package name (`stdlib`) would exempt every present and future stdlib Critical
 * in every plugin, so it must be refused, not narrowed.
 */
describe('fleet-wide waivers', () => {
  const stdlib = (id: string): PluginScanFinding => ({
    id, severity: 'critical', packageName: 'stdlib', packageVersion: 'go1.26.4', fixedIn: ['1.26.9'],
  });

  it('parses advisory ids under *', () => {
    const w = parseVulnWaivers(`*:${FUTURE}:GO-2026-6612,CVE-2026-12345,GHSA-abcd-efgh-ijkl`);
    expect(w).toEqual([expect.objectContaining({ plugin: '*', version: null, packages: ['GO-2026-6612', 'CVE-2026-12345', 'GHSA-abcd-efgh-ijkl'] })]);
  });

  it('REFUSES a package name under *, even mixed with advisory ids', () => {
    for (const raw of [`*:${FUTURE}:stdlib`, `*:${FUTURE}:GO-2026-6612,stdlib`, `*:${FUTURE}:GO-2026`]) {
      const { waivers, problems } = parseVulnWaiversVerbose(raw);
      expect(waivers).toEqual([]);
      expect(problems[0]!.reason).toContain('advisory ids only');
    }
  });

  it('refuses a version pin under *', () => {
    const { waivers, problems } = parseVulnWaiversVerbose(`*@1.0.0:${FUTURE}:GO-2026-6612`);
    expect(waivers).toEqual([]);
    expect(problems[0]!.reason).toContain('cannot pin a version');
  });

  it('exempts the named advisory in any plugin, and nothing else', () => {
    const w = parseVulnWaivers(`*:${FUTURE}:GO-2026-6612`);
    for (const plugin of ['typescript-check', 'k6', 'git-secrets']) {
      const r = applyVulnWaivers(plugin, [stdlib('GO-2026-6612'), stdlib('GO-2026-9999')], w, undefined, SYSTEM_ORG_ID, '1.0.0');
      expect(r.waived.map((f) => f.id)).toEqual(['GO-2026-6612']);
      expect(r.counted.map((f) => f.id)).toEqual(['GO-2026-9999']);
    }
  });

  it('matches advisory ids case-insensitively', () => {
    const w = parseVulnWaivers(`*:${FUTURE}:go-2026-6612`);
    expect(applyVulnWaivers('k6', [stdlib('GO-2026-6612')], w, undefined, SYSTEM_ORG_ID).waived).toHaveLength(1);
  });

  it('keeps the tenancy bound and the expiry', () => {
    expect(applyVulnWaivers('k6', [stdlib('GO-2026-6612')], parseVulnWaivers(`*:${FUTURE}:GO-2026-6612`), undefined, '000000000000000000000999').waived).toEqual([]);
    expect(applyVulnWaivers('k6', [stdlib('GO-2026-6612')], parseVulnWaivers(`*:${PAST}:GO-2026-6612`), undefined, SYSTEM_ORG_ID).waived).toEqual([]);
  });

  it('a per-plugin entry may also name an advisory id', () => {
    const w = parseVulnWaivers(`k6:${FUTURE}:GO-2026-6612`);
    expect(applyVulnWaivers('k6', [stdlib('GO-2026-6612')], w, undefined, SYSTEM_ORG_ID).waived).toHaveLength(1);
    expect(applyVulnWaivers('kics', [stdlib('GO-2026-6612')], w, undefined, SYSTEM_ORG_ID).waived).toEqual([]);
  });
});

/**
 * CISA KEV. A known-exploited Critical is GATED even with no fix
 * (`PLUGIN_VULN_GATE_KEV`, default on) — and a package-name waiver must not
 * cover it: `artillery:…:chromium` was written about Chromium's ordinary churn,
 * not about the one Chromium CVE being exploited today.
 */
describe('KEV-listed findings', () => {
  const kev = (pkg: string, id = 'CVE-2026-1111', fixedIn: string[] = []): PluginScanFinding => ({ ...crit(pkg, fixedIn), id, kev: true });
  afterEach(() => { delete process.env.PLUGIN_VULN_GATE_KEV; });

  it('an unfixable KEV Critical is gated (and a High never is); off, KEV is gated like any other Critical', () => {
    expect(isGatedFinding(kev('chromium'))).toBe(true);
    expect(isGatedFinding({ ...kev('chromium'), severity: 'high' })).toBe(false);
    expect(isGatedFinding(crit('chromium', []))).toBe(false);
    process.env.PLUGIN_VULN_GATE_KEV = 'false';
    expect(pluginVulnGateKev()).toBe(false);
    expect(isGatedFinding(kev('chromium'))).toBe(false);
    expect(isGatedFinding(kev('chromium', 'CVE-2026-1111', ['1.1']))).toBe(true);
  });

  it('is NEVER exempted by a package-name waiver, fixable or not', () => {
    const w = parseVulnWaivers(`artillery:${FUTURE}:chromium`);
    for (const f of [kev('chromium'), kev('chromium', 'CVE-2026-1111', ['9.9.9'])]) {
      const r = applyVulnWaivers('artillery', [f], w, undefined, SYSTEM_ORG_ID);
      expect(r.waived).toEqual([]);
      expect(r.matched).toEqual([]);
    }
  });

  it('IS exempted by naming its advisory id — per plugin or fleet-wide — even with no fix', () => {
    for (const raw of [`artillery:${FUTURE}:CVE-2026-1111`, `*:${FUTURE}:CVE-2026-1111`]) {
      const r = applyVulnWaivers('artillery', [kev('chromium')], parseVulnWaivers(raw), undefined, SYSTEM_ORG_ID);
      expect(r.waived).toHaveLength(1);
    }
  });

  it('with the KEV gate off an unfixable KEV finding is not gated, so nothing "waives" it', () => {
    process.env.PLUGIN_VULN_GATE_KEV = 'false';
    const r = applyVulnWaivers('artillery', [kev('chromium')], parseVulnWaivers(`artillery:${FUTURE}:CVE-2026-1111`), undefined, SYSTEM_ORG_ID);
    expect(r.waived).toEqual([]);
  });
});

describe('applyVulnWaivers — which entries matched', () => {
  it('reports each entry that exempted something, once, and not the ones that did not', () => {
    const w = parseVulnWaivers(`artillery:${FUTURE}:chromium;artillery:${FUTURE}:firefox;*:${FUTURE}:CVE-2026-0001`);
    const r = applyVulnWaivers('artillery', [crit('chromium'), { ...crit('chromium'), packageVersion: '2.0' }], w, undefined, SYSTEM_ORG_ID);
    expect(r.matched.map((m) => vulnWaiverLabels(m))).toEqual([{ plugin: 'artillery', targets: 'chromium' }]);
  });

  it('labels an entry by plugin (with its pin) and its targets', () => {
    const [pinned, fleet] = parseVulnWaivers(`docker-lint@1.0.0:${FUTURE}:github.com/docker/docker,stdlib;*:${FUTURE}:GO-2026-6612,GO-2026-6604`);
    expect(vulnWaiverLabels(pinned!)).toEqual({ plugin: 'docker-lint@1.0.0', targets: 'github.com/docker/docker,stdlib' });
    expect(vulnWaiverLabels(fleet!)).toEqual({ plugin: '*', targets: 'GO-2026-6612,GO-2026-6604' });
  });
});

/** The rescan's baseline: "new" is a finding IDENTITY the previous summary did not carry. */
describe('newScanFindings', () => {
  const f = (id: string, severity: 'critical' | 'high' = 'critical', pkg = 'openssl'): PluginScanFinding =>
    ({ id, severity, packageName: pkg, packageVersion: '1.0', fixedIn: [] });

  it('no baseline: everything is new', () => {
    expect(newScanFindings(null, [f('CVE-1')])).toEqual([f('CVE-1')]);
    expect(newScanFindings(undefined, [])).toEqual([]);
  });

  it('diffs by (advisory, package, version) — a flat count still surfaces a swapped CVE', () => {
    const before = { findings: [f('CVE-OLD'), f('CVE-1', 'critical', 'zlib')], truncated: false, critical: 2 };
    expect(newScanFindings(before, [f('CVE-NEW'), f('CVE-1', 'critical', 'zlib')])).toEqual([f('CVE-NEW')]);
    // Same CVE, different package: a different finding.
    expect(newScanFindings(before, [f('CVE-1', 'critical', 'openssl')])).toEqual([f('CVE-1', 'critical', 'openssl')]);
    expect(scanFindingKey(f('CVE-1'))).toBe('CVE-1|openssl|1.0');
  });

  it('a TRUNCATED baseline only vouches for what it provably listed in full', () => {
    // Every Critical listed (criticals sort first), the Highs cut.
    const before = { findings: [f('CVE-C1')], truncated: true, critical: 1 };
    expect(newScanFindings(before, [f('CVE-C2'), f('CVE-H9', 'high')])).toEqual([f('CVE-C2')]);
    // Not even every Critical fit: nothing missing from it can be called new.
    expect(newScanFindings({ findings: [f('CVE-C1')], truncated: true, critical: 900 }, [f('CVE-C2')])).toEqual([]);
  });
});

describe('vulnFlaggedMessage with known-exploited findings', () => {
  it('keeps the plain wording without KEV, and says "fixable or known exploited" with it', () => {
    expect(vulnFlaggedMessage('trivy@1.0.0', { gated: 2 })).toBe('trivy@1.0.0 has 2 fixable Critical findings — rebuild or upgrade');
    expect(vulnFlaggedMessage('trivy@1.0.0', { gated: 2, kev: 1 }))
      .toBe('trivy@1.0.0 has 2 Critical findings that are fixable or known exploited (1 on CISA KEV) — rebuild or upgrade');
  });
});
