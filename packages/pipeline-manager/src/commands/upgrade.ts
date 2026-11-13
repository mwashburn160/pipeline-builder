// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `pipeline-manager --upgrade [version]`: replace this CLI with the latest
 * release (or a named version / dist-tag) in place; `--upgrade-check [version]`
 * reports what that would do without doing it.
 *
 * It only acts on an install it can prove it owns: a GLOBAL npm or pnpm
 * install whose package directory is the one running now. Anything else (npx,
 * a project dependency, a workspace checkout, Volta, Homebrew) is refused with
 * the command that would update it, because reinstalling globally would leave
 * the copy actually being run untouched and report a success that changed nothing.
 *
 * Before installing it checks, in order: the target's `engines.node` against
 * the running Node; that a downgrade does not go below the first release with
 * `--upgrade` (which would strand the user); that the global directory
 * is writable; and that the downloaded tarball matches the registry's
 * `dist.integrity` AND carries a valid registry ECDSA signature over it. The
 * verified tarball itself is what gets installed.
 *
 * Synchronous on purpose: it runs from Commander's `option:upgrade` listener,
 * like `--version`, and exits before any command would.
 */

import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { accessSync, constants as fsConstants, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareSemver, satisfiesRange } from '@pipeline-builder/api-core';
import type { Command } from 'commander';
import { APP_NAME, APP_VERSION } from '../config/cli.constants.js';
import { ERROR_CODES } from '../utils/error-handler.js';
import { printError, printInfo, printSuccess, printWarning } from '../utils/output-utils.js';

export const PACKAGE_NAME = '@pipeline-builder/pipeline-manager';
/** The first release that has `--upgrade`: moving below it would leave no way back but a manual install. */
export const UPGRADE_SINCE = '4.4.21';
const REPO_URL = 'https://github.com/mwashburn160/pipeline-builder';
/** Opt out of the registry-signature check (a mirror that doesn't serve npm's signing keys). */
export const SKIP_VERIFY_ENV = 'PIPELINE_MANAGER_UPGRADE_SKIP_VERIFY';

/** A semver (`4.4.19`, `5.0.0-rc.1`) or a dist-tag (`latest`, `next`); nothing a shell could read as syntax. */
const VERSION_SPEC = /^(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|[A-Za-z][0-9A-Za-z.-]*)$/;

type Manager = 'npm' | 'pnpm';

export interface RunResult { status: number | null; stdout: string }

/** The process seams, injectable so tests never touch a real registry or global install. */
export interface UpgradeDeps {
  /** Run a package-manager command; `inherit` streams its output to the terminal. */
  run: (cmd: Manager, args: string[], inherit: boolean) => RunResult;
  /** This package's installed directory. */
  packageRoot: string;
  currentVersion: string;
  /** The running Node's version (`process.version`). */
  nodeVersion: string;
  env: NodeJS.ProcessEnv;
  /** realpath, or null when the path does not exist. */
  realpath: (p: string) => string | null;
  /** The `version` field of `<dir>/package.json`, or null when unreadable. */
  readVersion: (dir: string) => string | null;
  /** Whether this process may write into `dir`. */
  writable: (dir: string) => boolean;
  /** GET `url` and return the body, or null on any failure. */
  fetchText: (url: string) => string | null;
  /** `sha512-<base64>` of a file (the registry's `dist.integrity` form). */
  integrityOf: (file: string) => string;
  makeTempDir: () => string;
  removeDir: (dir: string) => void;
}

/**
 * The npm that belongs to the RUNNING Node (next to `process.execPath`), so a
 * version manager or Homebrew putting a different Node's npm first on PATH
 * can't make the ownership check look at the wrong global root. Falls back to
 * whatever `npm` is on PATH.
 */
export function npmBinFor(execPath: string, platform: NodeJS.Platform, exists: (p: string) => boolean): string {
  const sibling = join(dirname(execPath), platform === 'win32' ? 'npm.cmd' : 'npm');
  return exists(sibling) ? sibling : 'npm';
}

/** Quote an argument for the win32 shell when it holds a space (temp paths under `C:\Users\First Last`). */
const winQuote = (a: string) => (/\s/.test(a) ? `"${a}"` : a);

export const systemDeps = (): UpgradeDeps => {
  const npmBin = npmBinFor(process.execPath, process.platform, existsSync);
  const win = process.platform === 'win32';
  return {
    run: (cmd, args, inherit) => {
      // Windows ships the managers as .cmd shims, which Node only spawns through
      // a shell; every argument is fixed, checked against VERSION_SPEC, or a
      // temp path we created (quoted).
      const r = spawnSync(cmd === 'npm' ? npmBin : cmd, win ? args.map(winQuote) : args, {
        encoding: 'utf8', stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'], shell: win,
      });
      return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
    },
    // dist/commands/upgrade.js → the package root.
    packageRoot: fileURLToPath(new URL('../../', import.meta.url)),
    currentVersion: APP_VERSION,
    nodeVersion: process.version,
    env: process.env,
    realpath: (p) => { try { return realpathSync(p); } catch { return null; } },
    readVersion: (dir) => {
      try { return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }).version ?? null; } catch { return null; }
    },
    writable: (dir) => { try { accessSync(dir, fsConstants.W_OK); return true; } catch { return false; } },
    // Synchronous GET via a short-lived Node child (this module must stay sync).
    fetchText: (url) => {
      const script = 'const r = await fetch(process.argv[1]); if (!r.ok) process.exit(1); process.stdout.write(await r.text());';
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, url], { encoding: 'utf8', timeout: 30_000 });
      return r.status === 0 ? r.stdout : null;
    },
    integrityOf: (file) => `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`,
    makeTempDir: () => mkdtempSync(join(tmpdir(), 'pipeline-manager-upgrade-')),
    removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
  };
};

/** Where this package would live under `manager`'s global root, or null when that manager is absent. */
function globalRoot(manager: Manager, deps: UpgradeDeps): string | null {
  const r = deps.run(manager, ['root', '-g'], false);
  const root = r.status === 0 ? r.stdout.trim() : '';
  return root || null;
}

/** The global manager that owns the running copy (compared by realpath: pnpm links into its store). */
function owningManager(deps: UpgradeDeps): { manager: Manager; root: string; dir: string } | null {
  const self = deps.realpath(deps.packageRoot);
  if (!self) return null;
  for (const manager of ['npm', 'pnpm'] as const) {
    const root = globalRoot(manager, deps);
    const dir = root ? join(root, ...PACKAGE_NAME.split('/')) : null;
    if (root && dir && deps.realpath(dir) === self) return { manager, root, dir };
  }
  return null;
}

interface Release { version: string; nodeRange?: string; integrity?: string; signatures: Array<{ keyid: string; sig: string }> }

type Resolution = { ok: true; release: Release } | { ok: false; notFound: boolean };

/** What `spec` resolves to on the registry: the version plus what the install checks need. */
function resolveRelease(spec: string, deps: UpgradeDeps): Resolution {
  const r = deps.run('npm', ['view', `${PACKAGE_NAME}@${spec}`, 'version', 'engines', 'dist.integrity', 'dist.signatures', '--json'], false);
  let body: unknown;
  try { body = JSON.parse(r.stdout || 'null'); } catch { body = null; }
  // On failure `--json` prints `{"error":{"code":"E404",…}}`: a missing version
  // or tag is the caller's mistake, not the network's.
  if (r.status !== 0) {
    const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
    return { ok: false, notFound: code === 'E404' };
  }
  const o = body as Record<string, unknown> | null;
  const version = o?.version;
  if (typeof version !== 'string') return { ok: false, notFound: o === null };
  const engines = o?.engines as { node?: unknown } | undefined;
  const signatures = Array.isArray(o?.['dist.signatures']) ? (o['dist.signatures'] as Array<{ keyid: string; sig: string }>) : [];
  return {
    ok: true,
    release: {
      version,
      nodeRange: typeof engines?.node === 'string' ? engines.node : undefined,
      integrity: typeof o?.['dist.integrity'] === 'string' ? (o['dist.integrity'] as string) : undefined,
      signatures,
    },
  };
}

/**
 * npm's signing keys, ALWAYS from the public registry that issued them — never
 * from the configured registry. `dist.signatures` are npm's own, so a mirror
 * passes them through unchanged; fetching keys from the mirror would let a
 * malicious or compromised mirror sign its own tarball with its own key.
 */
export const NPM_KEYS_URL = 'https://registry.npmjs.org/-/npm/v1/keys';

/** npm's signing keys, by keyid. */
function registryKeys(deps: UpgradeDeps): Map<string, string> | null {
  const text = deps.fetchText(NPM_KEYS_URL);
  if (!text) return null;
  try {
    const keys = (JSON.parse(text) as { keys?: Array<{ keyid?: unknown; key?: unknown }> }).keys ?? [];
    return new Map(keys.filter((k) => typeof k.keyid === 'string' && typeof k.key === 'string').map((k) => [k.keyid as string, k.key as string]));
  } catch {
    return null;
  }
}

/** Does any registry signature verify `<name>@<version>:<integrity>`? */
export function signatureValid(release: Release, keys: Map<string, string>): boolean {
  if (!release.integrity) return false;
  const message = Buffer.from(`${PACKAGE_NAME}@${release.version}:${release.integrity}`);
  return release.signatures.some(({ keyid, sig }) => {
    const key = keys.get(keyid);
    if (!key) return false;
    try {
      return verify('sha256', message, createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' }), Buffer.from(sig, 'base64'));
    } catch {
      return false;
    }
  });
}

/**
 * Download the target with `npm pack` and prove it is the registry's signed
 * artifact. Returns the tarball path, or an error message.
 */
function fetchVerifiedTarball(release: Release, dir: string, deps: UpgradeDeps): { tarball: string } | { error: string } {
  const pack = deps.run('npm', ['pack', `${PACKAGE_NAME}@${release.version}`, '--pack-destination', dir, '--json'], false);
  let filename: unknown;
  try { filename = (JSON.parse(pack.stdout) as Array<{ filename?: unknown }>)[0]?.filename; } catch { filename = undefined; }
  if (pack.status !== 0 || typeof filename !== 'string') return { error: `npm could not download ${PACKAGE_NAME}@${release.version}` };
  const tarball = join(dir, filename);

  if (deps.env[SKIP_VERIFY_ENV] === '1') {
    printWarning(`${SKIP_VERIFY_ENV}=1: installing without checking the registry signature`);
    return { tarball };
  }
  if (!release.integrity) return { error: `the registry gave no dist.integrity for ${release.version}` };
  const actual = deps.integrityOf(tarball);
  if (actual !== release.integrity) return { error: `the downloaded tarball's hash (${actual}) is not the registry's (${release.integrity})` };
  const keys = registryKeys(deps);
  if (!keys) return { error: `could not fetch npm's signing keys from ${NPM_KEYS_URL} (no route to registry.npmjs.org? set ${SKIP_VERIFY_ENV}=1 to install unverified)` };
  if (!signatureValid(release, keys)) return { error: `no valid registry signature over ${PACKAGE_NAME}@${release.version}` };
  return { tarball };
}

/** Link to what changed between two releases. */
export function changesUrl(from: string, to: string): string {
  const tag = (v: string) => `release/${PACKAGE_NAME}/${v}`;
  return `${REPO_URL}/compare/${tag(from)}...${tag(to)}`;
}

export interface UpgradeOptions {
  /** Report what would happen (exit 0 = current, 1 = a move is available) without installing. */
  check?: boolean;
}

/**
 * Upgrade (or move) this CLI to `requested` (`true` = latest). Returns the
 * process exit code; never throws for an expected failure.
 */
export function selfUpgrade(requested: string | true, deps: UpgradeDeps = systemDeps(), opts: UpgradeOptions = {}): number {
  const spec = requested === true ? 'latest' : requested;
  if (!VERSION_SPEC.test(spec)) {
    printError(`Invalid version "${spec}": use a version like 4.4.21, or a dist-tag like latest`);
    return ERROR_CODES.VALIDATION;
  }

  const owner = owningManager(deps);
  if (!owner && !opts.check) {
    printError(`${APP_NAME} ${deps.currentVersion} at ${deps.packageRoot} is not a global npm or pnpm install, so --upgrade cannot replace it`);
    printInfo(`Update it with whatever installed it: npm install -g ${PACKAGE_NAME}@${spec} (global), `
      + `a version bump in your project, npx ${PACKAGE_NAME}@${spec}, or your Node manager (Volta: volta install ${PACKAGE_NAME}@${spec})`);
    return ERROR_CODES.CONFIGURATION;
  }

  const resolved = resolveRelease(spec, deps);
  if (!resolved.ok) {
    if (resolved.notFound) {
      printError(`${PACKAGE_NAME} has no version or dist-tag "${spec}"`);
      return ERROR_CODES.VALIDATION;
    }
    printError(`Could not reach the npm registry to resolve ${PACKAGE_NAME}@${spec}`);
    return ERROR_CODES.NETWORK;
  }
  const { release } = resolved;
  const target = release.version;

  const order = compareSemver(target, deps.currentVersion);
  if (order === 0) {
    printSuccess(`${APP_NAME} ${deps.currentVersion} is already ${requested === true ? 'the latest release' : 'installed'}`);
    return 0;
  }
  // A bare --upgrade never moves backwards; naming a version is how to downgrade.
  if (order < 0 && requested === true) {
    printSuccess(`${APP_NAME} ${deps.currentVersion} is newer than the latest release (${target}); nothing to do`);
    return 0;
  }
  // Only a DOWNGRADE can strand the user; moving up from a pre-flag build is fine.
  if (order < 0 && compareSemver(target, UPGRADE_SINCE) < 0) {
    printError(`${target} predates --upgrade (added in ${UPGRADE_SINCE}), so moving to it would leave no way back but a manual install`);
    printInfo(`If that is what you want: npm install -g ${PACKAGE_NAME}@${target}`);
    return ERROR_CODES.VALIDATION;
  }
  if (release.nodeRange) {
    const fits = satisfiesRange(deps.nodeVersion, release.nodeRange);
    if (fits === false) {
      printError(`${APP_NAME} ${target} needs Node ${release.nodeRange}, but this is Node ${deps.nodeVersion}; upgrade Node first`);
      return ERROR_CODES.CONFIGURATION;
    }
    if (fits === null) printWarning(`Could not check ${target}'s Node requirement "${release.nodeRange}" against ${deps.nodeVersion}`);
  }

  const verb = order > 0 ? 'Upgrading' : 'Downgrading';
  if (opts.check) {
    printInfo(`${APP_NAME} ${deps.currentVersion} → ${target} is available${owner ? '' : ' (not a global npm/pnpm install: update it with whatever installed it)'}`);
    printInfo(`Changes: ${changesUrl(deps.currentVersion, target)}`);
    return 1;
  }
  // `owner` is non-null past the !check guard above.
  const own = owner!;

  if (!deps.writable(own.root)) {
    printError(`${own.root} is not writable by this user, so ${own.manager} cannot replace ${APP_NAME} there`);
    // Never "re-run pipeline-manager with sudo": that runs the whole CLI (its
    // credential store, its config) as root. Name the one command that needs it.
    printInfo(`Either install just the package as root: sudo npm install -g ${PACKAGE_NAME}@${target}`);
    printInfo('or move npm globals into your home directory (npm config set prefix ~/.npm-global, then add ~/.npm-global/bin to PATH) and re-run --upgrade');
    return ERROR_CODES.FILE_SYSTEM;
  }

  printInfo(`${verb} ${APP_NAME} ${deps.currentVersion} → ${target} (${own.manager} global install)`);
  const tmp = deps.makeTempDir();
  try {
    const fetched = fetchVerifiedTarball(release, tmp, deps);
    if ('error' in fetched) {
      printError(`Not installing ${target}: ${fetched.error}; ${APP_NAME} ${deps.currentVersion} is unchanged`);
      return ERROR_CODES.GENERAL;
    }
    const install = own.manager === 'npm'
      ? deps.run('npm', ['install', '-g', fetched.tarball], true)
      : deps.run('pnpm', ['add', '-g', fetched.tarball], true);
    if (install.status !== 0) {
      printError(`${own.manager} could not install ${PACKAGE_NAME}@${target}; ${APP_NAME} ${deps.currentVersion} is unchanged`);
      return ERROR_CODES.FILE_SYSTEM;
    }
  } finally {
    deps.removeDir(tmp);
  }

  // Read the version back from disk rather than trusting the exit code.
  const installed = deps.readVersion(own.dir);
  if (installed !== target) {
    printWarning(`${own.manager} reported success, but ${own.dir} holds ${installed ?? 'no readable package'} instead of ${target}`);
    return ERROR_CODES.GENERAL;
  }
  printSuccess(`${APP_NAME} is now ${target} (was ${deps.currentVersion}); signature verified`);
  printInfo(`What changed: ${changesUrl(deps.currentVersion, target)}`);
  return 0;
}

/**
 * Register the top-level `--upgrade [version]` and `--upgrade-check [version]`
 * flags. Handled the way Commander handles `--version`: the option listener
 * runs and exits, so each works on its own without a root action that would
 * change how unknown commands are reported.
 */
export function registerUpgradeOption(
  program: Command,
  upgrade: (requested: string | true, opts: UpgradeOptions) => number = (r, o) => selfUpgrade(r, systemDeps(), o),
): void {
  program.option('--upgrade [version]', 'Upgrade this CLI in place to the latest release (or the given version / dist-tag)');
  program.option('--upgrade-check [version]', 'Report whether --upgrade would change anything (exit 0 = current, 1 = available)');
  // Commander's listener gets the value as given, or null/undefined for a bare
  // flag (not `true`, unlike the parsed opts), so anything not a string means latest.
  const latestOr = (value: unknown): string | true => (typeof value === 'string' ? value : true);
  program.on('option:upgrade', (value: unknown) => process.exit(upgrade(latestOr(value), {})));
  program.on('option:upgrade-check', (value: unknown) => process.exit(upgrade(latestOr(value), { check: true })));
}
