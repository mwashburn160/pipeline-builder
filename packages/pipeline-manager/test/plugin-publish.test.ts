// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `plugin publish` (plugin-ecosystem W6, §3.1a): the local pre-flight, the
 * scan preview (never a silent pass), the accept-or-edit step (`--yes`,
 * `--metadata`, interactive), the zip, and the one upload that carries
 * `visibility=public`, `publishRequest=true` and the edits.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockCreateAuthenticatedClient = jest.fn();
const mockPrintWarning = jest.fn();

jest.unstable_mockModule('../src/utils/output-utils.js', () => ({
  __esModule: true,
  printSuccess: jest.fn(),
  printWarning: mockPrintWarning,
  printInfo: jest.fn(),
  printError: jest.fn(),
  printKeyValue: jest.fn(),
  printSection: jest.fn(),
  printDebug: jest.fn(),
  fileExists: (p: string) => fs.existsSync(p),
  ensureOutputDirectory: (p: string) => fs.mkdirSync(p, { recursive: true }),
}));

jest.unstable_mockModule('../src/utils/command-utils.js', () => ({
  __esModule: true,
  printCommandHeader: () => 'EXEC-TEST',
  printSslWarning: jest.fn(),
  createAuthenticatedClient: mockCreateAuthenticatedClient,
  withSslOptions: (cmd: unknown) => cmd,
}));

const { Command } = await import('commander');
const { PublishPreflightError, assertCanPublish, publishPlugin, runPublish, runScanPreview } = await import('../src/commands/publish-plugin.js');
const { resolveScaffoldInput, scaffoldFiles } = await import('../src/commands/new-plugin.js');
const { collectCatalogEdits, describeDetected, parseTypedValue, promptCatalogEdits, readMetadataFile } = await import('../src/utils/catalog-prompt.js');
const { scanPreview, summarizeGrype } = await import('../src/utils/plugin-scan.js');
const { collectPluginFiles, writeZip } = await import('../src/utils/plugin-zip.js');

type Exec = import('../src/utils/plugin-docker.js').Exec;

let tmp: string;
let logSpy: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-publish-'));
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); logSpy.mockRestore(); });

function plugin(opts: Record<string, string> = {}, patch?: (spec: string) => string): string {
  const input = resolveScaffoldInput({ name: 'acme-lint', category: 'quality', ...opts });
  const dir = path.join(tmp, input.name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(scaffoldFiles(input))) fs.writeFileSync(path.join(dir, f), f === 'plugin-spec.yaml' && patch ? patch(c) : c);
  return dir;
}

/** Read a zip back (stored + deflate only) to check the writer. */
function readZip(buf: Buffer): Record<string, string> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString();
    const size = buf.readUInt32LE(local + 18);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = zlib.inflateRawSync(buf.subarray(start, start + size));
    expect(zlib.crc32(data)).toBe(buf.readUInt32LE(p + 16));
    out[name] = data.toString();
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

describe('plugin zip', () => {
  it('packages the directory as the zip root, excluding build output and VCS state', () => {
    const dir = plugin();
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'lib/helper.sh'), 'echo hi');
    fs.writeFileSync(path.join(dir, 'image.tar'), 'tar');
    fs.writeFileSync(path.join(dir, 'plugin.zip'), 'old');
    fs.mkdirSync(path.join(dir, '.git'));
    const files = readZip(writeZip(collectPluginFiles(dir, { includeImageTar: false })));
    expect(Object.keys(files)).toEqual(['Dockerfile', 'LICENSE', 'README.md', 'config.yaml', 'lib/helper.sh', 'plugin-spec.yaml']);
    expect(files['lib/helper.sh']).toBe('echo hi');
    expect(Object.keys(readZip(writeZip(collectPluginFiles(dir, { includeImageTar: true }))))).toContain('image.tar');
  });

  it('is readable by unzip when available', () => {
    const dir = plugin();
    const zipPath = path.join(tmp, 'p.zip');
    fs.writeFileSync(zipPath, writeZip(collectPluginFiles(dir, { includeImageTar: false })));
    const r = spawnSync('unzip', ['-t', zipPath], { encoding: 'utf-8' });
    if (r.error) return; // no unzip on this host; readZip above covers the format
    expect(r.status).toBe(0);
  });

  it('refuses a symlink', () => {
    const dir = plugin();
    fs.symlinkSync('/etc/hosts', path.join(dir, 'hosts'));
    expect(() => collectPluginFiles(dir, { includeImageTar: false })).toThrow(/symlink/);
  });
});

describe('scan preview', () => {
  const grype = JSON.stringify({
    matches: [
      { vulnerability: { id: 'CVE-1', severity: 'Critical' }, artifact: { name: 'openssl', version: '1.0' } },
      { vulnerability: { id: 'CVE-2', severity: 'High' }, artifact: { name: 'zlib', version: '1' } },
      { vulnerability: { id: 'CVE-3', severity: 'weird' }, artifact: {} },
    ],
  });

  it('summarizes grype output', () => {
    expect(summarizeGrype(grype)).toEqual({
      counts: { Critical: 1, High: 1, Medium: 0, Low: 0, Negligible: 0, Unknown: 1 },
      critical: ['CVE-1 in openssl@1.0'],
    });
  });

  const tools = (over: Partial<Record<'docker' | 'syft' | 'grype' | 'sbom' | 'scan', number>> = {}, out = grype) => {
    const calls: string[][] = [];
    const exec: Exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      const missing = (t: 'docker' | 'syft' | 'grype') => over[t] === -1;
      if (cmd === 'docker') return missing('docker') ? { status: null, stdout: '', stderr: '', error: new Error('ENOENT') } : { status: 0, stdout: '', stderr: '' };
      if (cmd === 'syft') {
        if (missing('syft')) return { status: null, stdout: '', stderr: '', error: new Error('ENOENT') };
        return { status: args[0] === 'version' ? 0 : over.sbom ?? 0, stdout: '', stderr: 'syft broke' };
      }
      if (cmd === 'grype') {
        if (missing('grype')) return { status: null, stdout: '', stderr: '', error: new Error('ENOENT') };
        return { status: args[0] === 'version' ? 0 : over.scan ?? 0, stdout: args[0] === 'version' ? '' : out, stderr: 'grype broke' };
      }
      return { status: 1, stdout: '', stderr: '' };
    };
    return { exec, calls };
  };
  const opts = { dir: '/d', dockerfile: '/d/Dockerfile', buildType: 'build_image', name: 'n', version: '1.0.0' };

  it('scans a built image and cleans it up', () => {
    const { exec, calls } = tools();
    expect(runScanPreview(exec, opts)).toMatchObject({ status: 'scanned', critical: ['CVE-1 in openssl@1.0'] });
    expect(calls.some(c => c[0] === 'syft' && String(c[2]).startsWith('docker:pipeline-manager-test/n-1.0.0:'))).toBe(true);
    expect(calls.some(c => c[0] === 'docker' && c[1] === 'rmi')).toBe(true);
  });

  it.each([
    [{ syft: -1 }, 'unavailable', /syft and grype/],
    [{ grype: -1 }, 'unavailable', /syft and grype/],
    [{ docker: -1 }, 'unavailable', /docker is not available/],
    [{ sbom: 1 }, 'failed', /syft could not/],
    [{ scan: 1 }, 'failed', /grype could not/],
  ] as const)('%p → %s', (over, status, reason) => {
    const r = runScanPreview(tools(over).exec, opts);
    expect(r.status).toBe(status);
    expect((r as { reason: string }).reason).toMatch(reason);
  });

  it('a non-JSON grype result fails, and a metadata_only plugin needs --image', () => {
    expect(scanPreview(tools({}, 'not json').exec, 'img')).toMatchObject({ status: 'failed', reason: /not JSON/ });
    expect(runScanPreview(tools().exec, { ...opts, buildType: 'metadata_only' })).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/--image/) });
    expect(runScanPreview(tools().exec, { ...opts, image: 'given:1' })).toMatchObject({ status: 'scanned' });
  });
});

describe('accept-or-edit', () => {
  const detected = [
    { field: 'summary' as const, value: 'Lints.', source: 'spec' as const, error: null },
    { field: 'homepageUrl' as const, value: null, source: 'spec' as const, error: 'must use https' },
    { field: 'keywords' as const, value: ['a'], source: 'spec' as const, error: null },
    { field: 'icon' as const, value: null, source: null, error: null },
    { field: 'readme' as const, value: '# R', source: 'readme' as const, error: null },
  ];
  const asker = (answers: string[]) => jest.fn(async () => answers.shift() ?? '');

  it('describes each detected field with its source or why it is blank', () => {
    expect(describeDetected(detected[0]!)).toBe('summary: Lints.  [Spec]');
    expect(describeDetected(detected[1]!)).toBe('homepageUrl: (blank — detected Spec is invalid: must use https)');
    expect(describeDetected(detected[3]!)).toBe('icon: (empty)');
  });

  it('accepts, edits (re-asking on a bad value), clears and reads markdown from a file', async () => {
    const md = path.join(tmp, 'R.md');
    fs.writeFileSync(md, '# New readme');
    const ask = asker(['', 'e', 'http://bad', 'e', 'https://acme.dev', 'c', 'e', 'snyk:python', 'x', 'e', md]);
    const edits = await promptCatalogEdits(detected, ask);
    expect(edits).toEqual({ homepageUrl: 'https://acme.dev', keywords: null, icon: { key: 'snyk', badge: 'python' }, readme: '# New readme' });
  });

  it('parses typed values per field', () => {
    expect(parseTypedValue('keywords', 'a, b,,c')).toEqual(['a', 'b', 'c']);
    expect(parseTypedValue('icon', 'trivy')).toBe('trivy');
    expect(() => parseTypedValue('changelog', 'missing.md', tmp)).toThrow(/file not found/);
  });

  it('--metadata: validated edits, contract keys refused, no prompt', async () => {
    const file = path.join(tmp, 'meta.yaml');
    fs.writeFileSync(file, 'summary: Better.\nicon: trivy\nhomepageUrl: null\n');
    const ask = asker([]);
    expect(await collectCatalogEdits(detected, { metadataFile: file, ask })).toEqual({ summary: 'Better.', icon: { key: 'trivy' }, homepageUrl: null });
    expect(ask).not.toHaveBeenCalled();
    fs.writeFileSync(file, 'commands: [x]\nsummary: s\n');
    expect(() => readMetadataFile(file)).toThrow(/commands/);
    fs.writeFileSync(file, 'summary: [unclosed\n');
    expect(() => readMetadataFile(file)).toThrow(/invalid YAML/);
    expect(() => readMetadataFile(path.join(tmp, 'none.yaml'))).toThrow(/not found/);
  });

  it('--yes accepts everything; no terminal and no flag is refused', async () => {
    expect(await collectCatalogEdits(detected, { yes: true })).toEqual({});
    await expect(collectCatalogEdits(detected, {})).rejects.toThrow(/--yes .*--metadata/);
  });
});

describe('runPublish', () => {
  const noTools: Exec = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') });

  function client(state: Record<string, unknown> = {}) {
    const postForm = jest.fn<(url: string, form: { getBuffer: () => Buffer }) => Promise<unknown>>()
      .mockResolvedValue({ success: true, data: { pluginName: 'acme-lint', version: '0.1.0' } });
    const get = jest.fn<(url: string) => Promise<unknown>>().mockResolvedValue({
      success: true,
      data: { publisher: { handle: 'acme' }, isRootOrg: true, terms: { accepted: true }, publishingEnabled: true, ...state },
    });
    const c = { get, postForm, getConfig: () => ({ api: { pluginUrl: '/api/plugins', pluginUploadUrl: '/api/plugins/upload' } }) };
    return { c, get, postForm };
  }

  it('uploads once with visibility=public, publishRequest=true and the edits', async () => {
    const { c, get, postForm } = client();
    const meta = path.join(tmp, 'm.yaml');
    fs.writeFileSync(meta, 'summary: Lints everything.\n');
    const { edits, response } = await runPublish({ dir: plugin(), metadata: meta }, { exec: noTools, client: () => c as never });
    expect(edits).toEqual({ summary: 'Lints everything.' });
    expect(response).toEqual({ pluginName: 'acme-lint', version: '0.1.0' });
    expect(get).toHaveBeenCalledWith('/api/plugins/publisher');
    expect(postForm).toHaveBeenCalledTimes(1);
    const [url, form] = postForm.mock.calls[0]!;
    expect(url).toBe('/api/plugins/upload');
    const body = form.getBuffer().toString('latin1');
    expect(body).toMatch(/name="visibility"\r\n\r\npublic/);
    expect(body).toMatch(/name="publishRequest"\r\n\r\ntrue/);
    expect(body).toContain('{"summary":"Lints everything."}');
    expect(body).toMatch(/filename="acme-lint-0\.1\.0\.zip"/);
    expect(mockPrintWarning).toHaveBeenCalledWith(expect.stringContaining('Scan preview NOT run'));
  });

  it('asks before uploading interactively, and --dry-run uploads nothing', async () => {
    const { c, postForm } = client();
    const answers = ['', '', '', '', '', '', '', '', '', '', '', '', 'n'];
    await expect(runPublish({ dir: plugin() }, { exec: noTools, ask: async () => answers.shift() ?? '', client: () => c as never }))
      .rejects.toThrow(/Cancelled/);
    expect(postForm).not.toHaveBeenCalled();
    const dry = await runPublish({ dir: plugin(), yes: true, dryRun: true, skipScan: true }, { exec: noTools, client: () => c as never });
    expect(dry.response).toBeNull();
    expect(postForm).not.toHaveBeenCalled();
    expect(mockPrintWarning).toHaveBeenCalledWith(expect.stringContaining('--skip-scan'));
  });

  it('refuses at pre-flight: lint errors, a critical CVE, missing publish fields, publisher state', async () => {
    const { c } = client();
    const rootDir = plugin();
    fs.appendFileSync(path.join(rootDir, 'Dockerfile'), 'USER root\n');
    await expect(runPublish({ dir: rootDir, yes: true }, { exec: noTools, client: () => c as never })).rejects.toThrow(PublishPreflightError);
    fs.rmSync(rootDir, { recursive: true });

    const critical: Exec = (cmd, args) => ({
      status: 0,
      stderr: '',
      stdout: cmd === 'grype' && args[0] !== 'version' ? JSON.stringify({ matches: [{ vulnerability: { id: 'CVE-9', severity: 'Critical' }, artifact: { name: 'x', version: '1' } }] }) : '',
    });
    await expect(runPublish({ dir: plugin(), yes: true }, { exec: critical, client: () => c as never })).rejects.toThrow(/critical vulnerabilit/);

    const noLicense = plugin({}, s => s.replace(/^license: .*$/m, ''));
    await expect(runPublish({ dir: noLicense, yes: true, skipScan: true }, { client: () => c as never })).rejects.toThrow(/needs: license/);
  });

  it.each([
    [{ publishingEnabled: false }, /turned off/],
    [{ isRootOrg: false }, /root organization/],
    [{ publisher: null }, /publisher profile/],
    [{ terms: { accepted: false } }, /publisher terms/],
  ])('assertCanPublish refuses %p', async (state, reason) => {
    await expect(assertCanPublish(client(state).c as never)).rejects.toThrow(reason);
  });
});

describe('plugin publish (command)', () => {
  it('uploads with --yes and reports the request; exits non-zero on a refusal', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const postForm = jest.fn<() => Promise<unknown>>().mockResolvedValue({ data: { pluginName: 'acme-lint', version: '0.1.0', publishRequest: { requestId: 'r1', status: 'pending' } } });
    mockCreateAuthenticatedClient.mockReturnValue({
      get: async () => ({ data: { publisher: { handle: 'acme' }, isRootOrg: true, terms: { accepted: true }, publishingEnabled: true } }),
      postForm,
      getConfig: () => ({ api: { pluginUrl: '/api/plugins', pluginUploadUrl: '/api/plugins/upload' } }),
    });
    const run = (...args: string[]) => {
      const program = new Command();
      program.exitOverride();
      publishPlugin(program);
      return program.parseAsync(['node', 'cli', 'publish', ...args]);
    };
    await run('--dir', plugin(), '--yes', '--skip-scan');
    expect(postForm).toHaveBeenCalledTimes(1);
    await expect(run('--dir', path.join(tmp, 'missing'), '--yes')).rejects.toThrow('exit 2');
    exitSpy.mockRestore();
  });
});
