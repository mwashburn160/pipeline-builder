// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The production remediation ports (services/remediation/tooling.ts) against
 * faked buildctl / crane: the two ways a remediation build differs from an
 * upload build (no cache, a freshly pulled base), the pushed digest it must
 * report, the scan → floor → compliance chain, the network-less smokeTest,
 * the isolated lockfile tool run (and its path guard), image config and label
 * reads, digest resolution through the mirror, and the context's contract.
 */

import * as fs from 'fs';
import * as os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';

const D = (c: string) => `sha256:${c.repeat(64)}`;
const runs: Array<{ cmd: string; args: string[] }> = [];
/** What each faked CLI call answers; throws when the handler throws. */
let onRun: (cmd: string, args: string[]) => string = () => '';

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: (k: string) => (k === 'registry' ? { host: 'reg', port: 5000, http: true, network: '' } : { timeoutMs: 1000, pushTimeoutMs: 1000 }) },
}));
jest.unstable_mockModule('../src/helpers/build-process.js', () => ({
  run: jest.fn(async (cmd: string, args: string[]) => { runs.push({ cmd, args }); return onRun(cmd, args); }),
}));
jest.unstable_mockModule('../src/helpers/registry-auth.js', () => ({
  imageRepository: (name: string, _r: unknown, orgId: string) => `reg:5000/${orgId}/${name}`,
  writeAuthConfig: () => fs.mkdtempSync(path.join(os.tmpdir(), 'pb-auth-')),
}));
jest.unstable_mockModule('../src/helpers/docker-build.js', () => ({ getBuildkitAddrForBuild: () => 'tcp://buildkitd:1234', PUBLISH_PLATFORM: 'linux/amd64' }));
const attachSupplyChain = jest.fn<AnyFn>(async () => undefined);
const discardPluginImage = jest.fn<AnyFn>(async () => undefined);
jest.unstable_mockModule('../src/helpers/supply-chain.js', () => ({
  attachSupplyChain, discardPluginImage, DIGEST_RE: /^sha256:[0-9a-f]{64}$/, SUPPLY_CHAIN_STEPS: 2,
}));
const establishImageFacts = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/helpers/image-facts.js', () => ({ establishImageFacts }));
const vulnFloor = jest.fn<AnyFn>();
const complianceRefusal = jest.fn<AnyFn>(async () => null);
jest.unstable_mockModule('../src/helpers/image-gates.js', () => ({ vulnFloor, complianceRefusal }));
jest.unstable_mockModule('../src/helpers/plugin-spec.js', () => ({
  parsePluginZip: jest.fn(async () => ({ extractDir: '/x', dockerfile: 'Dockerfile', buildType: 'build_image', pluginSpec: { buildArgs: { A: '1' } } })),
  specContractFields: () => ({ requiredMetadata: ['m'], requiredVars: [], metadataTypes: {}, varsTypes: {} }),
}));
jest.unstable_mockModule('../src/helpers/base-image.js', () => ({
  baseImageLocations: (ref: string) => (ref.startsWith('node:') ? [`reg:5000/library/${ref}`, `docker.io/library/${ref}`] : []),
}));
const fetchPluginSource = jest.fn<AnyFn>(async () => 'ok');
jest.unstable_mockModule('../src/services/plugin-sources.js', () => ({ fetchPluginSource }));
const draftAskAgentPatch = jest.fn<AnyFn>(async () => null);
jest.unstable_mockModule('../src/services/remediation/ask-agent-patch.js', () => ({ draftAskAgentPatch }));
const ensureSharedBaseRebuilt = jest.fn<AnyFn>(async () => D('9'));
jest.unstable_mockModule('../src/services/remediation/base-pass.js', () => ({ ensureSharedBaseRebuilt }));

const { liveRemediationPorts, liveToolchainPorts, TOOL_IMAGES } = await import('../src/services/remediation/tooling.js');

const REF = { orgId: 'org-1', name: 'lint', digest: D('a') };
const argAfter = (args: string[], flag: string): string[] => args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []));

beforeEach(() => {
  jest.clearAllMocks();
  runs.length = 0;
  onRun = () => '';
});

describe('build', () => {
  it('pushes with --no-cache and a freshly pulled base, passes build args, and answers the pushed digest', async () => {
    onRun = (cmd, args) => {
      const meta = argAfter(args, '--metadata-file')[0];
      if (cmd === 'buildctl' && meta) fs.writeFileSync(meta, JSON.stringify({ 'containerimage.digest': D('b') }));
      return '';
    };
    const digest = await liveRemediationPorts().build({ orgId: 'org-1', name: 'lint', version: '1.0.1', contextDir: '/ctx', dockerfile: 'sub/Dockerfile', buildArgs: { BOOTSTRAP_IMAGE: 'reg/x@sha256:1' } });
    expect(digest).toBe(D('b'));
    const { args } = runs[0]!;
    expect(args).toContain('--no-cache');
    expect(argAfter(args, '--opt')).toEqual(expect.arrayContaining(['image-resolve-mode=pull', 'filename=Dockerfile', 'build-arg:BOOTSTRAP_IMAGE=reg/x@sha256:1']));
    expect(argAfter(args, '--local')).toEqual(['context=/ctx', 'dockerfile=/ctx/sub']);
    expect(argAfter(args, '--output')[0]).toBe('type=image,name=reg:5000/org-1/lint:1.0.1,push=true,registry.insecure=true');
    expect(attachSupplyChain).toHaveBeenCalledWith(expect.objectContaining({ repository: 'reg:5000/org-1/lint', digest: D('b') }));
  });

  it('a build that reports no digest fails BUILD_NO_DIGEST (nothing is signed)', async () => {
    onRun = (_cmd, args) => { fs.writeFileSync(argAfter(args, '--metadata-file')[0]!, '{}'); return ''; };
    await expect(liveRemediationPorts().build({ orgId: 'org-1', name: 'lint', version: '1.0.1', contextDir: '/ctx', dockerfile: 'Dockerfile', buildArgs: {} }))
      .rejects.toMatchObject({ code: 'BUILD_NO_DIGEST' });
    expect(attachSupplyChain).not.toHaveBeenCalled();
  });
});

describe('scan', () => {
  const record = { dockerfile: null } as never;

  it('no scan available: refused IMAGE_SCAN_UNAVAILABLE, never treated as clean', async () => {
    establishImageFacts.mockResolvedValueOnce({ scan: null, scannedAt: null, findings: [] });
    expect((await liveRemediationPorts().scan(REF, record)).scan).toEqual({ findings: [], waivedKeys: new Set(), refusal: 'IMAGE_SCAN_UNAVAILABLE' });
  });

  it('the floor refusal wins and compliance is not asked', async () => {
    establishImageFacts.mockResolvedValueOnce({ scan: {}, scannedAt: new Date(), findings: [{ id: 'CVE-1' }] });
    vulnFloor.mockReturnValueOnce({ summary: { waived: ['CVE-1|p|1'] }, refusal: { code: 'PLUGIN_VULN_GATE' } });
    const out = await liveRemediationPorts().scan(REF, record);
    expect(out.scan).toMatchObject({ refusal: 'PLUGIN_VULN_GATE', findings: [{ id: 'CVE-1' }] });
    expect([...out.scan.waivedKeys]).toEqual(['CVE-1|p|1']);
    expect(complianceRefusal).not.toHaveBeenCalled();
  });

  it('a clean floor still goes through compliance', async () => {
    establishImageFacts.mockResolvedValueOnce({ scan: {}, scannedAt: new Date(), findings: [] });
    vulnFloor.mockReturnValueOnce({ summary: { waived: [] }, refusal: null });
    complianceRefusal.mockResolvedValueOnce({ code: 'COMPLIANCE_VIOLATION' });
    expect((await liveRemediationPorts().scan(REF, record)).scan.refusal).toBe('COMPLIANCE_VIOLATION');
  });
});

describe('smokeTest', () => {
  it('runs the command network-less in a throwaway build FROM the candidate digest', async () => {
    let dockerfile = '';
    onRun = (_c, args) => { dockerfile = fs.readFileSync(path.join(argAfter(args, '--local')[0]!.replace('context=', ''), 'Dockerfile'), 'utf8'); return ''; };
    await liveRemediationPorts().smokeTest(REF, 'lint --version');
    expect(dockerfile).toBe(`FROM reg:5000/org-1/lint@${D('a')}\nRUN --network=none ["/bin/sh","-c","lint --version"]\n`);
    expect(runs[0]!.args).toContain('--no-cache');
  });

  it('refuses an empty or oversized command before building anything', async () => {
    await expect(liveRemediationPorts().smokeTest(REF, '')).rejects.toThrow(/1–4096/);
    await expect(liveRemediationPorts().smokeTest(REF, 'x'.repeat(4097))).rejects.toThrow(/1–4096/);
    expect(runs).toEqual([]);
  });
});

describe('runTool (lockfile regeneration)', () => {
  it('builds in the ecosystem\'s tool image and copies only the named outputs back', async () => {
    const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-ctx-'));
    let dockerfile = '';
    onRun = (_c, args) => {
      dockerfile = fs.readFileSync(path.join(argAfter(args, '--local').find((l) => l.startsWith('dockerfile='))!.slice('dockerfile='.length), 'Dockerfile'), 'utf8');
      const out = argAfter(args, '--output')[0]!.replace('type=local,dest=', '');
      fs.writeFileSync(path.join(out, 'package-lock.json'), '{"lock":true}');
      return '';
    };
    fs.mkdirSync(path.join(ctx, 'app'));
    await liveRemediationPorts().runTool({ ecosystem: 'npm', dir: 'app', command: 'npm install --package-lock-only', outputs: ['package-lock.json'] } as never, ctx);
    expect(dockerfile).toContain(`FROM ${TOOL_IMAGES.npm} AS work`);
    expect(dockerfile).toContain('WORKDIR /src/app');
    expect(dockerfile).toContain('COPY --from=work /src/app/package-lock.json /package-lock.json');
    expect(fs.readFileSync(path.join(ctx, 'app', 'package-lock.json'), 'utf8')).toBe('{"lock":true}');
  });

  it.each([
    [{ dir: '../escape', outputs: ['x'] }],
    [{ dir: 'app', outputs: ['../x'] }],
    [{ dir: 'app', outputs: ['a/b'] }],
  ])('refuses a path that leaves the context (%o)', async (bad) => {
    await expect(liveRemediationPorts().runTool({ ecosystem: 'npm', command: 'x', ...bad } as never, '/ctx')).rejects.toThrow('invalid tool run');
    expect(runs).toEqual([]);
  });
});

describe('image reads', () => {
  const config = { config: { User: '1000', Entrypoint: ['/bin/sh'], Cmd: null, WorkingDir: '/app', Labels: { 'org.pipeline-builder.toolchain.node': '26.13.1', 'weird': 7 } }, rootfs: { diff_ids: ['sha256:l1', 'sha256:l2'] } };

  it('reads user / entrypoint / cmd / workdir from crane config, defaulting what is absent', async () => {
    onRun = () => JSON.stringify(config);
    expect(await liveRemediationPorts().imageConfig(REF)).toEqual({ user: '1000', entrypoint: ['/bin/sh'], cmd: null, workingDir: '/app' });
    expect(runs[0]!.args).toEqual(['--insecure', 'config', '--platform', 'linux/amd64', `reg:5000/org-1/lint@${D('a')}`]);
    onRun = () => '{}';
    expect(await liveRemediationPorts().imageConfig(REF)).toEqual({ user: '', entrypoint: null, cmd: null, workingDir: '' });
  });

  it('toolchain ports read the labels, dropping any non-string value', async () => {
    onRun = () => JSON.stringify(config);
    expect(await liveToolchainPorts().imageLabels(REF)).toEqual({ 'org.pipeline-builder.toolchain.node': '26.13.1' });
    onRun = () => '{"config":{}}';
    expect(await liveToolchainPorts().imageLabels(REF)).toEqual({});
  });

  it('layer ids try the mirror first, then the next location', async () => {
    onRun = (_c, args) => { if (args.at(-1)!.startsWith('reg:5000/library/')) throw new Error('mirror miss'); return JSON.stringify(config); };
    expect(await liveRemediationPorts().layerIds('node:26-slim')).toEqual(['sha256:l1', 'sha256:l2']);
    expect(runs.map((r) => r.args.at(-1))).toEqual(['reg:5000/library/node:26-slim', 'docker.io/library/node:26-slim']);
  });

  it('a digest that resolves nowhere is null, not an error (the base is just not refreshed)', async () => {
    onRun = () => { throw new Error('unreachable'); };
    expect(await liveRemediationPorts().resolveDigest('node:26-slim')).toBeNull();
    onRun = () => `${D('c')}\n`;
    expect(await liveRemediationPorts().resolveDigest('plugin-base:26.10')).toBe(D('c'));
    expect(runs.at(-1)!.args.at(-1)).toBe('plugin-base:26.10'); // no mirror location: the ref itself
  });
});

describe('sources, contract and the rest', () => {
  it('opens a kept source with its spec build args', async () => {
    expect(await liveRemediationPorts().openSource('/s.zip', '/work')).toEqual({ dir: '/x', dockerfile: 'Dockerfile', buildType: 'build_image', buildArgs: { A: '1' } });
    expect(await liveRemediationPorts().fetchSource({ sourceKey: 'k', sourceSha256: 'h', sourceKind: 'zip' }, '/d.zip')).toBe('ok');
    expect(fetchPluginSource).toHaveBeenCalledWith({ sourceKey: 'k', sourceSha256: 'h', sourceKind: 'zip' }, '/d.zip');
  });

  it('reads the contract a context\'s spec declares; none without a spec', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-spec-'));
    expect(await liveRemediationPorts().contractOf(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'plugin-spec.yml'), 'commands: [lint, 7]\ninstallCommands: not-a-list\nsecrets: [{name: T}]\nenv: [x]\n');
    expect(await liveRemediationPorts().contractOf(dir)).toEqual({
      pluginType: 'CodeBuildStep',
      commands: ['lint'],
      installCommands: [],
      requiredMetadata: ['m'],
      requiredVars: [],
      metadataTypes: {},
      varsTypes: {},
      secrets: [{ name: 'T' }],
      env: {},
    });
  });

  it('discards through the shared image discard, names the reference, and delegates the agent and base pass', async () => {
    const p = liveRemediationPorts();
    await p.discardImage(REF);
    expect(discardPluginImage).toHaveBeenCalledWith(expect.objectContaining({ repository: 'reg:5000/org-1/lint', digest: D('a'), context: { refusalCode: 'REMEDIATION_CANDIDATE' } }));
    expect(p.imageReference(REF)).toBe(`reg:5000/org-1/lint@${D('a')}`);
    await p.askAgent({ remediationId: 'r', orgId: 'o', workdir: '/w', findings: [] });
    expect(draftAskAgentPatch).toHaveBeenCalledWith({ remediationId: 'r', orgId: 'o', workdir: '/w', findings: [] });
    expect(await p.ensureSharedBase({ image: 'plugin-base:26.10' } as never, [])).toBe(D('9'));
  });
});
