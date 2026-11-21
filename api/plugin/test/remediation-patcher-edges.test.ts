// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The edges of the remediation patchers and the remediation wire shape, pure:
 * the npm source patch over awkward manifests (unparseable, already
 * overridden, no lockfile, a shrinkwrap, tab-indented, under node_modules),
 * the overlay command per package type and per location shape, and the DTO
 * for a fresh row versus a finished one (never a storage key or the findings
 * hash).
 */

import { describe, expect, it } from '@jest/globals';
import type { GrypePackageType } from '@pipeline-builder/api-core';

import { toRemediationDto } from '../src/services/remediation/dto.js';
import { overlayCommand, SOURCE_PATCHERS, type FixTarget } from '../src/services/remediation/patchers/index.js';

const target = (over: Partial<FixTarget> & { packageType?: GrypePackageType } = {}): FixTarget => ({
  purl: 'pkg:npm/lodash@4.17.20',
  packageName: 'lodash',
  packageType: 'npm',
  installedVersion: '4.17.20',
  fixVersion: '4.17.21',
  findingIds: ['CVE-1'],
  noFixIds: [],
  kev: false,
  locations: [],
  ...over,
});
const npm = (files: Record<string, string>, t: FixTarget = target()) =>
  SOURCE_PATCHERS.npm!(new Map(Object.entries(files)), t, { dockerfile: 'Dockerfile' });

describe('npm source patch edges', () => {
  it('refuses a package name or version that is not safe to write', () => {
    expect(npm({ 'package.json': '{}' }, target({ packageName: 'lodash;rm -rf /' }))).toBeNull();
    expect(npm({ 'package.json': '{}' }, target({ fixVersion: '../../etc' }))).toBeNull();
  });

  it('patches the root manifest when no lockfile sits beside any, and regenerates nothing', () => {
    const patch = npm({ 'package.json': '{\n\t"name": "x"\n}\n', 'sub/package.json': '{"name":"y"}' })!;
    expect([...patch.files.keys()]).toEqual(['package.json']);
    // Tab indentation and the trailing newline are kept.
    expect(patch.files.get('package.json')).toBe('{\n\t"name": "x",\n\t"overrides": {\n\t\t"lodash": "4.17.21"\n\t}\n}\n');
    expect(patch.regenerate).toEqual([]);
    expect(patch.lockfiles).toEqual([]);
  });

  it('keeps other overrides, skips an already-pinned or unparseable manifest, and regenerates a shrinkwrap', () => {
    const patch = npm({
      'a/package.json': '{"overrides":{"minimist":"1.2.8"}}',
      'a/npm-shrinkwrap.json': '{}',
      'b/package.json': '{"overrides":{"lodash":"4.17.21"}}',
      'b/package-lock.json': '{}',
      'c/package.json': '{not json',
      'c/package-lock.json': '{}',
      'd/package.json': '[1,2]',
      'd/package-lock.json': '{}',
      'node_modules/x/package.json': '{}',
      'node_modules/x/package-lock.json': '{}',
    })!;
    expect([...patch.files.keys()]).toEqual(['a/package.json']);
    expect(JSON.parse(patch.files.get('a/package.json')!)).toEqual({ overrides: { minimist: '1.2.8', lodash: '4.17.21' } });
    expect(patch.regenerate).toEqual([expect.objectContaining({ ecosystem: 'npm', dir: 'a', outputs: ['npm-shrinkwrap.json'] })]);
    expect(patch.lockfiles).toEqual(['a/npm-shrinkwrap.json']);
  });

  it('a DIRECT dependency gets the fixed version as its spec too (npm refuses an override that differs from it: EOVERRIDE)', () => {
    const patch = npm({
      'package.json': '{"dependencies":{"lodash":"4.17.20","left-pad":"1.3.0"},"devDependencies":{"lodash":"^4.17.0"},"optionalDependencies":{"lodash":"~4.17.20"}}',
      'package-lock.json': '{}',
    })!;
    expect(JSON.parse(patch.files.get('package.json')!)).toEqual({
      dependencies: { 'lodash': '4.17.21', 'left-pad': '1.3.0' },
      devDependencies: { lodash: '4.17.21' },
      optionalDependencies: { lodash: '4.17.21' },
      overrides: { lodash: '4.17.21' },
    });
    // A peer dependency is a range the consumer satisfies, not an install: left alone.
    expect(JSON.parse(npm({ 'package.json': '{"peerDependencies":{"lodash":"^4.0.0"}}' })!.files.get('package.json')!).peerDependencies).toEqual({ lodash: '^4.0.0' });
  });

  it('answers null when every manifest already carries the fix', () => {
    expect(npm({ 'package.json': '{"overrides":{"lodash":"4.17.21"}}' })).toBeNull();
    expect(npm({ 'sub/package.json': '{}' })).toBeNull();
  });
});

describe('overlay command per package type', () => {
  it('upgrades OS packages with the distribution\'s own manager', () => {
    expect(overlayCommand(target({ packageType: 'deb', packageName: 'curl', fixVersion: '7.88.1-10' }), [])).toBe(
      "apt-get update && apt-get install --only-upgrade -y --no-install-recommends 'curl=7.88.1-10' && rm -rf /var/lib/apt/lists/*");
    expect(overlayCommand(target({ packageType: 'rpm', packageName: 'openssl', fixVersion: '3.0.7-27' }), [])).toContain("dnf upgrade -y 'openssl-3.0.7-27'");
  });

  it('npm: installs per project directory, globally for a global install, and not at all without a location', () => {
    expect(overlayCommand(target(), [])).toBeNull();
    expect(overlayCommand(target(), [{ path: '/usr/local/lib/node_modules/lodash/package.json', layerID: 'l' }])).toBe(
      "npm install -g --ignore-scripts --no-audit --no-fund 'lodash@4.17.21'");
    expect(overlayCommand(target(), [
      { path: '/app/node_modules/lodash/package.json', layerID: 'l' },
      { path: '/srv/node_modules/lodash/package.json', layerID: 'l' },
      { path: '/app/../etc/node_modules/lodash/package.json', layerID: 'l' },
    ])).toBe("(cd '/app' && npm install --no-save --ignore-scripts --no-audit --no-fund 'lodash@4.17.21') && (cd '/srv' && npm install --no-save --ignore-scripts --no-audit --no-fund 'lodash@4.17.21')");
  });

  it('python: the standard site in place, a custom site with --target', () => {
    const py = target({ packageType: 'python', packageName: 'requests', fixVersion: '2.32.0' });
    const base = 'PIP_BREAK_SYSTEM_PACKAGES=1 python3 -m pip install --no-deps --no-cache-dir --upgrade';
    expect(overlayCommand(py, [])).toBe(`${base} 'requests==2.32.0'`);
    expect(overlayCommand(py, [{ path: '/usr/lib/python3.11/site-packages/requests/__init__.py', layerID: 'l' }])).toBe(`${base} 'requests==2.32.0'`);
    expect(overlayCommand(py, [{ path: '/opt/venv/lib/python3.11/site-packages/requests/__init__.py', layerID: 'l' }])).toBe(
      `${base} --target '/opt/venv/lib/python3.11/site-packages' 'requests==2.32.0'`);
  });

  it('gem: installs the fix and drops the old version only when it is a safe token', () => {
    const gem = target({ packageType: 'gem', packageName: 'rack', fixVersion: '3.0.9', installedVersion: '3.0.1' });
    expect(overlayCommand(gem, [])).toBe("gem install 'rack' -v '3.0.9' --no-document && (gem uninstall 'rack' -v '3.0.1' -x -I --force || true)");
    expect(overlayCommand({ ...gem, installedVersion: '3.0.1;x' }, [])).toBe("gem install 'rack' -v '3.0.9' --no-document");
  });
});

describe('remediation DTO', () => {
  const at = new Date('2026-11-20T00:00:00Z');
  const row = (over: Record<string, unknown> = {}): any => ({
    id: 'rem-1',
    pluginId: 'p-1',
    pluginName: 'lint',
    fromVersion: '1.0.0',
    stage: 'queued',
    attempt: 1,
    createdAt: at,
    updatedAt: at,
    findingsHash: 'f'.repeat(64),
    patchKey: null,
    exportKey: null,
    ...over,
  });

  it('a fresh row answers nulls and empty lists, never the findings hash or a key', () => {
    const dto = toRemediationDto(row());
    expect(dto).toMatchObject({
      outcome: null,
      toVersion: null,
      toPluginId: null,
      versionBump: null,
      upgradeLevel: null,
      publishMode: null,
      proposeReasons: [],
      fixMethods: [],
      targetedCount: 0,
      cleared: [],
      remaining: [],
      hasPatch: false,
      hasExport: false,
      rollout: null,
      rolledBackPipelineIds: [],
      error: null,
      retryOf: null,
      decidedBy: null,
      decidedAt: null,
      publishedAt: null,
      finishedAt: null,
      createdAt: at.toISOString(),
    });
    expect(JSON.stringify(dto)).not.toContain('f'.repeat(64));
  });

  it('a rolled-out row answers its summary without the stored bookkeeping, and the rolled-back pipelines beside it', () => {
    const rollout = { status: 'paused', toVersion: '1.0.1', waves: [], counts: {}, updatedAt: at.toISOString(), eventKeys: ['k'], rolledBackPipelineIds: ['pipe-1', 7] };
    const dto = toRemediationDto(row({
      stage: 'needs_review',
      outcome: 'cleared',
      toVersion: '1.0.1',
      toPluginId: 'p-2',
      versionBump: 'patch',
      upgradeLevel: 'patch',
      publishMode: 'apply',
      proposeReasons: ['x'],
      fixMethods: ['overlay'],
      targeted: [{}, {}],
      cleared: [{ id: 'CVE-1' }],
      remaining: [],
      patchKey: 'org/p/1.0.0/remediations/rem-1/remediation.diff',
      exportKey: 'org/p/1.0.0/remediations/rem-1/export.diff',
      rollout,
      error: 'E',
      retryOf: 'rem-0',
      decidedBy: 'u-1',
      decidedAt: at,
      publishedAt: at,
      finishedAt: at,
    }));
    expect(dto).toMatchObject({ hasPatch: true, hasExport: true, targetedCount: 2, decidedAt: at.toISOString(), publishedAt: at.toISOString(), finishedAt: at.toISOString() });
    expect(dto.rolledBackPipelineIds).toEqual(['pipe-1']);
    expect(dto.rollout).not.toHaveProperty('rolledBackPipelineIds');
    expect(JSON.stringify(dto)).not.toContain('remediation.diff');
    expect(toRemediationDto(row({ rollout: { ...rollout, rolledBackPipelineIds: 'nope' } })).rolledBackPipelineIds).toEqual([]);
  });
});
