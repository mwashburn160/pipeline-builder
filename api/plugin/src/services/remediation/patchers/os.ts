// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * OS package source patches (deb, apk, rpm): pin the named package to its fixed
 * version where the Dockerfile's own install command names it —
 * `apt-get install … pkg` → `pkg=<fixed>`, `apk add … pkg` → `pkg=<fixed>`,
 * `dnf|microdnf|yum install … pkg` → `pkg-<fixed>`. A package the Dockerfile
 * does not install (it came with the base, or as a dependency) has no source
 * patch: the overlay layer upgrades it in place instead.
 */

import type { GrypePackageType } from '@pipeline-builder/api-core';

import { escapeRe, isSafeToken, type SourcePatcher } from './types.js';

interface InstallSyntax {
  /** Command tool(s) whose `verb` starts a package list. */
  tools: RegExp;
  verbs: ReadonlySet<string>;
  /** Whether a token (quotes stripped) names `pkg`, pinned or not. */
  names: (core: string, pkg: string) => boolean;
  pin: (pkg: string, version: string) => string;
}

const SYNTAX: Record<'deb' | 'apk' | 'rpm', InstallSyntax> = {
  deb: {
    tools: /^(?:apt-get|apt)$/,
    verbs: new Set(['install']),
    names: (core, pkg) => core === pkg || core.startsWith(`${pkg}=`),
    pin: (pkg, v) => `${pkg}=${v}`,
  },
  apk: {
    tools: /^apk$/,
    verbs: new Set(['add']),
    names: (core, pkg) => core === pkg || new RegExp(`^${escapeRe(pkg)}(?:=|~=|>=|<=|>|<|~)`).test(core),
    pin: (pkg, v) => `${pkg}=${v}`,
  },
  rpm: {
    tools: /^(?:dnf|microdnf|yum|tdnf)$/,
    verbs: new Set(['install']),
    names: (core, pkg) => core === pkg || new RegExp(`^${escapeRe(pkg)}-\\d`).test(core),
    pin: (pkg, v) => `${pkg}-${v}`,
  },
};

const SEPARATOR = /^(?:&&|\|\||;|\|)$/;

/**
 * Pin `pkg` in every install command of `syntax` in the Dockerfile. Handles
 * line continuations (`\`), chained commands (`&&`, `;`) and quoted tokens.
 * Null when no install command names the package.
 */
export function pinInInstallCommands(dockerfile: string, syntax: InstallSyntax, pkg: string, version: string): string | null {
  let changed = false;
  let tool = false;
  let active = false;
  const lines = dockerfile.split('\n').map((line) => {
    if (/^\s*#/.test(line)) return line;
    const parts = line.split(/(\s+|&&|\|\||;)/);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (part === '' || /^\s+$/.test(part) || part === '\\') continue;
      if (SEPARATOR.test(part)) { tool = false; active = false; continue; }
      if (/^RUN$/i.test(part)) { tool = false; active = false; continue; }
      const core = part.replace(/^['"]|['"]$/g, '');
      if (syntax.tools.test(core)) { tool = true; active = false; continue; }
      if (tool && !active && syntax.verbs.has(core)) { active = true; continue; }
      if (active && !core.startsWith('-') && syntax.names(core, pkg)) {
        const quote = part.startsWith('"') || part.startsWith('\'') ? part[0]! : '';
        parts[i] = `${quote}${syntax.pin(pkg, version)}${quote}`;
        changed = true;
      }
    }
    if (!/\\\s*$/.test(line)) { tool = false; active = false; }
    return parts.join('');
  });
  return changed ? lines.join('\n') : null;
}

function osPatcher(type: 'deb' | 'apk' | 'rpm'): SourcePatcher {
  return (tree, target, ctx) => {
    const dockerfile = tree.get(ctx.dockerfile);
    if (dockerfile === undefined) return null;
    if (!isSafeToken(target.packageName) || !isSafeToken(target.fixVersion)) return null;
    const next = pinInInstallCommands(dockerfile, SYNTAX[type], target.packageName, target.fixVersion);
    if (next === null) return null;
    return { purl: target.purl, packageType: type as GrypePackageType, files: new Map([[ctx.dockerfile, next]]), regenerate: [], lockfiles: [] };
  };
}

export const debPatcher = osPatcher('deb');
export const apkPatcher = osPatcher('apk');
export const rpmPatcher = osPatcher('rpm');
