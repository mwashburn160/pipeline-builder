// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `plugin test` (plugin-ecosystem W6): the plan (templates, env, secrets,
 * failureBehavior as the CodeBuild step applies them), the scripts run through
 * a real shell, and the docker flow against a fake `docker` — every failure
 * is red, never green.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.unstable_mockModule('../src/utils/output-utils.js', () => ({
  __esModule: true,
  printSuccess: jest.fn(),
  printWarning: jest.fn(),
  printInfo: jest.fn(),
  printError: jest.fn(),
  printKeyValue: jest.fn(),
  printSection: jest.fn(),
  printDebug: jest.fn(),
  fileExists: (p: string) => fs.existsSync(p),
  ensureOutputDirectory: (p: string) => fs.mkdirSync(p, { recursive: true }),
}));

const { Command } = await import('commander');
const {
  CONTAINER_WORKSPACE, PluginTestFailure, dockerRunArgs, outputPath, parseKeyValues, planPluginTest, prepareWorkspace,
  runPluginTest, testPlugin,
} = await import('../src/commands/test-plugin.js');
const { resolveScaffoldInput, scaffoldFiles } = await import('../src/commands/new-plugin.js');
const docker = await import('../src/utils/plugin-docker.js');

type Exec = import('../src/utils/plugin-docker.js').Exec;
type ExecResult = import('../src/utils/plugin-docker.js').ExecResult;

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-test-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const BASE_SPEC = {
  name: 'demo',
  version: '0.1.0',
  category: 'quality',
  failureBehavior: 'fail',
  timeout: 5,
  primaryOutputDirectory: 'out',
  installCommands: ['mkdir -p out'],
  commands: ['echo hi > out/r.txt'],
};

describe('parseKeyValues', () => {
  it('splits on the first =', () => {
    expect(parseKeyValues(['A=1', 'B=x=y'], '--env')).toEqual({ A: '1', B: 'x=y' });
    expect(parseKeyValues(undefined, '--env')).toEqual({});
    expect(() => parseKeyValues(['nope'], '--env')).toThrow(/KEY=VALUE/);
  });
});

describe('planPluginTest', () => {
  it('resolves templates and merges env: spec ← metadata ← --env', () => {
    const plan = planPluginTest({
      ...BASE_SPEC,
      requiredMetadata: ['stage'],
      env: { A: 'spec', STAGE: '{{ pipeline.metadata.stage }}', B: 'spec' },
      metadata: { 'B': 'meta', 'aws:cdk:x': 'hidden' },
      commands: ['echo {{ pipeline.vars.who | default: "world" }}'],
    }, { metadata: { stage: 'dev' }, env: { A: 'flag' } }, {});
    expect(plan.env).toEqual({ A: 'flag', STAGE: 'dev', B: 'meta', stage: 'dev' });
    expect(plan.buildScript).toContain('echo world');
    expect(plan.installScript.split('\n').slice(0, 2)).toEqual(['set -e', 'export WORKDIR=${WORKDIR:-./}; cd ${WORKDIR}']);
    expect(plan.timeoutMs).toBe(300_000);
    expect(plan.smokeTest).toBeUndefined();
  });

  it('turns an unresolvable template into a red failure with the fix', () => {
    expect(() => planPluginTest({ ...BASE_SPEC, commands: ['echo {{ pipeline.metadata.missing }}'] }, {}, {}))
      .toThrow(/--metadata KEY=VALUE/);
  });

  it('passes secrets by NAME only and refuses a missing required one', () => {
    const spec = { ...BASE_SPEC, secrets: [{ name: 'TOKEN', required: true }, { name: 'OPT', required: false }] };
    expect(() => planPluginTest(spec, {}, {})).toThrow(/TOKEN/);
    const plan = planPluginTest(spec, { env: { TOKEN: 'leak' } }, { TOKEN: 's3cret' });
    expect(plan.secretNames).toEqual(['TOKEN']);
    expect(plan.missingOptionalSecrets).toEqual(['OPT']);
    const args = dockerRunArgs('img', '/ws', plan, 'true');
    expect(args.join(' ')).not.toContain('s3cret');
    expect(args.join(' ')).not.toContain('leak');
    expect(args).toEqual(expect.arrayContaining(['-e', 'TOKEN', '--entrypoint', '/bin/sh', 'img']));
  });

  it('applies failureBehavior, except a security plugin always fails', () => {
    expect(planPluginTest({ ...BASE_SPEC, failureBehavior: 'ignore' }, {}, {}).buildScript).toContain('|| true');
    const sec = planPluginTest({ ...BASE_SPEC, category: 'security', failureBehavior: 'ignore' }, {}, {});
    expect(sec.failureBehavior).toBe('fail');
    expect(sec.buildScript).not.toContain('|| true');
  });

  const sh = (script: string, cwd: string) => spawnSync('sh', ['-c', script], { cwd, encoding: 'utf-8' });

  it('the scripts run in a real shell as the step would (fail stays red, warn/ignore continue)', () => {
    const failing = { ...BASE_SPEC, commands: ['false', 'echo after > out/after.txt'] };
    fs.mkdirSync(path.join(tmp, 'out'));
    expect(sh(planPluginTest(failing, {}, {}).buildScript, tmp).status).not.toBe(0);
    expect(fs.existsSync(path.join(tmp, 'out/after.txt'))).toBe(false);
    expect(sh(planPluginTest({ ...failing, failureBehavior: 'warn' }, {}, {}).buildScript, tmp).status).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'out/after.txt'))).toBe(true);
  });
});

describe('workspace helpers', () => {
  it('copies the sample workspace and opens it to the container user', () => {
    const src = path.join(tmp, 'src');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'sub/a.txt'), 'x');
    fs.writeFileSync(path.join(src, 'run.sh'), '#!/bin/sh', { mode: 0o755 });
    fs.symlinkSync('/etc/hosts', path.join(src, 'link'));
    const ws = prepareWorkspace(src);
    try {
      expect(fs.readFileSync(path.join(ws, 'sub/a.txt'), 'utf-8')).toBe('x');
      expect(fs.statSync(path.join(ws, 'sub')).mode % 0o1000).toBe(0o777);
      expect(fs.statSync(path.join(ws, 'sub/a.txt')).mode % 0o1000).toBe(0o666);
      expect(fs.statSync(path.join(ws, 'run.sh')).mode % 0o1000).toBe(0o777);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
    expect(() => prepareWorkspace(path.join(tmp, 'missing'))).toThrow(/--workspace/);
  });

  it('locates the output under a relative or /workspace WORKDIR', () => {
    expect(outputPath('/ws', { env: {}, primaryOutputDirectory: 'o' })).toBe('/ws/o');
    expect(outputPath('/ws', { env: { WORKDIR: 'app' }, primaryOutputDirectory: 'o' })).toBe('/ws/app/o');
    expect(outputPath('/ws', { env: { WORKDIR: `${CONTAINER_WORKSPACE}/app` }, primaryOutputDirectory: 'o' })).toBe('/ws/app/o');
    expect(outputPath('/ws', { env: { WORKDIR: '/opt' }, primaryOutputDirectory: 'o' })).toBeNull();
    expect(outputPath('/ws', { env: {}, primaryOutputDirectory: undefined })).toBeNull();
  });
});

describe('plugin docker helpers', () => {
  it('builds with buildx when present, else docker build', () => {
    const calls: string[][] = [];
    const exec: Exec = (_c, args) => { calls.push(args); return { status: args[0] === 'buildx' && args[1] === 'version' ? 1 : 0, stdout: '', stderr: '' }; };
    expect(docker.buildPluginImage(exec, { dir: '/d', dockerfile: '/d/Dockerfile', tag: 't', buildArgs: { A: '1' } })).toBeNull();
    expect(calls[1]).toEqual(['build', '-t', 't', '-f', '/d/Dockerfile', '--build-arg', 'A=1', '/d']);
    const fail: Exec = (_c, args) => ({ status: args[1] === 'version' ? 0 : 2, stdout: '', stderr: '' });
    expect(docker.buildPluginImage(fail, { dir: '/d', dockerfile: 'D', tag: 't' })).toMatch(/build failed.*--image/);
  });

  it('reads the image user and knows root', () => {
    expect(docker.imageUser(() => ({ status: 0, stdout: '1000:1000\n', stderr: '' }), 'i')).toEqual({ user: '1000:1000' });
    expect(docker.imageUser(() => ({ status: 1, stdout: '', stderr: 'no such image' }), 'i')).toEqual({ error: expect.stringContaining('no such image') });
    expect(['', 'root', '0:0', ' 0'].map(docker.isRootUser)).toEqual([true, true, true, true]);
    expect(docker.isRootUser('1000:1000')).toBe(false);
    expect(docker.localImageTag('My Plugin', '1.0')).toMatch(/^pipeline-manager-test\/my-plugin-1\.0:[0-9a-f]{8}$/);
  });

  it('spawnExec runs a program and captures its output', () => {
    const r = docker.spawnExec('sh', ['-c', 'echo out; echo err >&2; exit 3'], { env: { X: '1' } });
    expect(r).toMatchObject({ status: 3, stdout: 'out\n', stderr: 'err\n' });
    expect(docker.spawnExec('definitely-not-a-program-xyz', []).error).toBeDefined();
  });
});

/** A scaffolded plugin on disk. */
function plugin(opts: Record<string, string> = {}, patch?: (spec: string) => string): string {
  const input = resolveScaffoldInput({ name: 'demo-lint', category: 'quality', ...opts });
  const dir = path.join(tmp, input.name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(scaffoldFiles(input))) fs.writeFileSync(path.join(dir, f), f === 'plugin-spec.yaml' && patch ? patch(c) : c);
  return dir;
}

/** A `run-logged` stand-in (the base image's helper) on a scratch PATH. */
function binDir(): string {
  const bin = path.join(tmp, '.bin');
  if (!fs.existsSync(bin)) {
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'run-logged'), '#!/bin/sh\nlog=$1; shift; [ "$1" = "--" ] && shift; "$@" > "$log"\n', { mode: 0o755 });
  }
  return bin;
}

/**
 * A fake `docker`: records calls; `run` phases execute their script in a real
 * shell against the mounted workspace (so outputs appear on the host).
 */
function fakeDocker(over: { user?: string; failPhase?: 'install' | 'build'; smoke?: number; noDocker?: boolean; build?: number } = {}) {
  const calls: string[][] = [];
  const exec: Exec = (cmd, args): ExecResult => {
    calls.push([cmd, ...args]);
    if (cmd !== 'docker' || over.noDocker) return { status: null, stdout: '', stderr: '', error: new Error('ENOENT') };
    if (args[0] === '--version' || (args[0] === 'buildx' && args[1] === 'version')) return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'buildx' || args[0] === 'build') return { status: over.build ?? 0, stdout: '', stderr: '' };
    if (args[0] === 'image') return { status: 0, stdout: `${over.user ?? '1000:1000'}\n`, stderr: '' };
    if (args[0] === 'load') return { status: 0, stdout: 'Loaded image: demo:local\n', stderr: '' };
    if (args[0] === 'rmi') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'run') {
      const script = args[args.length - 1]!;
      if (args.includes('/bin/bash')) return { status: over.smoke ?? 0, stdout: '', stderr: '' };
      const ws = args[args.indexOf('-v') + 1]!.split(':')[0]!;
      const phase = script.includes('mkdir -p') ? 'install' : 'build';
      if (over.failPhase === phase) return { status: 1, stdout: '', stderr: '' };
      const r = spawnSync('sh', ['-c', script], { cwd: ws, encoding: 'utf-8', env: { ...process.env, PATH: `${binDir()}:${process.env.PATH}` } });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

describe('runPluginTest', () => {
  it('builds the image, runs install + build, checks the output and runs the smokeTest', async () => {
    const { exec, calls } = fakeDocker();
    const result = await runPluginTest({ dir: plugin() }, exec);
    expect(result.outputFiles).toBe(1);
    const verbs = calls.filter(c => c[0] === 'docker').map(c => c[1]);
    expect(verbs).toEqual(expect.arrayContaining(['buildx', 'image', 'run', 'rmi']));
    expect(calls.some(c => c.includes('/bin/bash') && c.includes('bash --version && jq --version'))).toBe(true);
  });

  it.each([
    [{ failPhase: 'install' as const }, /install phase failed/],
    [{ failPhase: 'build' as const }, /build phase failed/],
    [{ user: 'root' }, /runs as root/],
    [{ user: '' }, /runs as root/],
    [{ smoke: 1 }, /smokeTest failed/],
    [{ noDocker: true }, /docker is not available/],
    [{ build: 1 }, /image build failed/],
  ])('is red on %p', async (over, reason) => {
    const { exec } = fakeDocker(over);
    await expect(runPluginTest({ dir: plugin() }, exec)).rejects.toThrow(reason);
  });

  it('is red when the output directory is missing or empty', async () => {
    const empty = plugin({}, s => s.replace(/run-logged \S+ -- echo "demo-lint ran"/, 'true'));
    await expect(runPluginTest({ dir: empty }, fakeDocker().exec)).rejects.toThrow(/is empty/);
    fs.rmSync(empty, { recursive: true });
    const none = plugin({}, s => s.replace('  - mkdir -p demo-lint-reports', '  - "true"').replace(/run-logged \S+ -- echo "demo-lint ran"/, 'true'));
    await expect(runPluginTest({ dir: none }, fakeDocker().exec)).rejects.toThrow(/was not created/);
  });

  it('refuses an invalid plugin, an approval step and a metadata_only plugin without --image', async () => {
    const bad = plugin({}, s => s.replace('computeType: SMALL', 'computeType: HUGE'));
    await expect(runPluginTest({ dir: bad }, fakeDocker().exec)).rejects.toThrow(/validation problem/);
    fs.rmSync(bad, { recursive: true });
    await expect(runPluginTest({ dir: plugin({ type: 'ManualApprovalStep' }) }, fakeDocker().exec)).rejects.toThrow(/nothing to test/);
    const meta = path.join(tmp, 'meta');
    fs.mkdirSync(meta);
    fs.writeFileSync(path.join(meta, 'config.yaml'), 'buildType: metadata_only\n');
    fs.writeFileSync(path.join(meta, 'plugin-spec.yaml'), 'name: meta\nversion: 1.0.0\ncommands: [echo]\n');
    await expect(runPluginTest({ dir: meta }, fakeDocker().exec)).rejects.toThrow(/--image/);
    await expect(runPluginTest({ dir: meta, image: 'demo:1' }, fakeDocker().exec)).resolves.toEqual({ outputFiles: null });
  });

  it('loads a prebuilt image.tar and keeps the workspace with --keep', async () => {
    const dir = plugin();
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'buildType: prebuilt\n');
    fs.writeFileSync(path.join(dir, 'image.tar'), 'x');
    const { exec, calls } = fakeDocker();
    await runPluginTest({ dir, keep: true }, exec);
    expect(calls.some(c => c[1] === 'load')).toBe(true);
    expect(calls.some(c => c[1] === 'rmi')).toBe(false);
  });
});

describe('plugin test (command)', () => {
  it('exits non-zero on a failure', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const program = new Command();
    program.exitOverride();
    testPlugin(program);
    await expect(program.parseAsync(['node', 'cli', 'test', '--dir', path.join(tmp, 'missing')])).rejects.toThrow('exit 2');
    exitSpy.mockRestore();
    expect(PluginTestFailure.name).toBe('PluginTestFailure');
  });
});
