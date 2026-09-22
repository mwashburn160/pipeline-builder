// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `plugin new` (plugin-ecosystem W6): the scaffold must pass `plugin validate`
 * (the server's schemas + the catalog lint) and deploy/bin/test-plugins.sh's
 * static checks out of the box, for every base image. The base and icon lists
 * the CLI ships must match deploy/plugins.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  displayNameOf, licenseText, newPlugin, resolveScaffoldInput, scaffoldFiles, scaffoldKeywords,
} = await import('../src/commands/new-plugin.js');
const { CURATED_ICON_KEYS } = await import('../src/config/plugin-catalog-assets.js');
const { PLUGIN_BASE_IMAGES } = await import('@pipeline-builder/api-core');
const { validatePluginDir, catalogIssues } = await import('../src/commands/validate-plugin.js');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PLUGINS = path.join(REPO, 'deploy/plugins');

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-new-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** Write a scaffold under `<tmp>/<category>/<name>` (test-plugins.sh's layout). */
function scaffold(opts: Record<string, string>): string {
  const input = resolveScaffoldInput(opts);
  const dir = path.join(tmp, input.category, input.name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(scaffoldFiles(input))) fs.writeFileSync(path.join(dir, f), c);
  return dir;
}

describe('resolveScaffoldInput', () => {
  it('applies defaults', () => {
    const input = resolveScaffoldInput({ name: 'my-lint', category: 'quality' }, new Date('2026-01-02T00:00:00Z'));
    expect(input).toMatchObject({
      base: expect.objectContaining({ key: 'plugin', image: 'pipeline-plugin-base:24.04' }),
      license: 'Apache-2.0',
      icon: null,
      pluginType: 'CodeBuildStep',
      computeType: 'SMALL',
      year: 2026,
      author: 'The my-lint authors',
      summary: 'My Lint as a pipeline step.',
    });
  });

  it.each([
    [{ name: 'Bad_Name', category: 'quality' }, /--name/],
    [{ name: 'x', category: 'general' }, /--category/],
    [{ name: 'x', category: 'quality', base: 'cobol' }, /--base/],
    [{ name: 'x', category: 'quality', type: 'Lambda' }, /--type/],
    [{ name: 'x', category: 'quality', compute: 'HUGE' }, /--compute/],
    [{ name: 'x', category: 'quality', license: 'WTFPL' }, /--license/],
    [{ name: 'x', category: 'quality', icon: 'acme' }, /--icon/],
    [{ name: 'x', category: 'quality', summary: 'y'.repeat(161) }, /--summary/],
  ])('refuses %p', (opts, reason) => {
    expect(() => resolveScaffoldInput(opts)).toThrow(reason);
  });

  it('keywords: the category plus the name words, deduplicated', () => {
    expect(scaffoldKeywords('go-lint-go', 'quality')).toEqual(['quality', 'go', 'lint']);
    expect(displayNameOf('my-cool-scan')).toBe('My Cool Scan');
  });

  it('LICENSE: MIT in full, Apache notice, others by SPDX link', () => {
    expect(licenseText({ license: 'MIT', year: 2026, author: 'Acme' })).toContain('Permission is hereby granted');
    expect(licenseText({ license: 'Apache-2.0', year: 2026, author: 'Acme' })).toContain('http://www.apache.org/licenses/LICENSE-2.0');
    expect(licenseText({ license: 'MPL-2.0', year: 2026, author: 'Acme' })).toContain('https://spdx.org/licenses/MPL-2.0.html');
  });
});

describe('the scaffold passes plugin validate out of the box', () => {
  it.each(PLUGIN_BASE_IMAGES.map(b => [b.key]))('base %s', async (base) => {
    const dir = scaffold({ name: `sample-${base}`, category: 'quality', base });
    const report = await validatePluginDir(dir, { lint: true });
    expect(report.problems).toEqual([]);
    expect(report.lint.filter(l => l.level === 'error')).toEqual([]);
    expect(report.lint).toEqual([]);
    const { invalid, missingForPublish } = catalogIssues(report.fields);
    expect(invalid).toEqual([]);
    expect(missingForPublish).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf-8')).toMatch(/\nUSER 1000:1000\nCMD \["bash"\]\n$/);
  });

  it('detects the catalog fields from the scaffold (spec, README, generated)', async () => {
    const dir = scaffold({ name: 'acme-scan', category: 'security', icon: 'trivy', license: 'MIT' });
    const byField = Object.fromEntries((await validatePluginDir(dir, { lint: false })).fields.map(f => [f.field, f]));
    expect(byField.displayName).toMatchObject({ value: 'Acme Scan', source: 'readme' });
    expect(byField.summary).toMatchObject({ value: 'Acme Scan as a pipeline step.', source: 'spec' });
    expect(byField.license).toMatchObject({ value: 'MIT', source: 'spec' });
    expect(byField.icon).toMatchObject({ value: { key: 'trivy' }, source: 'spec' });
    expect(byField.changelog).toMatchObject({ source: 'spec' });
    expect(byField.readme).toMatchObject({ source: 'readme' });
  });

  it('a ManualApprovalStep scaffold has no Dockerfile and still validates', async () => {
    const dir = scaffold({ name: 'hold-on', category: 'infrastructure', type: 'ManualApprovalStep' });
    expect(fs.existsSync(path.join(dir, 'Dockerfile'))).toBe(false);
    const report = await validatePluginDir(dir, { lint: true });
    expect(report.problems).toEqual([]);
    expect(report.lint).toEqual([]);
  });
});

/**
 * test-plugins.sh needs a REAL yq (it reads specs by absolute path from /tmp);
 * a dockerized `yq` wrapper that only sees $PWD can't, and the script then
 * fails every plugin. Run these only where yq can read an absolute path.
 */
function realYq(): boolean {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yq-probe-'));
  try {
    fs.writeFileSync(path.join(probeDir, 'p.yaml'), 'a: 1\n');
    const r = spawnSync('yq', ['eval', '.a', path.join(probeDir, 'p.yaml')], { cwd: os.tmpdir(), encoding: 'utf-8' });
    return r.status === 0 && r.stdout.trim() === '1' && spawnSync('bash', ['--version']).status === 0;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

(realYq() ? describe : describe.skip)('the scaffold passes test-plugins.sh static checks', () => {
  it.each([['plugin'], ['node'], ['python']])('base %s', (base) => {
    scaffold({ name: `tp-${base}`, category: 'testing', base });
    const r = spawnSync('bash', [path.join(REPO, 'deploy/bin/test-plugins.sh'), `testing/tp-${base}`], {
      env: { ...process.env, PLUGINS_DIR: tmp, NO_COLOR: '1' },
      encoding: 'utf-8',
    });
    expect({ status: r.status, out: r.stdout.includes('FAIL') ? r.stdout : '' }).toEqual({ status: 0, out: '' });
  });

  it('and a ManualApprovalStep', () => {
    scaffold({ name: 'tp-approve', category: 'infrastructure', type: 'ManualApprovalStep' });
    const r = spawnSync('bash', [path.join(REPO, 'deploy/bin/test-plugins.sh'), 'infrastructure/tp-approve'], {
      env: { ...process.env, PLUGINS_DIR: tmp }, encoding: 'utf-8',
    });
    expect(r.status).toBe(0);
  });
});

describe('the lists the CLI ships match deploy/plugins', () => {
  it('bases: one per _base directory, with the tag its Dockerfile names', () => {
    const dirs = fs.readdirSync(path.join(PLUGINS, '_base')).filter(d => fs.existsSync(path.join(PLUGINS, '_base', d, 'Dockerfile'))).sort();
    expect(PLUGIN_BASE_IMAGES.map(b => b.dir).sort()).toEqual(dirs);
    for (const b of PLUGIN_BASE_IMAGES) {
      const header = fs.readFileSync(path.join(PLUGINS, '_base', b.dir, 'Dockerfile'), 'utf-8');
      expect(/Buil(?:d target|t) tag: (\S+)/.exec(header)?.[1]).toBe(b.image);
      expect(b.image).toMatch(new RegExp(`^pipeline-${b.key}-base:`));
    }
  });

  it('icons: one key per curated SVG', () => {
    const svgs = fs.readdirSync(path.join(PLUGINS, '_icons')).filter(f => f.endsWith('.svg')).map(f => f.replace(/\.svg$/, '')).sort();
    expect([...CURATED_ICON_KEYS].sort()).toEqual(svgs);
  });
});

describe('plugin new (command)', () => {
  let exitSpy: ReturnType<typeof jest.spyOn>;
  let logSpy: ReturnType<typeof jest.spyOn>;
  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => { exitSpy.mockRestore(); logSpy.mockRestore(); });

  const run = async (...args: string[]) => {
    const program = new Command();
    program.exitOverride();
    newPlugin(program);
    await program.parseAsync(['node', 'cli', 'new', ...args]);
  };

  it('writes the plugin files', async () => {
    const dir = path.join(tmp, 'out');
    await run('--name', 'my-lint', '--category', 'quality', '--base', 'node', '--dir', dir, '--icon', 'eslint');
    expect(fs.readdirSync(dir).sort()).toEqual(['Dockerfile', 'LICENSE', 'README.md', 'config.yaml', 'plugin-spec.yaml']);
    expect(fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf-8')).toContain('FROM pipeline-node-base:1.0');
    expect(fs.readFileSync(path.join(dir, 'plugin-spec.yaml'), 'utf-8')).toContain('icon: eslint');
  });

  it('refuses an existing directory without --force, and a bad flag', async () => {
    const dir = path.join(tmp, 'exists');
    fs.mkdirSync(dir);
    await expect(run('--name', 'x', '--category', 'quality', '--dir', dir)).rejects.toThrow('exit 2');
    await expect(run('--name', 'x', '--category', 'quality', '--dir', dir, '--force')).resolves.toBeUndefined();
    await expect(run('--name', 'x', '--category', 'nope', '--dir', path.join(tmp, 'n'))).rejects.toThrow('exit 2');
  });

  it('--list-bases prints every base and writes nothing', async () => {
    await run('--list-bases');
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    for (const b of PLUGIN_BASE_IMAGES) expect(out).toContain(b.image);
  });
});
