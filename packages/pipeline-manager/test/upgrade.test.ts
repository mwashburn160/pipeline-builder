// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `--upgrade [version]` / `--upgrade-check` (src/commands/upgrade.ts). Every
 * process call goes through injected fakes: nothing reaches a registry or a
 * real global install. What matters is what it refuses — an install it doesn't
 * own, a bad spec, a backwards move nobody asked for, a Node it can't run on,
 * a tarball the registry didn't sign — and that success is read back from disk.
 */

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Command } from 'commander';
import {
  changesUrl, NPM_KEYS_URL, npmBinFor, PACKAGE_NAME, registerUpgradeOption, selfUpgrade, signatureValid, SKIP_VERIFY_ENV, systemDeps, UPGRADE_SINCE,
  type RunResult, type UpgradeDeps,
} from '../src/commands/upgrade.js';
import { ERROR_CODES } from '../src/utils/error-handler.js';

const NPM_ROOT = '/usr/local/lib/node_modules';
const PNPM_ROOT = '/home/u/.local/share/pnpm/global/5/node_modules';
const NPM_DIR = `${NPM_ROOT}/@pipeline-builder/pipeline-manager`;
const PNPM_DIR = `${PNPM_ROOT}/@pipeline-builder/pipeline-manager`;
const PNPM_STORE = '/home/u/.local/share/pnpm/global/5/.pnpm/@pipeline-builder+pipeline-manager@4.4.21/node_modules/@pipeline-builder/pipeline-manager';
const TMP = '/tmp/pm-upgrade-x';
const CURRENT = '4.4.21';
const LATEST = '4.4.23';

// A real ECDSA P-256 key, standing in for the registry's signing key.
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KEYID = 'SHA256:test-key';
const KEYS_JSON = JSON.stringify({ keys: [{ keyid: KEYID, key: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }] });
const integrityFor = (v: string) => `sha512-${createHash('sha512').update(`tarball ${v}`).digest('base64')}`;
const sigFor = (v: string, integrity = integrityFor(v)) => sign('sha256', Buffer.from(`${PACKAGE_NAME}@${v}:${integrity}`), privateKey).toString('base64');

/** `npm view … --json` for a release that is correctly signed unless overridden. */
function viewOf(v: string, over: { node?: string | null; integrity?: string; sig?: string } = {}): RunResult {
  const body: Record<string, unknown> = {
    'version': v,
    'dist.integrity': over.integrity ?? integrityFor(v),
    'dist.signatures': [{ keyid: KEYID, sig: over.sig ?? sigFor(v) }],
  };
  if (over.node !== null) body.engines = { node: over.node ?? '>= 26.13.0' };
  return { status: 0, stdout: JSON.stringify(body) };
}

interface Call { cmd: string; args: string[]; inherit: boolean }

let calls: Call[];
let logged: string[];
let removed: string[];
beforeEach(() => {
  calls = [];
  logged = [];
  removed = [];
  for (const m of ['log', 'error', 'warn', 'info'] as const) {
    jest.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  }
});

/** Fake seams: a global npm install of CURRENT whose registry `latest` is LATEST, unless overridden. */
function deps(over: {
  self?: string;
  view?: RunResult;
  install?: RunResult;
  pack?: RunResult;
  after?: string | null;
  npmRoot?: string | null;
  pnpmRoot?: string | null;
  current?: string;
  node?: string;
  realpaths?: Record<string, string>;
  writable?: boolean;
  keys?: string | null;
  tarballIntegrity?: string;
  env?: NodeJS.ProcessEnv;
} = {}): UpgradeDeps {
  const self = over.self ?? NPM_DIR;
  const realpaths: Record<string, string> = { [NPM_DIR]: NPM_DIR, [self]: self, ...over.realpaths };
  let packed = LATEST;
  return {
    packageRoot: self,
    currentVersion: over.current ?? CURRENT,
    nodeVersion: over.node ?? 'v26.14.0',
    env: over.env ?? {},
    realpath: (p) => realpaths[p.replace(/\/$/, '')] ?? null,
    readVersion: () => (over.after === undefined ? packed : over.after),
    writable: () => over.writable ?? true,
    fetchText: (url) => {
      calls.push({ cmd: 'fetch', args: [url], inherit: false });
      return over.keys === undefined ? KEYS_JSON : over.keys;
    },
    integrityOf: () => over.tarballIntegrity ?? integrityFor(packed),
    makeTempDir: () => TMP,
    removeDir: (d) => { removed.push(d); },
    run: (cmd, args, inherit) => {
      calls.push({ cmd, args, inherit });
      if (args[0] === 'root') {
        const root = cmd === 'npm' ? (over.npmRoot === undefined ? NPM_ROOT : over.npmRoot) : (over.pnpmRoot ?? null);
        return root ? { status: 0, stdout: `${root}\n` } : { status: null, stdout: '' };
      }
      if (args[0] === 'view') return over.view ?? viewOf(LATEST);
      if (args[0] === 'pack') {
        packed = args[1]!.split('@').pop()!;
        return over.pack ?? { status: 0, stdout: JSON.stringify([{ filename: `pipeline-builder-pipeline-manager-${packed}.tgz` }]) };
      }
      return over.install ?? { status: 0, stdout: '' };
    },
  };
}

const installs = () => calls.filter((c) => c.args[0] === 'install' || c.args[0] === 'add');
const out = () => logged.join('\n');
const TARBALL = (v: string) => join(TMP, `pipeline-builder-pipeline-manager-${v}.tgz`);

describe('selfUpgrade', () => {
  it('upgrades a global npm install to latest from the verified tarball, and reads the result back', () => {
    expect(selfUpgrade(true, deps())).toBe(0);
    expect(calls.find((c) => c.args[0] === 'view')?.args).toEqual(['view', `${PACKAGE_NAME}@latest`, 'version', 'engines', 'dist.integrity', 'dist.signatures', '--json']);
    expect(calls.find((c) => c.args[0] === 'pack')?.args).toEqual(['pack', `${PACKAGE_NAME}@${LATEST}`, '--pack-destination', TMP, '--json']);
    expect(calls.find((c) => c.cmd === 'fetch')?.args).toEqual(['https://registry.npmjs.org/-/npm/v1/keys']);
    expect(installs()).toEqual([{ cmd: 'npm', args: ['install', '-g', TARBALL(LATEST)], inherit: true }]);
    expect(removed).toEqual([TMP]);
    expect(out()).toContain(`now ${LATEST} (was ${CURRENT}); signature verified`);
    expect(out()).toContain(changesUrl(CURRENT, LATEST));
  });

  it('upgrades a global pnpm install with pnpm (matched by realpath into its store)', () => {
    const d = deps({ self: PNPM_STORE, pnpmRoot: PNPM_ROOT, realpaths: { [NPM_DIR]: NPM_DIR, [PNPM_DIR]: PNPM_STORE } });
    expect(selfUpgrade(true, d)).toBe(0);
    expect(installs()).toEqual([{ cmd: 'pnpm', args: ['add', '-g', TARBALL(LATEST)], inherit: true }]);
  });

  it('refuses an install it does not own (npx / project dependency / checkout / Volta) and installs nothing', () => {
    const d = deps({ self: '/work/app/node_modules/@pipeline-builder/pipeline-manager' });
    expect(selfUpgrade(true, d)).toBe(ERROR_CODES.CONFIGURATION);
    expect(installs()).toEqual([]);
    expect(out()).toContain('not a global npm or pnpm install');
    expect(out()).toContain('volta install');
  });

  it('refuses when no package manager answers for its global root', () => {
    expect(selfUpgrade(true, deps({ npmRoot: null }))).toBe(ERROR_CODES.CONFIGURATION);
    expect(installs()).toEqual([]);
  });

  it.each(['latest tag', '4.4', '1.2.3; rm -rf /', '$(id)', '../x'])('rejects the spec %j before running anything', (spec) => {
    expect(selfUpgrade(spec, deps())).toBe(ERROR_CODES.VALIDATION);
    expect(calls).toEqual([]);
  });

  it('a version or tag the registry does not have (E404) is a validation error, not a network one', () => {
    const view = { status: 1, stdout: JSON.stringify({ error: { code: 'E404', summary: 'No match found for version deploy' } }) };
    expect(selfUpgrade('deploy', deps({ view }))).toBe(ERROR_CODES.VALIDATION);
    expect(out()).toContain('has no version or dist-tag "deploy"');
    expect(installs()).toEqual([]);
  });

  it('an unreachable registry is a network failure', () => {
    const view = { status: 1, stdout: JSON.stringify({ error: { code: 'ENOTFOUND' } }) };
    expect(selfUpgrade('9.9.9', deps({ view }))).toBe(ERROR_CODES.NETWORK);
    expect(installs()).toEqual([]);
  });

  it('does nothing when already on the latest release', () => {
    expect(selfUpgrade(true, deps({ current: LATEST }))).toBe(0);
    expect(installs()).toEqual([]);
    expect(out()).toContain('already the latest release');
  });

  it('a bare --upgrade never moves backwards', () => {
    expect(selfUpgrade(true, deps({ current: '4.5.0' }))).toBe(0);
    expect(installs()).toEqual([]);
    expect(out()).toContain('newer than the latest release');
  });

  it('orders prereleases numerically (rc.9 → rc.10 is an upgrade)', () => {
    const d = deps({ current: '5.0.0-rc.9', view: viewOf('5.0.0-rc.10') });
    expect(selfUpgrade('next', d)).toBe(0);
    expect(out()).toContain('Upgrading');
  });

  it('naming an older version downgrades to it', () => {
    const d = deps({ current: LATEST, view: viewOf('4.4.22') });
    expect(selfUpgrade('4.4.22', d)).toBe(0);
    expect(installs()[0]?.args).toEqual(['install', '-g', TARBALL('4.4.22')]);
    expect(out()).toContain('Downgrading');
  });

  it(`refuses to move below ${UPGRADE_SINCE}, which has no --upgrade to come back with`, () => {
    expect(selfUpgrade('4.4.18', deps({ view: viewOf('4.4.18') }))).toBe(ERROR_CODES.VALIDATION);
    expect(out()).toContain(`predates --upgrade (added in ${UPGRADE_SINCE})`);
    expect(out()).toContain(`npm install -g ${PACKAGE_NAME}@4.4.18`);
    expect(installs()).toEqual([]);
  });

  it(`moving UP from a build older than ${UPGRADE_SINCE} is allowed (only a downgrade can strand)`, () => {
    expect(selfUpgrade(true, deps({ current: '4.4.19', view: viewOf('4.4.20') }))).toBe(0);
    expect(installs()[0]?.args).toEqual(['install', '-g', TARBALL('4.4.20')]);
  });

  it("takes npm's signing keys from registry.npmjs.org even when a mirror is configured", () => {
    expect(selfUpgrade(true, deps())).toBe(0);
    expect(calls.filter((c) => c.cmd === 'fetch').map((c) => c.args[0])).toEqual([NPM_KEYS_URL]);
    expect(calls.some((c) => c.args[0] === 'config')).toBe(false);
  });

  it('never needs a platform sign-in: it talks to the npm registry only', () => {
    expect(selfUpgrade(true, deps())).toBe(0);
    expect(calls.filter((c) => c.cmd === 'fetch').map((c) => c.args[0])).toEqual(['https://registry.npmjs.org/-/npm/v1/keys']);
    expect(calls.every((c) => ['npm', 'pnpm', 'fetch'].includes(c.cmd))).toBe(true);
  });

  it("refuses a release whose engines.node the running Node doesn't satisfy", () => {
    expect(selfUpgrade(true, deps({ view: viewOf(LATEST, { node: '>= 28.0.0' }) }))).toBe(ERROR_CODES.CONFIGURATION);
    expect(out()).toContain('needs Node >= 28.0.0, but this is Node v26.14.0');
    expect(installs()).toEqual([]);
  });

  it('warns but proceeds on an engines range it cannot parse, and when none is declared', () => {
    expect(selfUpgrade(true, deps({ view: viewOf(LATEST, { node: '26.x - 27.x' }) }))).toBe(0);
    expect(out()).toContain('Could not check');
    expect(selfUpgrade(true, deps({ view: viewOf(LATEST, { node: null }) }))).toBe(0);
  });

  it('checks the global directory is writable before downloading anything', () => {
    expect(selfUpgrade(true, deps({ writable: false }))).toBe(ERROR_CODES.FILE_SYSTEM);
    expect(out()).toContain(`${NPM_ROOT} is not writable`);
    expect(out()).toContain(`sudo npm install -g ${PACKAGE_NAME}@${LATEST}`);
    expect(out()).not.toMatch(/sudo pipeline-manager/);
    expect(calls.some((c) => c.args[0] === 'pack')).toBe(false);
  });

  it('does not install a tarball whose hash differs from the registry dist.integrity', () => {
    expect(selfUpgrade(true, deps({ tarballIntegrity: 'sha512-tampered' }))).toBe(ERROR_CODES.GENERAL);
    expect(out()).toContain("tarball's hash");
    expect(installs()).toEqual([]);
    expect(removed).toEqual([TMP]);
  });

  it('does not install when no registry signature verifies', () => {
    const view = viewOf(LATEST, { sig: sigFor('4.4.99') });
    expect(selfUpgrade(true, deps({ view }))).toBe(ERROR_CODES.GENERAL);
    expect(out()).toContain('no valid registry signature');
    expect(installs()).toEqual([]);
  });

  it('fails closed when the signing keys are unavailable, unless verification is explicitly skipped', () => {
    expect(selfUpgrade(true, deps({ keys: null }))).toBe(ERROR_CODES.GENERAL);
    expect(out()).toContain(SKIP_VERIFY_ENV);
    expect(installs()).toEqual([]);
    calls = [];
    expect(selfUpgrade(true, deps({ keys: null, env: { [SKIP_VERIFY_ENV]: '1' } }))).toBe(0);
    expect(out()).toContain('without checking the registry signature');
    expect(installs()).toHaveLength(1);
  });

  it('a failed download or install leaves the old version and says so', () => {
    expect(selfUpgrade(true, deps({ pack: { status: 1, stdout: '' } }))).toBe(ERROR_CODES.GENERAL);
    expect(out()).toContain('could not download');
    expect(selfUpgrade(true, deps({ install: { status: 243, stdout: '' } }))).toBe(ERROR_CODES.FILE_SYSTEM);
    expect(out()).toContain(`${CURRENT} is unchanged`);
  });

  it('does not trust a zero exit: the version on disk must be the target', () => {
    expect(selfUpgrade(true, deps({ after: CURRENT }))).toBe(ERROR_CODES.GENERAL);
    expect(out()).toContain(`instead of ${LATEST}`);
  });
});

describe('selfUpgrade --upgrade-check', () => {
  it('exits 1 with the target and changes link when a move is available, installing nothing', () => {
    expect(selfUpgrade(true, deps(), { check: true })).toBe(1);
    expect(out()).toContain(`${CURRENT} → ${LATEST} is available`);
    expect(out()).toContain(changesUrl(CURRENT, LATEST));
    expect(calls.some((c) => c.args[0] === 'pack')).toBe(false);
    expect(installs()).toEqual([]);
  });

  it('exits 0 when current, and still works for an install --upgrade cannot replace', () => {
    expect(selfUpgrade(true, deps({ current: LATEST }), { check: true })).toBe(0);
    const d = deps({ self: '/work/app/node_modules/@pipeline-builder/pipeline-manager' });
    expect(selfUpgrade(true, d, { check: true })).toBe(1);
    expect(out()).toContain('update it with whatever installed it');
  });
});

describe('signatureValid', () => {
  const release = (sig: string, keyid = KEYID) => ({ version: LATEST, integrity: integrityFor(LATEST), signatures: [{ keyid, sig }] });
  const keys = new Map((JSON.parse(KEYS_JSON) as { keys: Array<{ keyid: string; key: string }> }).keys.map((k) => [k.keyid, k.key]));

  it('accepts the registry signature over name@version:integrity', () => {
    expect(signatureValid(release(sigFor(LATEST)), keys)).toBe(true);
  });

  it('rejects a signature over a different version, an unknown keyid, garbage, or a missing integrity', () => {
    expect(signatureValid(release(sigFor('4.4.1')), keys)).toBe(false);
    expect(signatureValid(release(sigFor(LATEST), 'SHA256:other'), keys)).toBe(false);
    expect(signatureValid(release('not-base64-der'), keys)).toBe(false);
    expect(signatureValid({ ...release(sigFor(LATEST)), integrity: undefined }, keys)).toBe(false);
  });
});

describe('npmBinFor', () => {
  it("prefers the npm next to the running node, else PATH's", () => {
    expect(npmBinFor('/opt/node/bin/node', 'linux', () => true)).toBe('/opt/node/bin/npm');
    expect(npmBinFor('C:\\node\\node.exe', 'win32', () => true)).toMatch(/npm\.cmd$/);
    expect(npmBinFor('/opt/node/bin/node', 'linux', () => false)).toBe('npm');
  });
});

describe('changesUrl', () => {
  it('compares the two release tags', () => {
    expect(changesUrl('4.4.21', '4.4.23')).toBe(
      'https://github.com/mwashburn160/pipeline-builder/compare/release/@pipeline-builder/pipeline-manager/4.4.21...release/@pipeline-builder/pipeline-manager/4.4.23');
  });
});

describe('systemDeps (the real seams, on a temp dir)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-upgrade-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const d = systemDeps();

  it('reads a package version, resolves symlinks, reports writability, and hashes like dist.integrity', () => {
    const pkg = join(dir, 'pkg');
    mkdirSync(pkg);
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: '9.8.7' }));
    symlinkSync(pkg, join(dir, 'link'));
    expect(d.readVersion(pkg)).toBe('9.8.7');
    expect(d.readVersion(join(dir, 'missing'))).toBeNull();
    expect(d.realpath(join(dir, 'link'))).toBe(d.realpath(pkg));
    expect(d.realpath(join(dir, 'missing'))).toBeNull();
    expect(d.writable(dir)).toBe(true);
    expect(d.writable(join(dir, 'missing'))).toBe(false);
    writeFileSync(join(dir, 'blob'), 'abc');
    expect(d.integrityOf(join(dir, 'blob'))).toBe(`sha512-${createHash('sha512').update('abc').digest('base64')}`);
  });

  it('makes and removes a temp dir, and runs a manager command', () => {
    const t = d.makeTempDir();
    expect(d.writable(t)).toBe(true);
    d.removeDir(t);
    expect(d.realpath(t)).toBeNull();
    expect(d.run('npm', ['--version'], false).status).toBe(0);
  });
});

describe('registerUpgradeOption', () => {
  it('adds --upgrade [version] and --upgrade-check [version] to the root command and its help', () => {
    const program = new Command();
    registerUpgradeOption(program);
    expect(program.options.find((o) => o.long === '--upgrade')?.optional).toBe(true);
    expect(program.options.find((o) => o.long === '--upgrade-check')?.optional).toBe(true);
    expect(program.helpInformation()).toContain('--upgrade [version]');
    expect(program.helpInformation()).toContain('--upgrade-check [version]');
  });

  // Commander hands the listener null for a bare flag, not `true` — this once
  // reached npm as `@null`.
  it.each([
    [['--upgrade'], true, {}],
    [['--upgrade', '4.4.22'], '4.4.22', {}],
    [['--upgrade-check'], true, { check: true }],
    [['--upgrade-check', 'next'], 'next', { check: true }],
  ] as Array<[string[], string | true, object]>)('%j runs with %j %j and exits with its code', (args, want, opts) => {
    const upgrade = jest.fn((_r: string | true, _o: object) => 7);
    const exit = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    const program = new Command().exitOverride();
    registerUpgradeOption(program, upgrade);
    expect(() => program.parse(args, { from: 'user' })).toThrow('exit 7');
    expect(upgrade).toHaveBeenCalledWith(want, opts);
    exit.mockRestore();
  });
});
