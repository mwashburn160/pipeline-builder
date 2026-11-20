// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The patcher table (docs/plugin-publishing.md "Scan gates", plan "Two ways to
 * apply a fix"): a SOURCE patcher per package type, and the OVERLAY command for
 * the types an in-place upgrade can fix. api-core GRYPE_PACKAGE_TYPE_CATALOG
 * says which are possible; this module is the implementation.
 */

import { GRYPE_PACKAGE_TYPE_CATALOG, type GrypePackageType, type PluginScanFindingLocation } from '@pipeline-builder/api-core';

import { binaryPatcher, dotnetPatcher, gemPatcher, goPatcher, javaPatcher, rustPatcher } from './compiled.js';
import { npmPatcher } from './npm.js';
import { apkPatcher, debPatcher, rpmPatcher } from './os.js';
import { pythonPatcher } from './python.js';
import { isSafeToken, type FixTarget, type SourcePatcher } from './types.js';

export type { FixTarget, SourcePatch, SourcePatcher, SourceTree, ToolRun, PatchContext } from './types.js';

export const SOURCE_PATCHERS: Readonly<Record<GrypePackageType, SourcePatcher | null>> = {
  'deb': debPatcher,
  'apk': apkPatcher,
  'rpm': rpmPatcher,
  'npm': npmPatcher,
  'python': pythonPatcher,
  'go-module': goPatcher,
  'java-archive': javaPatcher,
  'gem': gemPatcher,
  'rust-crate': rustPatcher,
  'dotnet': dotnetPatcher,
  'binary': binaryPatcher,
  'other': null,
};

const q = (s: string): string => `'${s}'`;

/** The directory holding `node_modules/<pkg>` for an npm location (`/app/node_modules/x/package.json` → `/app`); null for a global top-level package. */
function npmProjectDir(path: string): string | null {
  const i = path.lastIndexOf('/node_modules/');
  if (i < 0) return null;
  const dir = path.slice(0, i) || '/';
  // `<prefix>/lib/node_modules/<pkg>` is a global install: `npm install` run in
  // `<prefix>/lib` (no package.json) would prune every other global package.
  return /\/lib$/.test(dir) ? null : dir;
}

/** The site-packages / dist-packages directory of a python location. */
function sitePackagesDir(path: string): string | null {
  const m = /^(.*\/(?:site|dist)-packages)\//.exec(path);
  return m ? m[1]! : null;
}

const STANDARD_SITE = /^\/usr(?:\/local)?\/lib\/python3[^/]*\/(?:site|dist)-packages$/;

/**
 * The overlay RUN fragment that upgrades one package in place, or null when no
 * overlay can fix this type (compiled) or the inputs are not safe to put in a
 * shell command. `locations` are grype's (where the package was found).
 */
export function overlayCommand(target: FixTarget, locations: readonly PluginScanFindingLocation[]): string | null {
  const spec = GRYPE_PACKAGE_TYPE_CATALOG[target.packageType];
  if (!spec.overlay) return null;
  const { packageName: pkg, fixVersion: v, installedVersion: old } = target;
  if (!isSafeToken(pkg) || !isSafeToken(v)) return null;
  const paths = locations.map((l) => l.path).filter((p) => /^\/[A-Za-z0-9._@+/-]+$/.test(p) && !p.split('/').includes('..'));
  switch (target.packageType) {
    case 'deb':
      return `apt-get update && apt-get install --only-upgrade -y --no-install-recommends ${q(`${pkg}=${v}`)} && rm -rf /var/lib/apt/lists/*`;
    case 'apk':
      return `apk add --no-cache --upgrade ${q(`${pkg}=${v}`)}`;
    case 'rpm':
      return `(dnf upgrade -y ${q(`${pkg}-${v}`)} || microdnf update -y ${q(`${pkg}-${v}`)} || yum update -y ${q(`${pkg}-${v}`)}) && (dnf clean all || microdnf clean all || yum clean all || true)`;
    case 'npm': {
      const dirs = [...new Set(paths.map(npmProjectDir))];
      if (dirs.length === 0) return null;
      return dirs.map((d) => (d === null
        ? `npm install -g --ignore-scripts --no-audit --no-fund ${q(`${pkg}@${v}`)}`
        : `(cd ${q(d)} && npm install --no-save --ignore-scripts --no-audit --no-fund ${q(`${pkg}@${v}`)})`)).join(' && ');
    }
    case 'python': {
      const sites = [...new Set(paths.map(sitePackagesDir).filter((s): s is string => s !== null))];
      const base = 'PIP_BREAK_SYSTEM_PACKAGES=1 python3 -m pip install --no-deps --no-cache-dir --upgrade';
      if (sites.length === 0 || sites.every((s) => STANDARD_SITE.test(s))) return `${base} ${q(`${pkg}==${v}`)}`;
      return sites.map((s) => `${base} --target ${q(s)} ${q(`${pkg}==${v}`)}`).join(' && ');
    }
    case 'gem':
      return `gem install ${q(pkg)} -v ${q(v)} --no-document${isSafeToken(old) ? ` && (gem uninstall ${q(pkg)} -v ${q(old)} -x -I --force || true)` : ''}`;
    default:
      return null;
  }
}
