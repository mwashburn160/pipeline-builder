// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `plugin validate`: the server's schemas (shared
 * from api-core), the template contract, and the catalog report — which field
 * would be empty or invalid, and where each value would come from.
 */

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
}));

const { Command } = await import('commander');
const { catalogIssues, printCatalogReport, validatePlugin, validatePluginDir } = await import('../src/commands/validate-plugin.js');
const { formatCatalogValue, readPluginPackage, templateProblems } = await import('../src/utils/plugin-package.js');

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-validate-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const SPEC = [
  'name: acme-scan', 'version: 1.2.0', 'category: security', 'pluginType: CodeBuildStep', 'computeType: SMALL',
  'primaryOutputDirectory: out', 'commands:', '  - echo scan', '',
].join('\n');

function write(files: Record<string, string>): string {
  const dir = path.join(tmp, 'p');
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  return dir;
}

const byField = (fields: Array<{ field: string }>) => Object.fromEntries(fields.map(f => [f.field, f]));

describe('validatePluginDir — server checks', () => {
  it('passes a minimal valid plugin and reports what is still missing for publishing', async () => {
    const r = await validatePluginDir(write({ 'plugin-spec.yaml': SPEC, 'Dockerfile': 'FROM x\n' }), { lint: false });
    expect(r.problems).toEqual([]);
    expect(catalogIssues(r.fields).missingForPublish.map(f => f.field)).toEqual(['license', 'readme']);
  });

  it('reports the server schema issues, required fields, name/version rules and missing Dockerfile', async () => {
    const spec = 'name: Bad_Name\nversion: "1.0"\ncomputeType: HUGE\nlicense: WTFPL\nsurprise: 1\n';
    const r = await validatePluginDir(write({ 'plugin-spec.yaml': spec }), { lint: false });
    const text = r.problems.join('\n');
    expect(text).toMatch(/^plugin-spec\.yaml: .*computeType/m);
    expect(text).toContain('license: must be a supported SPDX');
    expect(text).toMatch(/\(root\): .*surprise/);
    expect(text).toContain('name, version, and commands are required');
    expect(text).toContain('name must match');
    expect(text).toContain('version must be semver');
    expect(text).toContain('Dockerfile not found');
  });

  it('checks config.yaml with the server schema and the build-type prerequisites', async () => {
    const bad = await validatePluginDir(write({ 'plugin-spec.yaml': SPEC, 'config.yaml': 'buildType: prebuilt\ndockerfile: Dockerfile\n' }), { lint: false });
    expect(bad.problems.join()).toContain('config.yaml: dockerfile is not allowed when buildType is prebuilt');
    fs.rmSync(path.join(tmp, 'p'), { recursive: true });
    const prebuilt = await validatePluginDir(write({ 'plugin-spec.yaml': SPEC, 'config.yaml': 'buildType: prebuilt\n' }), { lint: false });
    expect(prebuilt.problems).toEqual(['image.tar not found for buildType prebuilt']);
    fs.rmSync(path.join(tmp, 'p'), { recursive: true });
    const escape = await validatePluginDir(write({ 'plugin-spec.yaml': SPEC, 'config.yaml': 'dockerfile: ../Dockerfile\n' }), { lint: false });
    expect(escape.problems.join()).toContain('dockerfile must be a relative path inside the plugin directory');
  });

  it('reports invalid YAML and a missing directory or spec', async () => {
    const r = await validatePluginDir(write({ 'plugin-spec.yaml': 'name: [unclosed\n', 'Dockerfile': 'FROM x' }), { lint: false });
    expect(r.problems.join()).toContain('invalid YAML');
    expect(() => readPluginPackage(path.join(tmp, 'nope'))).toThrow(/Not a directory/);
    fs.mkdirSync(path.join(tmp, 'empty'));
    expect(() => readPluginPackage(path.join(tmp, 'empty'))).toThrow(/Missing plugin spec/);
  });

  it('applies the template contract', async () => {
    const problems = await templateProblems({
      commands: ['echo {{ pipeline.metadata.env }} {{ pipeline.vars.n | number }} {{ bogus.x }}'],
      requiredVars: ['n'],
    });
    expect(problems.join('\n')).toMatch(/pipeline\.metadata\.env is not declared in .requiredMetadata./);
    expect(problems.join('\n')).toMatch(/declared type is 'string'/);
    expect(problems.join('\n')).toMatch(/template \[commands\[0\]:1:\d+\] .*unknown scope root 'bogus'/);
  });
});

describe('validatePluginDir — malware heuristics', () => {
  it('runs the anonymous-submission heuristics over every file, lint or not', async () => {
    const clean = await validatePluginDir(write({ 'plugin-spec.yaml': SPEC, 'Dockerfile': 'FROM x\n' }), { lint: false });
    expect(clean.heuristics).toEqual([]);
    const r = await validatePluginDir(write({
      'plugin-spec.yaml': SPEC,
      'Dockerfile': 'FROM x\n',
      'scripts/run.sh': 'curl -s http://169.254.169.254/latest/meta-data/\n',
      'README.md': 'Needs AWS_SECRET_ACCESS_KEY.\n',
    }), { lint: false });
    expect(r.heuristics.map((h) => `${h.id}:${h.severity}:${h.path}`)).toEqual([
      'credential-access:medium:README.md',
      'credential-access:high:scripts/run.sh',
    ]);
  });
});

describe('validatePluginDir — catalog detection', () => {
  it('reports each field with the source the server would use', async () => {
    const r = await validatePluginDir(write({
      'plugin-spec.yaml': `${SPEC}license: MIT\nhomepageUrl: http://insecure.example.com\n`,
      'README.md': '# Acme Scanner\n\nScans code for secrets. Fast.\n',
      'Dockerfile': 'FROM x\nLABEL org.opencontainers.image.source="https://github.com/acme/scan" org.opencontainers.image.documentation="https://bit.ly/x"\n',
    }), { lint: false });
    const f = byField(r.fields);
    expect(f.displayName).toMatchObject({ value: 'Acme Scanner', source: 'readme' });
    expect(f.description).toMatchObject({ value: 'Scans code for secrets. Fast.', source: 'readme' });
    expect(f.summary).toMatchObject({ value: 'Scans code for secrets.', source: 'derived' });
    expect(f.license).toMatchObject({ value: 'MIT', source: 'spec' });
    expect(f.sourceUrl).toMatchObject({ value: 'https://github.com/acme/scan', source: 'dockerfile' });
    expect(f.homepageUrl).toMatchObject({ value: null, source: 'spec', error: 'must use https' });
    expect(f.documentationUrl).toMatchObject({ value: null, source: 'dockerfile', error: expect.stringContaining('shortener') });
    expect(catalogIssues(r.fields).invalid.map(x => x.field)).toEqual(['homepageUrl', 'documentationUrl']);

    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    printCatalogReport(r.fields);
    const out = log.mock.calls.map(c => String(c[0])).join('\n');
    log.mockRestore();
    expect(out).toContain('invalid — must use https');
    expect(out).toContain('[README]');
    expect(out).toContain('[Dockerfile label]');
  });

  it('still detects descriptive fields when the spec fails the schema', async () => {
    const r = await validatePluginDir(write({ 'plugin-spec.yaml': `${SPEC}computeType: HUGE\nsummary: One line.\n`.replace('computeType: SMALL\n', ''), 'Dockerfile': 'FROM x' }), { lint: false });
    expect(r.problems.length).toBeGreaterThan(0);
    expect(byField(r.fields).summary).toMatchObject({ value: 'One line.', source: 'spec' });
  });

  it('formats values for one line', () => {
    expect(formatCatalogValue(null)).toBe('(empty)');
    expect(formatCatalogValue(['a', 'b'])).toBe('a, b');
    expect(formatCatalogValue({ key: 'snyk', badge: 'go' })).toBe('snyk (badge: go)');
    expect(formatCatalogValue({ other: 1 })).toBe('{"other":1}');
    expect(formatCatalogValue('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('plugin validate (command)', () => {
  let exitSpy: ReturnType<typeof jest.spyOn>;
  let logSpy: ReturnType<typeof jest.spyOn>;
  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => { exitSpy.mockRestore(); logSpy.mockRestore(); });

  const run = (...args: string[]) => {
    const program = new Command();
    program.exitOverride();
    validatePlugin(program);
    return program.parseAsync(['node', 'cli', 'validate', ...args]);
  };

  it('passes a valid plugin', async () => {
    await expect(run('--dir', write({ 'plugin-spec.yaml': SPEC, 'Dockerfile': 'FROM x\nWORKDIR /a\nUSER 1000:1000\n' }))).resolves.toBeDefined();
  });

  it('exits 1 on a problem, an invalid detected value or (with --lint) a lint error', async () => {
    await expect(run('--dir', write({ 'plugin-spec.yaml': SPEC.replace('SMALL', 'HUGE'), 'Dockerfile': 'FROM x' }))).rejects.toThrow('exit 1');
    fs.rmSync(path.join(tmp, 'p'), { recursive: true });
    await expect(run('--dir', write({ 'plugin-spec.yaml': `${SPEC}sourceUrl: http://x.io\n`, 'Dockerfile': 'FROM x' }))).rejects.toThrow('exit 1');
    fs.rmSync(path.join(tmp, 'p'), { recursive: true });
    await expect(run('--lint', '--dir', write({ 'plugin-spec.yaml': SPEC, 'Dockerfile': 'FROM x\nUSER root\n' }))).rejects.toThrow('exit 1');
  });

  it('--json prints the report', async () => {
    await expect(run('--json', '--dir', write({ 'plugin-spec.yaml': SPEC, 'Dockerfile': 'FROM x' }))).resolves.toBeDefined();
    const json = JSON.parse(String(logSpy.mock.calls.at(-1)![0]));
    expect(json).toMatchObject({ valid: true, problems: [], missingForPublish: ['license', 'readme'] });
    expect(json.catalog.map((f: { field: string }) => f.field)).toContain('summary');
    await expect(run('--json', '--dir', path.join(tmp, 'p'), '--lint')).rejects.toThrow('exit 1');
  });

  it('a missing directory is a validation error (exit 2)', async () => {
    await expect(run('--dir', path.join(tmp, 'missing'))).rejects.toThrow('exit 2');
  });
});
