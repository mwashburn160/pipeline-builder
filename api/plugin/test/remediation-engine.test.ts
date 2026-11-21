// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The remediation engine end to end against fake ports: a fake registry whose
 * "scanner" reports a fixture's known advisory until the built context (or the
 * overlay's RUN) carries the fixed version. One fixture per package type comes
 * out clean; upgrade levels, Go /v2, the contract check, the mixed-patch retry,
 * the checksum fail-closed, Stage 1's digest refresh and the shared-base pass.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import path from 'path';

import { describe, expect, it, jest } from '@jest/globals';
import { DEFAULT_PLUGIN_REMEDIATION_SETTINGS, type PluginRemediationSettings, type PluginScanFinding } from '@pipeline-builder/api-core';
import AdmZip from 'adm-zip';

import { fixtureFinding } from './helpers/remediation-fixtures.js';
import type { PluginRecordData } from '../src/helpers/plugin-helpers.js';
import { CANARY_FIXTURES, canaryContext, type CanaryFixture } from '../src/services/remediation/canary.js';
import { candidateDiff, contractOfRecord, runRemediationEngine, type EngineInput } from '../src/services/remediation/engine.js';
import type { ImageRef, RemediationPorts } from '../src/services/remediation/ports.js';
import { readTree } from '../src/services/remediation/workspace.js';

const ORIG = `sha256:${'0'.repeat(64)}`;
const ORG = 'aaaaaaaaaaaaaaaaaaaaaaa1';

interface Fake {
  ports: RemediationPorts;
  builds: Array<{ dir: Map<string, string>; digest: string }>;
  discarded: string[];
  smokeFails: (tree: Map<string, string>) => boolean;
  contractChanged: boolean;
}

/** A fake world for one fixture (or several findings). */
function fakeWorld(packages: Array<{ f: CanaryFixture; finding: PluginScanFinding }>, files: Record<string, string>, opts: { checksum?: boolean; source?: boolean; resolve?: string } = {}): Fake {
  const trees = new Map<string, Map<string, string>>();
  trees.set(ORIG, new Map());
  const fake: Fake = { builds: [], discarded: [], smokeFails: () => false, contractChanged: false, ports: null as never };
  const fixedIn = (tree: Map<string, string>, f: CanaryFixture): boolean => {
    const v = f.fixed.replace(/^v/, '');
    for (const [k, c] of tree) {
      if (k === 'plugin-spec.yaml' || (k.endsWith('.lock') && f.type !== 'gem' && f.type !== 'rust-crate')) continue;
      if (c.includes(v)) return true;
    }
    // An overlay builds FROM a previous image: inherit what it had fixed.
    const from = /FROM \S+@(sha256:[0-9a-f]{64})/.exec(tree.get('Dockerfile') ?? '')?.[1];
    return from ? fixedIn(trees.get(from) ?? new Map(), f) : false;
  };
  fake.ports = {
    async fetchSource(_row, dest) {
      if (opts.source === false) return 'missing';
      if (opts.checksum) throw Object.assign(new Error('mismatch'), { code: 'SOURCE_CHECKSUM_MISMATCH' });
      const z = new AdmZip();
      for (const [k, v] of Object.entries(files)) z.addFile(k, Buffer.from(v));
      z.writeZip(dest);
      return 'ok';
    },
    async openSource(zip, root) {
      const dir = fs.mkdtempSync(path.join(root, 'src-'));
      new AdmZip(zip).extractAllTo(dir, true);
      return { dir, dockerfile: 'Dockerfile', buildType: 'build_image', buildArgs: {} };
    },
    async contractOf() { return fake.contractChanged ? { ...contractOfRecord(RECORD), commands: ['changed'] } : contractOfRecord(RECORD); },
    async build(req) {
      const tree = readTree(req.contextDir);
      const digest = `sha256:${createHash('sha256').update(JSON.stringify([...tree].sort()) + req.version).digest('hex')}`;
      trees.set(digest, tree);
      fake.builds.push({ dir: tree, digest });
      return digest;
    },
    async scan(ref) {
      const tree = trees.get(ref.digest)!;
      const findings = packages.filter((p) => ref.digest === ORIG || !fixedIn(tree, p.f)).map((p) => p.finding);
      return { scan: { findings, waivedKeys: new Set(), refusal: null }, facts: null, summary: null };
    },
    async imageConfig() { return { user: '1000:1000', entrypoint: null, cmd: ['bash'], workingDir: '/app' }; },
    async layerIds() { return ['sha256:layer-base']; },
    async smokeTest(ref: ImageRef) { if (fake.smokeFails(trees.get(ref.digest) ?? new Map())) throw new Error('smoke'); },
    async resolveDigest() { return opts.resolve ?? null; },
    async runTool() { /* lockfiles regenerate in a tool build in production */ },
    async discardImage(ref) { fake.discarded.push(ref.digest); },
    imageReference: (ref) => `reg:5000/org-x/${ref.name}@${ref.digest}`,
    async askAgent() { return null; },
    ensureSharedBase: jest.fn(async () => `reg:5000/system/plugin-base@sha256:${'b'.repeat(64)}`),
  };
  return fake;
}

const RECORD = { orgId: ORG, name: 'p', version: '1.0.0', pluginType: 'CodeBuildStep', commands: ['echo'], installCommands: [], requiredMetadata: [], requiredVars: [], metadataTypes: {}, varsTypes: {}, secrets: [], env: {}, dockerfile: null } as unknown as PluginRecordData;

function input(targeted: PluginScanFinding[], settings: Partial<PluginRemediationSettings> = {}, over: Partial<EngineInput['plugin']> = {}): EngineInput {
  return {
    remediationId: '00000000-0000-4000-8000-000000000001',
    orgId: ORG,
    plugin: { id: 'pid', name: 'p', version: '1.0.0', imageDigest: ORIG, sourceKind: 'zip', sourceKey: 'k', sourceSha256: 'a'.repeat(64), smokeTest: 'true', originalFindings: targeted, record: RECORD, ...over },
    targeted,
    settings: { ...DEFAULT_PLUGIN_REMEDIATION_SETTINGS, ...settings },
    versionFor: (bump) => (bump === 'minor' ? '1.1.0' : '1.0.1'),
    workRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'rem-test-')),
  };
}

describe('one fixture per package type comes out clean', () => {
  it.each(CANARY_FIXTURES.map((f) => [f.type, f] as const))('%s', async (type, f) => {
    const finding = fixtureFinding(f);
    const world = fakeWorld([{ f, finding }], canaryContext(f));
    // DEFAULT settings: the nightly canary runs under the system org's, so every fixture's fix is within them.
    const out = await runRemediationEngine(input([finding]), world.ports);
    expect(out.remaining).toEqual([]);
    expect(out.cleared).toEqual([expect.objectContaining({ id: f.advisory, method: type === 'apk' ? 'overlay' : 'source_patch' })]);
    expect(out.candidate).not.toBeNull();
    expect(out.candidate!.diff).toContain(f.fixed.replace(/^v/, ''));
    expect(out.versionBump).toBe('patch');
    expect(out.majorUpgrade).toBe(false);
    // Every candidate but the selected one was discarded.
    expect(world.discarded).not.toContain(out.candidate!.ref.digest);
    expect(world.discarded.length).toBe(world.builds.length - 1);
  });
});

describe('the candidate diff', () => {
  /** The files a unified diff touches, as `path: added | deleted | modified`. */
  const touched = (diff: string) => [...diff.matchAll(/^--- (\S+)\n\+\+\+ (\S+)$/gm)]
    .map(([, a, b]) => (a === '/dev/null' ? `${b!.replace(/^b\//, '')}: added` : b === '/dev/null' ? `${a!.replace(/^a\//, '')}: deleted` : `${b!.replace(/^b\//, '')}: modified`));

  it('an overlay-only fix of a plugin WITH a kept source shows the overlay alone, never the rest of the context as deleted', async () => {
    const apk = CANARY_FIXTURES.find((f) => f.type === 'apk')!;
    const finding = fixtureFinding(apk);
    const out = await runRemediationEngine(input([finding]), fakeWorld([{ f: apk, finding }], canaryContext(apk)).ports);
    expect(out.cleared).toEqual([expect.objectContaining({ method: 'overlay' })]);
    expect(Object.keys(canaryContext(apk)).length).toBeGreaterThan(1);
    expect(touched(out.candidate!.diff)).toEqual(['remediation-overlay/Dockerfile: added']);
  });

  it('a source patch shows only the files it changed', async () => {
    const npm = CANARY_FIXTURES.find((f) => f.type === 'npm')!;
    const finding = fixtureFinding(npm);
    const out = await runRemediationEngine(input([finding]), fakeWorld([{ f: npm, finding }], canaryContext(npm)).ports);
    expect(out.cleared).toEqual([expect.objectContaining({ method: 'source_patch' })]);
    expect(touched(out.candidate!.diff).every((t) => t.endsWith(': modified'))).toBe(true);
  });

  it('an overlay on a Stage 1 rebuild shows the rebuild\'s change and the overlay; with no source, the overlay alone', () => {
    const original = new Map([['Dockerfile', 'FROM a@sha256:1\n'], ['config.yaml', 'x: 1\n']]);
    const rebuilt = new Map([['Dockerfile', 'FROM a@sha256:2\n'], ['config.yaml', 'x: 1\n']]);
    const overlay = new Map([['Dockerfile', 'FROM reg/p@sha256:3\nRUN apk upgrade curl\n']]);
    expect(touched(candidateDiff(original, rebuilt, overlay, true))).toEqual(['Dockerfile: modified', 'remediation-overlay/Dockerfile: added']);
    expect(touched(candidateDiff(original, original, overlay, true))).toEqual(['remediation-overlay/Dockerfile: added']);
    expect(touched(candidateDiff(null, null, overlay, true))).toEqual(['remediation-overlay/Dockerfile: added']);
    expect(touched(candidateDiff(original, original, rebuilt, false))).toEqual(['Dockerfile: modified']);
  });
});

describe('upgrade levels', () => {
  const dotnet = CANARY_FIXTURES.find((f) => f.type === 'dotnet')!;
  it('a major-only fix goes to the owner with the level it needs', async () => {
    const major: CanaryFixture = { ...dotnet, fixed: '2.0.0' };
    const finding = fixtureFinding(major);
    const out = await runRemediationEngine(input([finding]), fakeWorld([{ f: major, finding }], canaryContext(dotnet)).ports);
    expect(out.candidate).toBeNull();
    expect(out.remaining).toEqual([expect.objectContaining({ reason: 'beyond_upgrade_level', requiredLevel: 'major' })]);
  });

  it('the strictest of org, per-type and per-plugin levels applies', async () => {
    const node = CANARY_FIXTURES.find((f) => f.type === 'binary')!;
    const minor: CanaryFixture = { ...node, fixed: '24.23.0' }; // 24.22.2 → 24.23.0: a minor move
    const finding = fixtureFinding(minor);
    const world = fakeWorld([{ f: minor, finding }], canaryContext(node));
    const byPlugin = await runRemediationEngine(input([finding], { libraryUpgradeLevel: 'major', libraryUpgradeLevelByPlugin: { p: 'patch' } }), world.ports);
    expect(byPlugin.remaining[0]).toMatchObject({ reason: 'beyond_upgrade_level', requiredLevel: 'minor' });
    const byType = await runRemediationEngine(input([finding], { libraryUpgradeLevel: 'major', libraryUpgradeLevelByType: { binary: 'patch' } }), world.ports);
    expect(byType.remaining[0]).toMatchObject({ reason: 'beyond_upgrade_level' });
    const ok = await runRemediationEngine(input([finding], { libraryUpgradeLevel: 'minor' }), world.ports);
    expect(ok.cleared).toHaveLength(1);
  });

  it('a Go fix on a new major module path always goes to the owner', async () => {
    const go = CANARY_FIXTURES.find((f) => f.type === 'go-module')!;
    const finding = fixtureFinding(go, { packageVersion: 'v1.2.0', fixedIn: ['v2.0.0'] });
    const out = await runRemediationEngine(input([finding], { libraryUpgradeLevel: 'major' }), fakeWorld([{ f: go, finding }], canaryContext(go)).ports);
    expect(out.remaining).toEqual([expect.objectContaining({ reason: 'go_module_major', requiredLevel: 'owner' })]);
  });

  it('a finding the scan recorded without package details goes to the owner as no_package_details, never patched', async () => {
    const f = CANARY_FIXTURES[0]!;
    const finding = fixtureFinding(f, { purl: `${f.type}:${f.packageName}@x`, locations: [], unremediable: 'no_package_details' });
    const world = fakeWorld([{ f, finding }], canaryContext(f));
    const out = await runRemediationEngine(input([finding]), world.ports);
    expect(out.remaining).toEqual([expect.objectContaining({ id: f.advisory, reason: 'no_package_details' })]);
    expect(out.cleared).toEqual([]);
    expect(out.candidate).toBeNull();
  });

  it('a KEV finding with no fix goes to the owner as no_fix', async () => {
    const f = CANARY_FIXTURES[0]!;
    const finding = fixtureFinding(f, { fixedIn: [], kev: true });
    const out = await runRemediationEngine(input([finding]), fakeWorld([{ f, finding }], canaryContext(f)).ports);
    expect(out.remaining).toEqual([expect.objectContaining({ reason: 'no_fix', kev: true })]);
  });
});

describe('verification drops what breaks', () => {
  const deb = CANARY_FIXTURES.find((f) => f.type === 'deb')!;
  it('a patch that breaks the contract check is dropped', async () => {
    const finding = fixtureFinding(deb);
    const world = fakeWorld([{ f: deb, finding }], canaryContext(deb));
    world.contractChanged = true;
    const out = await runRemediationEngine(input([finding]), world.ports);
    expect(out.candidate).toBeNull();
    expect(out.remaining).toEqual([expect.objectContaining({ reason: 'patch_broke_plugin', detail: expect.stringContaining('CONTRACT_CHANGED') })]);
    expect(out.cleared).toEqual([]);
  });

  it('a mixed patch keeps the packages that work and sends the rest to the owner', async () => {
    const wget: CanaryFixture = { ...deb, packageName: 'wget', installed: '1.25.0-2', fixed: '1.25.0-2+deb13u1', advisory: 'CVE-2024-10524' };
    const files = { ...canaryContext(deb), Dockerfile: deb.files.Dockerfile!.replace(`${deb.packageName}=`, `wget ${deb.packageName}=`) };
    const pkgs = [{ f: deb, finding: fixtureFinding(deb) }, { f: wget, finding: fixtureFinding(wget) }];
    const world = fakeWorld(pkgs, files);
    world.smokeFails = (tree) => (tree.get('Dockerfile') ?? '').includes(`wget=${wget.fixed}`);
    const out = await runRemediationEngine(input(pkgs.map((p) => p.finding)), world.ports);
    expect(out.cleared.map((c) => c.packageName)).toEqual([deb.packageName]);
    expect(out.remaining).toEqual([expect.objectContaining({ packageName: 'wget', reason: 'patch_broke_plugin' })]);
    expect(out.candidate!.dockerfile).toContain(`${deb.packageName}=${deb.fixed}`);
    expect(out.candidate!.dockerfile).not.toContain(`wget=${wget.fixed}`);
  });

  it('no smokeTest declared is reported, so the job can hold it to propose', async () => {
    const finding = fixtureFinding(deb);
    const i = input([finding]);
    const out = await runRemediationEngine({ ...i, plugin: { ...i.plugin, smokeTest: null } }, fakeWorld([{ f: deb, finding }], canaryContext(deb)).ports);
    expect(out.hasSmokeTest).toBe(false);
    expect(out.candidate).not.toBeNull();
  });

  it('a checksum mismatch fails closed before anything is built', async () => {
    const finding = fixtureFinding(deb);
    const world = fakeWorld([{ f: deb, finding }], canaryContext(deb), { checksum: true });
    const out = await runRemediationEngine(input([finding]), world.ports);
    expect(out.error).toBe('SOURCE_CHECKSUM_MISMATCH');
    expect(world.builds).toEqual([]);
  });

  it('without a kept source a compiled package goes to the owner, an OS one is overlaid', async () => {
    const rust = CANARY_FIXTURES.find((f) => f.type === 'rust-crate')!;
    const pkgs = [{ f: rust, finding: fixtureFinding(rust) }, { f: deb, finding: fixtureFinding(deb) }];
    const out = await runRemediationEngine(input(pkgs.map((p) => p.finding), {}, { sourceKind: 'none' }), fakeWorld(pkgs, {}, { source: false }).ports);
    expect(out.remaining).toEqual([expect.objectContaining({ packageName: 'regex', reason: 'no_source' })]);
    expect(out.cleared).toEqual([expect.objectContaining({ packageName: deb.packageName, method: 'overlay' })]);
  });
});

describe('Stage 1', () => {
  it('rebuilds a digest-pinned FROM refreshed within its tag; a rebuild that clears everything is the fix', async () => {
    const D1 = `sha256:${'1'.repeat(64)}`;
    const D2 = `sha256:${'2'.repeat(64)}`;
    const deb = CANARY_FIXTURES.find((f) => f.type === 'deb')!;
    // The refreshed base already carries the fixed package.
    const fixedBase: CanaryFixture = { ...deb, fixed: D2.slice(7, 20) };
    const finding = fixtureFinding(fixedBase);
    const world = fakeWorld([{ f: fixedBase, finding }], { Dockerfile: `FROM debian:12@${D1}\nUSER 1000:1000\n` }, { resolve: D2 });
    const out = await runRemediationEngine(input([finding]), world.ports);
    expect(world.builds[0]!.dir.get('Dockerfile')).toBe(`FROM debian:12@${D2}\nUSER 1000:1000\n`);
    expect(out.cleared).toEqual([expect.objectContaining({ method: 'rebuild', toVersion: null })]);
    expect(out.fixMethods).toEqual(['rebuild']);
    expect(out.candidate!.diff).toContain(`+FROM debian:12@${D2}`);
  });

  it('a finding in a shared base\'s layer rebuilds that base and builds FROM it', async () => {
    const deb = CANARY_FIXTURES.find((f) => f.type === 'deb')!;
    const finding = fixtureFinding(deb, { locations: [{ path: '/var/lib/dpkg/status', layerID: 'sha256:layer-base' }] });
    const world = fakeWorld([{ f: deb, finding }], { Dockerfile: 'FROM plugin-base:26.10\nRUN apt-get install -y curl\n' });
    await runRemediationEngine(input([finding]), world.ports);
    expect(world.ports.ensureSharedBase).toHaveBeenCalledWith(expect.objectContaining({ image: 'plugin-base:26.10' }), [finding]);
    expect(world.builds[0]!.dir.get('Dockerfile')).toContain(`FROM reg:5000/system/plugin-base@sha256:${'b'.repeat(64)}`);
  });
});

describe('the shared-base pass', () => {
  it('rebuilds a base once per base and findings set; every other dependant reuses it', async () => {
    const { ensureSharedBaseRebuilt } = await import('../src/services/remediation/base-pass.js');
    const store = new Map<string, string>();
    const zset = new Map<string, number>();
    const redis = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string, ...a: Array<string | number>) => { if (a.includes('NX') && store.has(k)) return null; store.set(k, v); return 'OK'; },
      del: async (k: string) => { store.delete(k); },
      eval: async (_s: string, _n: number, _k: string, _now: number, _exp: number, m: string) => { zset.set(m, 1); return 1; },
      zrem: async (_k: string, m: string) => { zset.delete(m); },
      zadd: async () => 1,
    };
    const deb = CANARY_FIXTURES.find((f) => f.type === 'deb')!;
    const finding = fixtureFinding(deb);
    const world = fakeWorld([{ f: deb, finding }], {}, { resolve: `sha256:${'e'.repeat(64)}` });
    const base = { key: 'plugin', image: 'plugin-base:26.10', dir: '_plugin-base', provides: '', smokeTest: 'bash --version' };
    const a = await ensureSharedBaseRebuilt(base, [finding], world.ports, { redis, sleep: async () => undefined });
    const b = await ensureSharedBaseRebuilt(base, [finding], world.ports, { redis, sleep: async () => undefined });
    expect(a).toMatch(/^reg:5000\/org-x\/plugin-base@sha256:/);
    expect(b).toBe(a);
    expect(world.builds).toHaveLength(1);
    expect(world.builds[0]!.dir.get('Dockerfile')).toContain(`'${deb.packageName}=${deb.fixed}'`);
    expect(zset.size).toBe(0);
  });
});

describe('never a downgrade pin', () => {
  it('a fixed version not above the installed one is never patched: the finding goes to the owner (no_fix)', async () => {
    const f = CANARY_FIXTURES.find((x) => x.type === 'npm')!;
    // A multi-branch advisory whose only listed fix is on an older release line.
    const finding = fixtureFinding(f, { fixedIn: ['4.17.19'] });
    const world = fakeWorld([{ f, finding }], canaryContext(f));
    const out = await runRemediationEngine(input([finding]), world.ports);
    expect(out.candidate).toBeNull();
    expect(out.cleared).toEqual([]);
    expect(out.remaining).toEqual([expect.objectContaining({ id: f.advisory, reason: 'no_fix' })]);
    // The only build is Stage 1's rebuild; nothing pins lodash to 4.17.19.
    expect(world.builds.every((b) => ![...b.dir.values()].some((c) => c.includes('4.17.19')))).toBe(true);
  });
});

describe('never a downgrade pin in a shared base', () => {
  it('a base whose only fixes are not above the installed version is not rebuilt', async () => {
    const { ensureSharedBaseRebuilt } = await import('../src/services/remediation/base-pass.js');
    const store = new Map<string, string>();
    const redis = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string, ...a: Array<string | number>) => { if (a.includes('NX') && store.has(k)) return null; store.set(k, v); return 'OK'; },
      del: async (k: string) => { store.delete(k); },
      eval: async () => 1,
      zrem: async () => 1,
      zadd: async () => 1,
    };
    const deb = CANARY_FIXTURES.find((f) => f.type === 'deb')!;
    const finding = fixtureFinding(deb, { fixedIn: ['2.8.2-1~deb13u1'] }); // below the installed 2.8.3-1~deb13u1
    const world = fakeWorld([{ f: deb, finding }], {}, { resolve: `sha256:${'e'.repeat(64)}` });
    const base = { key: 'plugin', image: 'plugin-base:26.10', dir: '_plugin-base', provides: '', smokeTest: 'bash --version' };
    expect(await ensureSharedBaseRebuilt(base, [finding], world.ports, { redis, sleep: async () => undefined })).toBeNull();
    expect(world.builds).toHaveLength(0);
  });
});
