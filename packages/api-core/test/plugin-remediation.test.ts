// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, jest } from '@jest/globals';
import { PIPELINE_INTERNAL } from '../src/contracts/pipeline.js';
import { PLUGIN_INTERNAL } from '../src/contracts/plugin.js';
import { ErrorCode, getStatusForErrorCode } from '../src/types/error-codes.js';
import {
  chooseFixVersion,
  compareRemediationPriority,
  comparePackageVersions,
  effectiveLibraryUpgradeLevel,
  GRYPE_PACKAGE_TYPE_CATALOG,
  GRYPE_PACKAGE_TYPES,
  isPipelineRemediationElection,
  isPluginRemediationMode,
  isPluginRemediationStage,
  isRemediationTarget,
  isTeamRemediationRollout,
  LIVE_REMEDIATION_STAGES,
  ACTIVE_BUILD_REMEDIATION_STAGES,
  PLUGIN_REMEDIATION_STAGE_LABELS,
  PLUGIN_REMEDIATION_STAGES,
  pluginRemediationJobId,
  remediationExportKey,
  remediationPatchedSourceKey,
  libraryUpgradeAllowed,
  libraryUpgradeRequirement,
  listingSourceKey,
  nextRemediationVersion,
  normalizePluginRemediationSettings,
  parseRemediationEnabled,
  parseRemediationSeverities,
  pipelineElectionAllowed,
  pluginSourceKey,
  pluginSourceOrgPrefix,
  pluginSourceVersionPrefix,
  remediationDiffKey,
  remediationFindingsKey,
  remediationPublishMode,
  remediationQueuePriority,
  remediationVersionBump,
  resolveRemediationRollout,
  strictestUpgradeLevel,
  toGrypePackageType,
  type GrypePackageType,
} from '../src/types/plugin-remediation.js';
import type { PluginScanFinding } from '../src/types/plugin-scan.js';
import { REMOTE_AUDIT_ACTIONS } from '../src/types/remote-audit-actions.js';
import { SYSTEM_PLUGIN_REMEDIATION } from '../src/utils/identity.js';
import { remediationFindingsHash } from '../src/utils/plugin-remediation-hash.js';
import { PipelineUpdateSchema } from '../src/validation/pipeline-schemas.js';
import { PluginRemediationSettingsWriteSchema } from '../src/validation/plugin-remediation-schemas.js';

const f = (over: Partial<PluginScanFinding> = {}): PluginScanFinding => ({
  id: 'CVE-1',
  severity: 'critical',
  packageName: 'openssl',
  packageVersion: '3.0.1',
  fixedIn: ['3.0.2'],
  packageType: 'deb',
  purl: 'pkg:deb/debian/openssl@3.0.1',
  locations: [{ path: '/usr/lib/libssl.so', layerID: 'sha256:aa' }],
  ...over,
});

describe('package type catalog', () => {
  it('covers every type, and the plan\'s not-possible overlays are not possible', () => {
    expect(Object.keys(GRYPE_PACKAGE_TYPE_CATALOG).sort()).toEqual([...GRYPE_PACKAGE_TYPES].sort());
    for (const t of ['go-module', 'java-archive', 'rust-crate', 'dotnet', 'binary', 'other'] as GrypePackageType[]) {
      expect([t, GRYPE_PACKAGE_TYPE_CATALOG[t].overlay]).toEqual([t, false]);
    }
    for (const t of ['deb', 'apk', 'rpm', 'npm', 'python', 'gem'] as GrypePackageType[]) {
      expect([t, GRYPE_PACKAGE_TYPE_CATALOG[t].overlay]).toEqual([t, true]);
    }
    expect(GRYPE_PACKAGE_TYPE_CATALOG.binary.sourcePatch).toBe('pinned-arg');
    expect(GRYPE_PACKAGE_TYPE_CATALOG.other.sourcePatch).toBe('no');
    expect(GRYPE_PACKAGE_TYPES.filter((t) => GRYPE_PACKAGE_TYPE_CATALOG[t].firstWave).sort()).toEqual(['apk', 'deb', 'npm', 'python']);
  });

  it('normalizes grype types, mapping anything uncatalogued to other', () => {
    expect(toGrypePackageType('Go-Module')).toBe('go-module');
    expect(toGrypePackageType('php-composer')).toBe('other');
    expect(toGrypePackageType(undefined)).toBe('other');
  });
});

describe('comparePackageVersions', () => {
  it('orders deb versions by epoch, upstream, then revision, with ~ lowest', () => {
    expect(comparePackageVersions('1.1.1n-0+deb11u5', '1.1.1n-0+deb11u6', 'deb')).toBeLessThan(0);
    expect(comparePackageVersions('1:1.0', '2.0', 'deb')).toBeGreaterThan(0);
    expect(comparePackageVersions('1.0~rc1', '1.0', 'deb')).toBeLessThan(0);
    expect(comparePackageVersions('1.10', '1.9', 'deb')).toBeGreaterThan(0);
  });
  it('orders apk -rN revisions and semver prereleases', () => {
    expect(comparePackageVersions('3.1.4-r5', '3.1.4-r10', 'apk')).toBeLessThan(0);
    expect(comparePackageVersions('2.0.0-rc.1', '2.0.0', 'npm')).toBeLessThan(0);
    expect(comparePackageVersions('v1.2.10', 'v1.2.9', 'go-module')).toBeGreaterThan(0);
    expect(comparePackageVersions('2024.10.1', '2024.9.30', 'python')).toBeGreaterThan(0);
  });
});

describe('libraryUpgradeRequirement / libraryUpgradeAllowed', () => {
  it('maps the plan\'s example (installed 2.3.1) to each level', () => {
    expect(libraryUpgradeRequirement('2.3.1', '2.3.4', 'npm')).toBe('patch');
    expect(libraryUpgradeRequirement('2.3.1', '2.4.0', 'npm')).toBe('minor');
    expect(libraryUpgradeRequirement('2.3.1', '3.0.0', 'npm')).toBe('major');
    expect(libraryUpgradeAllowed('2.3.1', '2.3.4', 'patch', 'npm')).toBe(true);
    expect(libraryUpgradeAllowed('2.3.1', '2.4.0', 'patch', 'npm')).toBe(false);
    expect(libraryUpgradeAllowed('2.3.1', '2.4.0', 'minor', 'npm')).toBe(true);
    expect(libraryUpgradeAllowed('2.3.1', '3.0.0', 'minor', 'npm')).toBe(false);
    expect(libraryUpgradeAllowed('2.3.1', '3.0.0', 'major', 'npm')).toBe(true);
  });
  it('counts a deb revision as patch and an epoch change as major', () => {
    expect(libraryUpgradeRequirement('1.1.1n-0+deb11u5', '1.1.1n-0+deb11u6', 'deb')).toBe('patch');
    expect(libraryUpgradeRequirement('1.2.3-1', '1:1.2.3-1', 'deb')).toBe('major');
    expect(libraryUpgradeRequirement('3.0.11-1~deb12u2', '3.1.0-1', 'deb')).toBe('minor');
    expect(libraryUpgradeRequirement('3.1.4-r5', '3.1.4-r6', 'apk')).toBe('patch');
    expect(libraryUpgradeRequirement('1.0-1.el9', '1.0-2.el9', 'rpm')).toBe('patch');
  });
  it('counts a 0.x minor bump as major, and a 0.x patch as patch', () => {
    expect(libraryUpgradeRequirement('0.3.1', '0.4.0', 'npm')).toBe('major');
    expect(libraryUpgradeRequirement('0.3.1', '0.3.2', 'npm')).toBe('patch');
    expect(libraryUpgradeAllowed('0.3.1', '0.4.0', 'minor', 'npm')).toBe(false);
  });
  it('sends a Go /vN major to the owner at every level', () => {
    expect(libraryUpgradeRequirement('v1.9.0', 'v2.0.0', 'go-module')).toBe('owner');
    expect(libraryUpgradeAllowed('v1.9.0', 'v2.0.0', 'major', 'go-module')).toBe(false);
    expect(libraryUpgradeRequirement('v1.9.0', 'v1.9.3', 'go-module')).toBe('patch');
  });
  it('reads non-semver versions from their first three numeric parts; unparseable is major', () => {
    expect(libraryUpgradeRequirement('1.2.3.4', '1.2.3.9', 'java-archive')).toBe('patch');
    expect(libraryUpgradeRequirement('1.2.3.Final', '1.2.5.Final', 'java-archive')).toBe('patch');
    expect(libraryUpgradeRequirement('2024.1.15', '2024.2.1', 'python')).toBe('minor');
    expect(libraryUpgradeRequirement('abc', 'abd', 'binary')).toBe('major');
  });
  it('treats a candidate that is not above installed as no move', () => {
    expect(libraryUpgradeRequirement('2.3.1', '2.3.1', 'npm')).toBe('patch');
  });
});

describe('upgrade level overrides', () => {
  it('takes the strictest applicable level', () => {
    expect(strictestUpgradeLevel(['major', 'minor', undefined])).toBe('minor');
    expect(strictestUpgradeLevel([null, undefined], 'major')).toBe('major');
    const settings = { libraryUpgradeLevel: 'minor' as const, libraryUpgradeLevelByType: { npm: 'patch' as const }, libraryUpgradeLevelByPlugin: { fragile: 'patch' as const } };
    expect(effectiveLibraryUpgradeLevel(settings, 'npm', 'other-plugin')).toBe('patch');
    expect(effectiveLibraryUpgradeLevel(settings, 'deb', 'fragile')).toBe('patch');
    expect(effectiveLibraryUpgradeLevel(settings, 'deb', 'other-plugin')).toBe('minor');
    expect(effectiveLibraryUpgradeLevel({ ...settings, libraryUpgradeLevel: 'major', libraryUpgradeLevelByType: {}, libraryUpgradeLevelByPlugin: {} }, 'deb', 'x')).toBe('major');
  });
});

describe('chooseFixVersion', () => {
  it('takes the highest of the lowest fixed versions per purl', () => {
    const out = chooseFixVersion([
      f({ id: 'CVE-A', fixedIn: ['3.0.4', '3.0.2'] }),
      f({ id: 'CVE-B', fixedIn: ['3.0.3', '3.1.0'] }),
      f({ id: 'CVE-C', fixedIn: [] }),
      f({ id: 'CVE-D', packageName: 'zlib', purl: 'pkg:deb/debian/zlib@1.2', packageVersion: '1.2', fixedIn: ['1.3'], kev: true, locations: [] }),
    ]);
    expect(out).toEqual([
      expect.objectContaining({ purl: 'pkg:deb/debian/openssl@3.0.1', fixVersion: '3.0.3', findingIds: ['CVE-A', 'CVE-B'], noFixIds: ['CVE-C'], kev: false, installedVersion: '3.0.1' }),
      expect.objectContaining({ purl: 'pkg:deb/debian/zlib@1.2', fixVersion: '1.3', findingIds: ['CVE-D'], kev: true }),
    ]);
    expect(out[0]!.locations).toEqual([{ path: '/usr/lib/libssl.so', layerID: 'sha256:aa' }]);
  });
  it('compares by package type (deb revisions)', () => {
    const out = chooseFixVersion([
      f({ id: 'A', fixedIn: ['1.1.1n-0+deb11u6'] }),
      f({ id: 'B', fixedIn: ['1.1.1n-0+deb11u10'] }),
    ]);
    expect(out[0]!.fixVersion).toBe('1.1.1n-0+deb11u10');
  });
  it('ignores fixed versions at or below the installed one (multi-branch advisories)', () => {
    const npm = { packageType: 'npm' as const, packageName: 'lib', purl: 'pkg:npm/lib@2.0.0', packageVersion: '2.0.0' };
    const out = chooseFixVersion([f({ ...npm, id: 'GHSA-1', fixedIn: ['1.2.0', '2.1.0'] })]);
    expect(out[0]!.fixVersion).toBe('2.1.0');
    // Only older-branch fixes listed: kept as reported (the caller's verification decides).
    expect(chooseFixVersion([f({ ...npm, id: 'GHSA-2', fixedIn: ['1.2.0'] })])[0]!.fixVersion).toBe('1.2.0');
  });
  it('answers null when no finding of a package has a fix', () => {
    expect(chooseFixVersion([f({ fixedIn: [] })])[0]!.fixVersion).toBeNull();
  });
});

describe('findings hash', () => {
  it('is order- and duplicate-insensitive, and changes when a fix version appears', () => {
    const a = f({ id: 'CVE-A' });
    const b = f({ id: 'CVE-B', fixedIn: [] });
    expect(remediationFindingsHash([a, b])).toBe(remediationFindingsHash([b, a, a]));
    expect(remediationFindingsHash([a, b])).toMatch(/^[0-9a-f]{64}$/);
    expect(remediationFindingsHash([a, b])).not.toBe(remediationFindingsHash([a, { ...b, fixedIn: ['9.9.9'] }]));
    expect(remediationFindingsKey([a])).toBe('CVE-A|pkg:deb/debian/openssl@3.0.1|3.0.1|3.0.2');
  });
});

describe('plugin version numbering', () => {
  it('skips a taken patch number and bumps the minor for a major library upgrade', () => {
    expect(nextRemediationVersion('1.4.2', [], 'patch')).toBe('1.4.3');
    expect(nextRemediationVersion('1.4.2', ['1.4.3'], 'patch')).toBe('1.4.4');
    expect(nextRemediationVersion('1.4.2', ['1.5.0'], 'minor')).toBe('1.6.0');
    expect(nextRemediationVersion('1.4.2-beta.1', [], 'patch')).toBe('1.4.3');
    expect(nextRemediationVersion('not-semver', [], 'patch')).toBeNull();
    expect(remediationVersionBump([{ requirement: 'minor' }, { requirement: 'patch' }])).toBe('patch');
    expect(remediationVersionBump([{ requirement: 'major' }])).toBe('minor');
  });
});

describe('remediationPublishMode', () => {
  const ok = { majorUpgrade: false, hasSmokeTest: true, askAgentPatch: false };
  it('publishes automatically only under apply with nothing holding it', () => {
    expect(remediationPublishMode('apply', ok)).toEqual({ mode: 'apply', proposeReasons: [] });
    expect(remediationPublishMode('propose', ok)).toEqual({ mode: 'propose', proposeReasons: ['org_mode'] });
    expect(remediationPublishMode('off', ok)).toEqual({ mode: 'off', proposeReasons: [] });
  });
  it('holds major upgrades, plugins without smokeTest and ask-agent patches for approval', () => {
    expect(remediationPublishMode('apply', { ...ok, majorUpgrade: true }).proposeReasons).toEqual(['major_upgrade']);
    expect(remediationPublishMode('apply', { ...ok, hasSmokeTest: false }).proposeReasons).toEqual(['no_smoke_test']);
    expect(remediationPublishMode('apply', { ...ok, askAgentPatch: true })).toEqual({ mode: 'propose', proposeReasons: ['ask_agent_patch'] });
  });
});

describe('resolveRemediationRollout', () => {
  it('an opted-out pipeline is never moved, whatever the org says', () => {
    expect(resolveRemediationRollout({ pipeline: 'off', root: 'apply', allowPipelineApply: true }).mode).toBe('off');
  });
  it('inherit follows the team, then the root', () => {
    expect(resolveRemediationRollout({ pipeline: 'inherit', team: 'inherit', root: 'apply', allowPipelineApply: true })).toMatchObject({ mode: 'apply', source: 'root' });
    expect(resolveRemediationRollout({ pipeline: 'inherit', team: 'off', root: 'apply', allowPipelineApply: true })).toMatchObject({ mode: 'off', source: 'team' });
    expect(resolveRemediationRollout({ pipeline: 'inherit', root: 'propose', allowPipelineApply: true })).toMatchObject({ mode: 'propose', source: 'root' });
  });
  it('honours a pipeline apply under an org propose only when allowPipelineApply', () => {
    expect(resolveRemediationRollout({ pipeline: 'apply', root: 'propose', allowPipelineApply: true })).toMatchObject({ mode: 'apply', applyRefused: false });
    expect(resolveRemediationRollout({ pipeline: 'apply', root: 'propose', allowPipelineApply: false })).toMatchObject({ mode: 'propose', applyRefused: true });
    expect(resolveRemediationRollout({ pipeline: 'apply', root: 'apply', allowPipelineApply: false })).toMatchObject({ mode: 'apply', applyRefused: false });
    expect(resolveRemediationRollout({ pipeline: 'apply', team: 'apply', root: 'off', allowPipelineApply: false }).mode).toBe('apply');
  });
  it('pipelineElectionAllowed refuses only apply when disallowed', () => {
    expect(pipelineElectionAllowed('apply', 'propose', false)).toBe(false);
    expect(pipelineElectionAllowed('off', 'propose', false)).toBe(true);
    expect(pipelineElectionAllowed('inherit', 'off', false)).toBe(true);
    expect(pipelineElectionAllowed('apply', 'apply', false)).toBe(true);
  });
});

describe('normalizePluginRemediationSettings', () => {
  it('defaults: propose / minor / propose rollout / allowPipelineApply for a root; inherit rollout for a team', () => {
    expect(normalizePluginRemediationSettings(null, { isTeam: false })).toEqual({
      mode: 'propose', libraryUpgradeLevel: 'minor', libraryUpgradeLevelByType: {}, libraryUpgradeLevelByPlugin: {}, rollout: 'propose', allowPipelineApply: true,
    });
    expect(normalizePluginRemediationSettings(null, { isTeam: true }).rollout).toBe('inherit');
  });
  it('drops unknown stored values and reads a root inherit as propose', () => {
    const s = normalizePluginRemediationSettings({
      mode: 'bogus',
      libraryUpgradeLevel: 'major',
      libraryUpgradeLevelByType: { npm: 'patch', nope: 'patch', deb: 'x' },
      libraryUpgradeLevelByPlugin: { tf: 'patch' },
      rollout: 'inherit',
      allowPipelineApply: false,
    }, { isTeam: false });
    expect(s).toEqual({ mode: 'propose', libraryUpgradeLevel: 'major', libraryUpgradeLevelByType: { npm: 'patch' }, libraryUpgradeLevelByPlugin: { tf: 'patch' }, rollout: 'propose', allowPipelineApply: false });
  });
  it('the write schema accepts the fields and refuses unknown ones', () => {
    expect(PluginRemediationSettingsWriteSchema.safeParse({ mode: 'apply', libraryUpgradeLevelByType: { npm: 'patch', deb: null } }).success).toBe(true);
    expect(PluginRemediationSettingsWriteSchema.safeParse({ mode: 'sometimes' }).success).toBe(false);
    expect(PluginRemediationSettingsWriteSchema.safeParse({ libraryUpgradeLevelByPlugin: {} }).success).toBe(false);
  });
  it('the pipeline update schema carries the election', () => {
    expect(PipelineUpdateSchema.parse({ remediationUpgrades: 'off' })).toEqual({ remediationUpgrades: 'off' });
    expect(PipelineUpdateSchema.safeParse({ remediationUpgrades: 'always' }).success).toBe(false);
  });
});

describe('severities and the on/off knob', () => {
  it('parses PLUGIN_REMEDIATION_SEVERITIES case-insensitively, in catalog order', () => {
    const warn = jest.fn();
    expect(parseRemediationSeverities(undefined, warn)).toEqual(['critical', 'high']);
    expect(parseRemediationSeverities('  ', warn)).toEqual(['critical', 'high']);
    expect(parseRemediationSeverities('HIGH, critical,high', warn)).toEqual(['critical', 'high']);
    expect(parseRemediationSeverities('critical', warn)).toEqual(['critical']);
    expect(warn).not.toHaveBeenCalled();
  });
  it('falls back to the default with one warning on an invalid or empty list', () => {
    const warn = jest.fn();
    expect(parseRemediationSeverities('critical,medium', warn)).toEqual(['critical', 'high']);
    expect(parseRemediationSeverities(',', warn)).toEqual(['critical', 'high']);
    expect(warn).toHaveBeenCalledTimes(2);
  });
  it('PLUGIN_REMEDIATION_ENABLED is on unless exactly false', () => {
    expect(parseRemediationEnabled(undefined)).toBe(true);
    expect(parseRemediationEnabled('0')).toBe(true);
    expect(parseRemediationEnabled(' FALSE ')).toBe(false);
  });
  it('targets fixable findings of the chosen severities, and KEV always', () => {
    expect(isRemediationTarget({ severity: 'high', fixedIn: ['1'] }, ['critical'])).toBe(false);
    expect(isRemediationTarget({ severity: 'high', fixedIn: ['1'] }, ['critical', 'high'])).toBe(true);
    expect(isRemediationTarget({ severity: 'critical', fixedIn: [] }, ['critical'])).toBe(false);
    expect(isRemediationTarget({ severity: 'high', fixedIn: [], kev: true }, ['critical'])).toBe(true);
  });
});

describe('priority', () => {
  it('runs KEV first, then EPSS, then pipeline count, always after unprioritised builds', () => {
    const kev = { kev: true, maxEpss: 0.1, pipelineCount: 1 };
    const hot = { kev: false, maxEpss: 0.9, pipelineCount: 1 };
    const busy = { kev: false, maxEpss: 0.9, pipelineCount: 50 };
    const sorted = [hot, busy, kev].sort(compareRemediationPriority);
    expect(sorted).toEqual([kev, busy, hot]);
    const prio = sorted.map(remediationQueuePriority);
    expect(prio).toEqual([...prio].sort((a, b) => a - b));
    expect(Math.min(...prio)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...prio)).toBeLessThanOrEqual(2_097_152);
  });
});

describe('stages and guards', () => {
  it('labels every stage; active-build stages are live; guards accept only catalog values', () => {
    expect(Object.keys(PLUGIN_REMEDIATION_STAGE_LABELS)).toEqual([...PLUGIN_REMEDIATION_STAGES]);
    for (const s of ACTIVE_BUILD_REMEDIATION_STAGES) expect((LIVE_REMEDIATION_STAGES as readonly string[]).includes(s)).toBe(true);
    expect(isPluginRemediationStage('needs_owner')).toBe(true);
    expect(isPluginRemediationStage('rejected')).toBe(false);
    expect(isPluginRemediationMode('apply')).toBe(true);
    expect(isTeamRemediationRollout('inherit')).toBe(true);
    expect(isPipelineRemediationElection('sometimes')).toBe(false);
    expect(pluginRemediationJobId('r1')).toBe('remediation-r1');
  });
});

describe('storage keys', () => {
  it('lays out plugin-sources per org / plugin / version', () => {
    expect(pluginSourceKey('ABC', 'P1', '1.4.3', 'FF')).toBe('abc/p1/1.4.3/ff.zip');
    expect(pluginSourceVersionPrefix('abc', 'p1', '1.4.3')).toBe('abc/p1/1.4.3/');
    expect(pluginSourceOrgPrefix('ABC')).toBe('abc/');
    expect(remediationDiffKey('abc', 'p1', '1.4.3', 'R1')).toBe('abc/p1/1.4.3/remediations/r1/remediation.diff');
    expect(remediationDiffKey('abc', 'p1', '1.4.3', 'r1').startsWith(pluginSourceVersionPrefix('abc', 'p1', '1.4.3'))).toBe(true);
    expect(listingSourceKey('L1', '2.0.0', 'aa')).toBe('listings/l1/2.0.0/aa.zip');
    expect(remediationPatchedSourceKey('abc', 'p1', '1.4.3', 'r1', 'BB')).toBe('abc/p1/1.4.3/remediations/r1/patched-bb.zip');
    expect(remediationExportKey('abc', 'p1', '1.4.3', 'r1')).toBe('abc/p1/1.4.3/remediations/r1/export.diff');
  });
});

describe('catalog entries other services rely on', () => {
  it('declares the audit actions, the system principal and the error codes', () => {
    for (const a of ['plugin.remediation.started', 'plugin.remediation.published', 'plugin.remediation.rolled_back', 'plugin.remediation.needs_owner',
      'plugin.remediation.approved', 'plugin.remediation.rejected', 'plugin.remediation.retried', 'plugin.delete-all', 'plugin.restore-all',
      'plugin.purge-all', 'pipeline.remediation-upgrades.update']) {
      expect((REMOTE_AUDIT_ACTIONS as readonly string[]).includes(a)).toBe(true);
    }
    expect(SYSTEM_PLUGIN_REMEDIATION).toBe('system:plugin-remediation');
    expect(getStatusForErrorCode(ErrorCode.REMEDIATION_STAGE_CONFLICT)).toBe(409);
    expect(getStatusForErrorCode(ErrorCode.PIPELINE_REMEDIATION_APPLY_NOT_ALLOWED)).toBe(403);
    expect(getStatusForErrorCode(ErrorCode.PLUGIN_NAME_LOCKED)).toBe(409);
  });

  it('the rollout contracts are plugin → pipeline and pipeline → plugin, and parse a sample', () => {
    expect(PIPELINE_INTERNAL.startRemediationRollout.callers).toEqual(['plugin']);
    expect(PIPELINE_INTERNAL.cancelRemediationRollout.callers).toEqual(['plugin']);
    expect(PLUGIN_INTERNAL.reportRemediationRollout.callers).toEqual(['pipeline']);
    const body = PIPELINE_INTERNAL.startRemediationRollout.body!.parse({
      orgId: 'AAAAAAAAAAAAAAAAAAAAAAAA',
      plugin: 'terraform-plan',
      publisher: null,
      fromVersion: '1.4.2',
      toVersion: '1.4.3',
      toPluginId: '00000000-0000-4000-8000-000000000001',
      advisoryIds: ['CVE-1'],
      criticalCleared: 1,
      highCleared: 0,
      kev: false,
    });
    expect(body.orgId).toBe('aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(PIPELINE_INTERNAL.startRemediationRollout.body!.safeParse({ ...body, extra: 1 }).success).toBe(false);
  });
});
