// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The remediation patchers, overlay builder, Dockerfile helpers, diffs and the
 * verification checks — pure, against the per-package-type canary fixtures.
 */

import { describe, expect, it } from '@jest/globals';
import { chooseFixVersion, type GrypePackageType } from '@pipeline-builder/api-core';

import { fixtureFinding } from './helpers/remediation-fixtures.js';
import { CANARY_FIXTURES, canaryContext, type CanaryFixture } from '../src/services/remediation/canary.js';
import { applyPatch, fileDiff, treeDiff } from '../src/services/remediation/diff.js';
import { findPinnedArg, pinnedArgNames, refreshPinnedBases, rewriteSharedBase, sharedBaseOf } from '../src/services/remediation/dockerfile.js';
import { isSingleLayerOverlay, overlayDockerfile } from '../src/services/remediation/overlay.js';
import { overlayCommand, SOURCE_PATCHERS, type FixTarget } from '../src/services/remediation/patchers/index.js';
import { pinInInstallCommands } from '../src/services/remediation/patchers/os.js';
import { scopeCheck, verifyCandidate, type ImageConfigFacts, type PluginContractShape } from '../src/services/remediation/verify.js';

const targetOf = (f: CanaryFixture): FixTarget => {
  const [choice] = chooseFixVersion([fixtureFinding(f)]);
  return { ...choice!, fixVersion: choice!.fixVersion! };
};

/** Per type: the source patcher applies to its fixture, or (apk) the overlay does. */
describe('source patchers, one fixture per package type', () => {
  const overlayOnly = new Set<GrypePackageType>(['apk']);
  it.each(CANARY_FIXTURES.filter((f) => !overlayOnly.has(f.type)).map((f) => [f.type, f] as const))('%s: pins the fixed version where the context declares the package', (_t, f) => {
    const tree = new Map(Object.entries(canaryContext(f)));
    const patch = SOURCE_PATCHERS[f.type]!(tree, targetOf(f), { dockerfile: 'Dockerfile' });
    expect(patch).not.toBeNull();
    const changed = [...patch!.files.values()].join('\n');
    expect(changed).toContain(f.fixed.replace(/^v/, ''));
    // Only the named package's lines (plus regenerated lockfiles) changed.
    const after = new Map(tree);
    for (const [k, v] of patch!.files) after.set(k, v);
    expect(scopeCheck({ before: tree, after, mentions: [f.packageName, f.installed, f.fixed, f.fixed.replace(/^v/, ''), 'com.fasterxml.jackson.core', ...pinnedArgNames(f.packageName)], lockfiles: patch!.lockfiles })).toEqual({ ok: true });
  });

  it('apk: the base installed it, so no source patch — the overlay upgrades it in place', () => {
    const f = CANARY_FIXTURES.find((x) => x.type === 'apk')!;
    const tree = new Map(Object.entries(canaryContext(f)));
    expect(SOURCE_PATCHERS.apk!(tree, targetOf(f), { dockerfile: 'Dockerfile' })).toBeNull();
    expect(overlayCommand(targetOf(f), [])).toBe(`apk add --no-cache --upgrade '${f.packageName}=${f.fixed}'`);
  });

  it('npm adds an overrides entry and asks for the lockfile to be regenerated', () => {
    const f = CANARY_FIXTURES.find((x) => x.type === 'npm')!;
    const patch = SOURCE_PATCHERS.npm!(new Map(Object.entries(canaryContext(f))), targetOf(f), { dockerfile: 'Dockerfile' })!;
    // lodash is a DIRECT dependency: its spec moves with the override (npm refuses one that differs).
    expect(JSON.parse(patch.files.get('package.json')!)).toMatchObject({ dependencies: { lodash: '4.18.0' }, overrides: { lodash: '4.18.0' } });
    expect(patch.regenerate).toEqual([expect.objectContaining({ ecosystem: 'npm', outputs: ['package-lock.json'] })]);
    expect(patch.lockfiles).toEqual(['package-lock.json']);
  });

  it('go-module edits the require line with a v prefix and regenerates go.sum', () => {
    const f = CANARY_FIXTURES.find((x) => x.type === 'go-module')!;
    const patch = SOURCE_PATCHERS['go-module']!(new Map(Object.entries(canaryContext(f))), targetOf(f), { dockerfile: 'Dockerfile' })!;
    expect(patch.files.get('go.mod')).toContain('require github.com/golang-jwt/jwt/v5 v5.2.2');
    expect(patch.regenerate[0]!.command).toBe('go mod download github.com/golang-jwt/jwt/v5@v5.2.2 && go mod tidy');
  });

  it('rust-crate bumps the Cargo.lock entry, drops its now-stale checksum, and re-resolves it by the version it now names', () => {
    const f = CANARY_FIXTURES.find((x) => x.type === 'rust-crate')!;
    const patch = SOURCE_PATCHERS['rust-crate']!(new Map(Object.entries(canaryContext(f))), targetOf(f), { dockerfile: 'Dockerfile' })!;
    const block = patch.files.get('Cargo.lock')!.split('[[package]]').find((b) => b.includes('name = "regex"\n'))!;
    expect(block).toContain('version = "1.5.5"');
    // cargo refuses a lockfile whose checksum does not match the version it names.
    expect(block).not.toContain('checksum');
    // The other packages keep theirs.
    expect(patch.files.get('Cargo.lock')!.match(/^checksum = /gm)).toHaveLength(3);
    // The regeneration runs on the EDITED lockfile, which no longer has regex 1.5.4 in it.
    expect(patch.regenerate).toEqual([expect.objectContaining({ ecosystem: 'cargo', command: 'cargo update -p regex@1.5.5 --precise 1.5.5', outputs: ['Cargo.lock'] })]);
  });

  it('Maven: a direct dependency\'s version is bumped and a dependencyManagement entry added', () => {
    const f = CANARY_FIXTURES.find((x) => x.type === 'java-archive')!;
    const pom = SOURCE_PATCHERS['java-archive']!(new Map(Object.entries(canaryContext(f))), targetOf(f), { dockerfile: 'Dockerfile' })!.files.get('pom.xml')!;
    expect(pom).toContain('<dependencyManagement>');
    expect(pom).not.toContain('<version>2.18.10</version>');
    expect(pom.match(/<version>2\.18\.11<\/version>/g)).toHaveLength(2);
  });

  it('Gradle: a constraints entry pins a transitive coordinate', () => {
    const f = CANARY_FIXTURES.find((x) => x.type === 'java-archive')!;
    const tree = new Map([['build.gradle.kts', 'plugins { java }\n\ndependencies {\n    implementation("org.example:app:1.0")\n}\n']]);
    const out = SOURCE_PATCHERS['java-archive']!(tree, targetOf(f), { dockerfile: 'Dockerfile' })!.files.get('build.gradle.kts')!;
    expect(out).toContain('constraints {');
    expect(out).toContain('implementation("com.fasterxml.jackson.core:jackson-databind:2.18.11")');
  });

  it('dotnet pins a transitive package with a direct PackageReference', () => {
    const f = CANARY_FIXTURES.find((x) => x.type === 'dotnet')!;
    const tree = new Map([['App.csproj', '<Project>\n  <ItemGroup>\n    <PackageReference Include="Other" Version="1.0.0" />\n  </ItemGroup>\n</Project>\n']]);
    expect(SOURCE_PATCHERS.dotnet!(tree, targetOf(f), { dockerfile: 'Dockerfile' })!.files.get('App.csproj')).toContain('<PackageReference Include="Snappier" Version="1.3.1" />');
  });

  it('binary bumps only a recognised ARG pin; anything else has no source patch', () => {
    const f = CANARY_FIXTURES.find((x) => x.type === 'binary')!;
    expect(SOURCE_PATCHERS.binary!(new Map(Object.entries(canaryContext(f))), targetOf(f), { dockerfile: 'Dockerfile' })!.files.get('Dockerfile')).toContain('ARG NODE_VERSION=24.22.3');
    expect(SOURCE_PATCHERS.binary!(new Map([['Dockerfile', 'FROM debian\nRUN curl -fsSLO https://nodejs.org/dist/latest/node.tar.gz\n']]), targetOf(f), { dockerfile: 'Dockerfile' })).toBeNull();
    expect(pinnedArgNames('stdlib')).toEqual(['GO_VERSION', 'GOLANG_VERSION']);
    expect(findPinnedArg('ARG GO_VERSION=1.22.1\n', pinnedArgNames('stdlib'))?.value).toBe('1.22.1');
  });

  it('python pins an ARG-referenced pip token by bumping the ARG', () => {
    const f = { ...CANARY_FIXTURES.find((x) => x.type === 'python')!, packageName: 'ruff', installed: '0.4.0', fixed: '0.4.1' };
    const out = SOURCE_PATCHERS.python!(new Map([['Dockerfile', 'FROM python\nARG RUFF_VERSION=0.4.0\nRUN pip3 install --no-cache-dir "ruff==${RUFF_VERSION}"\n']]), targetOf(f), { dockerfile: 'Dockerfile' })!;
    expect(out.files.get('Dockerfile')).toContain('ARG RUFF_VERSION=0.4.1');
  });

  it('other types have no patcher', () => {
    expect(SOURCE_PATCHERS.other).toBeNull();
  });
});

describe('OS install pinning', () => {
  it('handles continuations, chains and quotes, and leaves other packages alone', () => {
    const df = 'RUN apt-get update && apt-get install -y \\\n    "curl" curl-dev \\\n  && echo curl\n';
    const out = pinInInstallCommands(df, { tools: /^apt-get$/, verbs: new Set(['install']), names: (c, p) => c === p || c.startsWith(`${p}=`), pin: (p, v) => `${p}=${v}` }, 'curl', '8.0-1')!;
    expect(out).toBe('RUN apt-get update && apt-get install -y \\\n    "curl=8.0-1" curl-dev \\\n  && echo curl\n');
  });
});

describe('Stage 1 Dockerfile helpers', () => {
  const D1 = `sha256:${'1'.repeat(64)}`;
  const D2 = `sha256:${'2'.repeat(64)}`;
  it('refreshes a digest-pinned FROM within its tag, never changing the tag', async () => {
    const df = `FROM ubuntu:26.10@${D1} AS build\nFROM build\nFROM alpine:3.20\n`;
    const asked: string[] = [];
    const out = await refreshPinnedBases(df, async (ref) => { asked.push(ref); return D2; });
    expect(asked).toEqual(['ubuntu:26.10']);
    expect(out.dockerfile).toBe(`FROM ubuntu:26.10@${D2} AS build\nFROM build\nFROM alpine:3.20\n`);
    expect(out.refreshed).toEqual([{ line: 0, from: `ubuntu:26.10@${D1}`, to: `ubuntu:26.10@${D2}` }]);
  });

  it('skips build-arg refs and unresolvable ones', async () => {
    const df = `FROM \${BASE}@${D1}\nFROM node:20@${D1}\n`;
    expect((await refreshPinnedBases(df, async () => null)).dockerfile).toBe(df);
  });

  it('knows the shared platform base and points it at a rebuilt one', () => {
    const df = 'FROM plugin-python-base:1.0\nRUN true\n';
    const base = sharedBaseOf(df)!;
    expect(base.key).toBe('python');
    expect(rewriteSharedBase(df, base, `reg:5000/system/plugin-python-base@${D2}`)).toBe(`FROM reg:5000/system/plugin-python-base@${D2}\nRUN true\n`);
    expect(sharedBaseOf('FROM debian:12\n')).toBeNull();
  });
});

describe('overlay layer', () => {
  const ref = `reg:5000/org-a/p@sha256:${'a'.repeat(64)}`;
  it('is one RUN as root, then the original user restored', () => {
    const df = overlayDockerfile({ baseRef: ref, user: '1000:1000', commands: ['apk add x'] })!;
    expect(df).toContain(`FROM ${ref}\nUSER root\nRUN ["/bin/sh","-c","set -eu; apk add x"]\nUSER 1000:1000`);
    expect(isSingleLayerOverlay(df)).toBe(true);
    expect(isSingleLayerOverlay(`${df}RUN echo two\n`)).toBe(false);
  });
  it('refuses unsafe input', () => {
    expect(overlayDockerfile({ baseRef: 'x:latest', user: '', commands: ['a'] })).toBeNull();
    expect(overlayDockerfile({ baseRef: ref, user: 'a;b', commands: ['a'] })).toBeNull();
    expect(overlayCommand({ ...targetOf(CANARY_FIXTURES[0]!), packageName: 'curl;rm' }, [])).toBeNull();
  });
  it('npm installs into the reported directory; compiled types have no overlay', () => {
    const f = CANARY_FIXTURES.find((x) => x.type === 'npm')!;
    expect(overlayCommand(targetOf(f), [{ path: '/app/node_modules/lodash/package.json', layerID: 'l' }])).toBe("(cd '/app' && npm install --no-save --ignore-scripts --no-audit --no-fund 'lodash@4.18.0')");
    expect(overlayCommand(targetOf(CANARY_FIXTURES.find((x) => x.type === 'go-module')!), [])).toBeNull();
  });
});

describe('diffs', () => {
  it('round-trips through applyPatch', () => {
    const before = new Map([['a.txt', 'one\ntwo\nthree\n'], ['b.txt', 'x\n']]);
    const after = new Map([['a.txt', 'one\nTWO\nthree\n'], ['b.txt', 'x\n'], ['c.txt', 'new\n']]);
    const diff = treeDiff(before, after);
    expect(diff).toContain('-two\n+TWO');
    expect(applyPatch(before, diff)).toEqual(after);
  });
  it('refuses paths outside the context', () => {
    expect(() => applyPatch(new Map(), fileDiff('../etc/passwd', null, 'x\n'))).toThrow('outside');
  });
});

describe('verification', () => {
  const f = fixtureFinding(CANARY_FIXTURES[0]!);
  const other = { ...f, id: 'CVE-NEW', packageName: 'openssl' };
  const contract: PluginContractShape = { pluginType: 'CodeBuildStep', commands: ['x'], installCommands: [], requiredMetadata: [], requiredVars: [], metadataTypes: {}, varsTypes: {}, secrets: [], env: {} };
  const cfg: ImageConfigFacts = { user: '1000', entrypoint: null, cmd: ['bash'], workingDir: '/app' };
  const base = { targeted: [f], original: [f], scan: { findings: [], waivedKeys: new Set<string>(), refusal: null }, contract: { before: contract, after: contract }, config: { before: cfg, after: cfg }, smoke: 'passed' as const, scope: { ok: true } };
  it('passes when the targeted finding is gone and nothing broke', () => {
    expect(verifyCandidate(base)).toMatchObject({ ok: true, cleared: [f] });
  });
  it('fails on a new Critical/High, a changed contract or config, a failed smokeTest, or an out-of-scope diff', () => {
    expect(verifyCandidate({ ...base, scan: { ...base.scan, findings: [other] } }).failure).toBe('new_findings');
    expect(verifyCandidate({ ...base, contract: { before: contract, after: { ...contract, commands: [] } } }).detail).toBe('CONTRACT_CHANGED');
    expect(verifyCandidate({ ...base, config: { before: cfg, after: { ...cfg, user: 'root' } } }).detail).toBe('IMAGE_CONFIG_CHANGED');
    expect(verifyCandidate({ ...base, smoke: 'failed' }).detail).toBe('SMOKE_TEST_FAILED');
    expect(verifyCandidate({ ...base, scope: { ok: false, detail: 'LINE_OUTSIDE_PACKAGES' } }).failure).toBe('patch_out_of_scope');
  });
  it('the same advisory on the patched package at a new version is still present, not new', () => {
    const still = { ...f, packageVersion: '9.9' };
    expect(verifyCandidate({ ...base, scan: { ...base.scan, findings: [still] } })).toMatchObject({ ok: false, failure: 'still_present', newFindings: [] });
  });
  it('scope: an unrelated line fails, a moved JSON comma does not', () => {
    const before = new Map([['package.json', '{\n  "a": 1\n}\n']]);
    expect(scopeCheck({ before, after: new Map([['package.json', '{\n  "a": 1,\n  "overrides": {\n    "lodash": "4.17.21"\n  }\n}\n']]), mentions: ['lodash'], lockfiles: [] })).toEqual({ ok: true });
    expect(scopeCheck({ before, after: new Map([['package.json', '{\n  "a": 2\n}\n']]), mentions: ['lodash'], lockfiles: [] }).ok).toBe(false);
  });
});
