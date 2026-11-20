// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Source patches for libraries compiled into the plugin's binaries or
 * packages: Go modules, Java archives (Maven / Gradle), Rust crates, .NET
 * packages — plus Ruby gems and pinned tools (`binary`). Each edits the
 * manifest / lockfile line that names the package and, where a lockfile must
 * be re-resolved, asks for a tool run:
 *
 *   go-module    go.mod require line → v<fixed>; `go mod tidy` regenerates go.sum
 *   java-archive Maven: dependencyManagement entry (and an explicit direct version);
 *                Gradle: a `constraints {}` entry (and a direct coordinate's version)
 *   rust-crate   Cargo.lock `[[package]]` version; `cargo update -p <pkg> --precise <fixed>`
 *   dotnet       PackageReference / PackageVersion Version (a transitive one is pinned);
 *                packages.lock.json re-resolved when present
 *   gem          Gemfile.lock spec line; `bundle lock` re-resolves conservatively
 *   binary       `ARG <TOOL>_VERSION=` (GO_VERSION for Go's stdlib) bumped
 *
 * A compiled package with no kept source has no fix at all (owner request).
 */

import { bumpPinnedArg, findPinnedArg, pinnedArgNames } from '../dockerfile.js';

import { baseName, dirOf, escapeRe, isSafeToken, joinPath, parsePurl, type SourcePatch, type SourcePatcher } from './types.js';

const emptyPatch = (purl: string, packageType: SourcePatch['packageType']): SourcePatch => ({ purl, packageType, files: new Map(), regenerate: [], lockfiles: [] });

// -- Go -------------------------------------------------------------------------

const goVersion = (v: string): string => (v.startsWith('v') ? v : `v${v}`);

export const goPatcher: SourcePatcher = (tree, target) => {
  const mod = target.packageName;
  if (!isSafeToken(mod) || !isSafeToken(target.fixVersion)) return null;
  const want = goVersion(target.fixVersion);
  const patch = emptyPatch(target.purl, 'go-module');
  const lineRe = new RegExp(`^(\\s*(?:require\\s+)?)(${escapeRe(mod)})(\\s+)(v[^\\s]+)(.*)$`);
  for (const [path, text] of tree) {
    if (baseName(path) !== 'go.mod') continue;
    let inRequire = false;
    let changed = false;
    const lines = text.split('\n').map((line) => {
      if (/^\s*require\s*\(\s*$/.test(line)) { inRequire = true; return line; }
      if (inRequire && /^\s*\)\s*$/.test(line)) { inRequire = false; return line; }
      if (!inRequire && !/^\s*require\s+/.test(line)) return line;
      const m = lineRe.exec(line);
      if (!m || m[4] === want) return line;
      changed = true;
      return `${m[1]}${m[2]}${m[3]}${want}${m[5]}`;
    });
    if (!changed) continue;
    patch.files.set(path, lines.join('\n'));
    const dir = dirOf(path);
    patch.regenerate.push({ ecosystem: 'go', dir, command: `go mod download ${mod}@${want} && go mod tidy`, outputs: ['go.mod', 'go.sum'] });
    patch.lockfiles.push(joinPath(dir, 'go.sum'));
  }
  return patch.files.size > 0 ? patch : null;
};

// -- Java (Maven, Gradle) -----------------------------------------------------------

function mavenCoordinates(purl: string, fallbackName: string): { group: string; artifact: string } | null {
  const p = parsePurl(purl);
  if (p?.type === 'maven' && p.namespace) return { group: p.namespace, artifact: p.name };
  const [group, artifact] = fallbackName.split(':');
  return group && artifact ? { group, artifact } : null;
}

function patchPom(xml: string, group: string, artifact: string, version: string): string | null {
  const depRe = /<dependency>[\s\S]*?<\/dependency>/g;
  const matches = (block: string) => new RegExp(`<groupId>\\s*${escapeRe(group)}\\s*</groupId>`).test(block)
    && new RegExp(`<artifactId>\\s*${escapeRe(artifact)}\\s*</artifactId>`).test(block);
  let out = xml;
  let changed = false;
  // An explicit <version> on a matching dependency anywhere wins over dependencyManagement: bump it.
  out = out.replace(depRe, (block) => {
    if (!matches(block) || !/<version>[^<$]*<\/version>/.test(block)) return block;
    const next = block.replace(/<version>[^<]*<\/version>/, `<version>${version}</version>`);
    if (next !== block) changed = true;
    return next;
  });
  const dm = /(<dependencyManagement>\s*<dependencies>)([\s\S]*?)(<\/dependencies>\s*<\/dependencyManagement>)/.exec(out);
  const managed = dm ? (dm[2]!.match(depRe) ?? []).some(matches) : false;
  if (!managed) {
    const ind = /\n([ \t]+)<(?:dependencies|groupId|artifactId)>/.exec(out)?.[1] ?? '  ';
    const dep = (base: string) => `${base}<dependency>\n${base}${ind}<groupId>${group}</groupId>\n${base}${ind}<artifactId>${artifact}</artifactId>\n`
      + `${base}${ind}<version>${version}</version>\n${base}</dependency>\n`;
    if (dm) {
      out = out.replace(dm[0], `${dm[1]}${dm[2]!.replace(/\s*$/, '\n')}${dep(ind.repeat(3))}${ind.repeat(2)}${dm[3]}`);
    } else {
      const block = `${ind}<dependencyManagement>\n${ind.repeat(2)}<dependencies>\n${dep(ind.repeat(3))}${ind.repeat(2)}</dependencies>\n${ind}</dependencyManagement>\n`;
      const at = out.search(/\n[ \t]*<dependencies>/);
      if (at >= 0) out = `${out.slice(0, at + 1)}${block}${out.slice(at + 1)}`;
      else if (out.includes('</project>')) out = out.replace('</project>', `${block}</project>`);
      else return null;
    }
    changed = true;
  }
  return changed ? out : null;
}

function patchGradle(text: string, group: string, artifact: string, version: string): string | null {
  const coord = `${group}:${artifact}`;
  let out = text.replace(new RegExp(`(["'])${escapeRe(coord)}:([^"'$]+)\\1`, 'g'), (_whole, q: string) => `${q}${coord}:${version}${q}`);
  const direct = out !== text;
  if (!new RegExp(`constraints\\s*\\{[\\s\\S]*?${escapeRe(coord)}`).test(out)) {
    const m = /^([ \t]*)dependencies\s*\{[ \t]*$/m.exec(out);
    if (!m) return direct ? out : null;
    const ind = m[1] ?? '';
    const block = `\n${ind}    constraints {\n${ind}        implementation("${coord}:${version}") {\n${ind}            because("${coord} security fix")\n${ind}        }\n${ind}    }`;
    out = `${out.slice(0, m.index + m[0].length)}${block}${out.slice(m.index + m[0].length)}`;
  }
  return out !== text ? out : null;
}

export const javaPatcher: SourcePatcher = (tree, target) => {
  const coords = mavenCoordinates(target.purl, target.packageName);
  if (!coords || !isSafeToken(coords.group) || !isSafeToken(coords.artifact) || !isSafeToken(target.fixVersion)) return null;
  const patch = emptyPatch(target.purl, 'java-archive');
  for (const [path, text] of tree) {
    const name = baseName(path);
    if (name === 'pom.xml') {
      const next = patchPom(text, coords.group, coords.artifact, target.fixVersion);
      if (next !== null) patch.files.set(path, next);
    } else if (name === 'build.gradle' || name === 'build.gradle.kts') {
      const next = patchGradle(text, coords.group, coords.artifact, target.fixVersion);
      if (next === null) continue;
      patch.files.set(path, next);
      const dir = dirOf(path);
      if (tree.has(joinPath(dir, 'gradle.lockfile'))) {
        patch.regenerate.push({ ecosystem: 'gradle', dir, command: 'gradle dependencies --write-locks --no-daemon -q', outputs: ['gradle.lockfile'] });
        patch.lockfiles.push(joinPath(dir, 'gradle.lockfile'));
      }
    }
  }
  return patch.files.size > 0 ? patch : null;
};

// -- Rust -----------------------------------------------------------------------------

export const rustPatcher: SourcePatcher = (tree, target) => {
  if (!isSafeToken(target.packageName) || !isSafeToken(target.fixVersion)) return null;
  const patch = emptyPatch(target.purl, 'rust-crate');
  const block = new RegExp(`(\\[\\[package\\]\\]\\s*\\nname = "${escapeRe(target.packageName)}"\\s*\\nversion = ")${escapeRe(target.installedVersion)}(")`, 'g');
  for (const [path, text] of tree) {
    if (baseName(path) !== 'Cargo.lock') continue;
    const next = text.replace(block, `$1${target.fixVersion}$2`);
    if (next === text) continue;
    patch.files.set(path, next);
    const dir = dirOf(path);
    patch.regenerate.push({ ecosystem: 'cargo', dir, command: `cargo update -p ${target.packageName}@${target.installedVersion} --precise ${target.fixVersion}`, outputs: ['Cargo.lock'] });
    patch.lockfiles.push(path);
  }
  return patch.files.size > 0 ? patch : null;
};

// -- .NET -----------------------------------------------------------------------------

const DOTNET_PROJECT = /\.(?:csproj|fsproj|vbproj)$|^Directory\.Packages\.props$/;

export const dotnetPatcher: SourcePatcher = (tree, target) => {
  const pkg = target.packageName;
  if (!isSafeToken(pkg) || !isSafeToken(target.fixVersion)) return null;
  const patch = emptyPatch(target.purl, 'dotnet');
  const ref = new RegExp(`(<Package(?:Reference|Version)\\s+[^>]*Include="${escapeRe(pkg)}"[^>]*?Version=")([^"]+)(")`, 'gi');
  const refFlip = new RegExp(`(<Package(?:Reference|Version)\\s+[^>]*Version=")([^"]+)("[^>]*Include="${escapeRe(pkg)}")`, 'gi');
  const projects = [...tree.keys()].filter((p) => DOTNET_PROJECT.test(baseName(p)));
  for (const path of projects) {
    const text = tree.get(path)!;
    const next = text.replace(ref, `$1${target.fixVersion}$3`).replace(refFlip, `$1${target.fixVersion}$3`);
    if (next !== text) patch.files.set(path, next);
  }
  if (patch.files.size === 0) {
    // A transitive package: pin it with a direct reference in the first project that references packages.
    const host = projects.find((p) => /\.(?:cs|fs|vb)proj$/.test(p) && /<PackageReference\s/.test(tree.get(p)!));
    if (!host) return null;
    const text = tree.get(host)!;
    const m = /^([ \t]*)<PackageReference\s/m.exec(text);
    if (!m) return null;
    patch.files.set(host, `${text.slice(0, m.index)}${m[1]}<PackageReference Include="${pkg}" Version="${target.fixVersion}" />\n${text.slice(m.index)}`);
  }
  for (const path of patch.files.keys()) {
    const dir = dirOf(path);
    if (tree.has(joinPath(dir, 'packages.lock.json'))) {
      patch.regenerate.push({ ecosystem: 'dotnet', dir, command: 'dotnet restore --force-evaluate', outputs: ['packages.lock.json'] });
      patch.lockfiles.push(joinPath(dir, 'packages.lock.json'));
    }
  }
  return patch;
};

// -- Ruby -----------------------------------------------------------------------------

export const gemPatcher: SourcePatcher = (tree, target) => {
  if (!isSafeToken(target.packageName) || !isSafeToken(target.fixVersion)) return null;
  const patch = emptyPatch(target.purl, 'gem');
  const spec = new RegExp(`^(\\s{4})${escapeRe(target.packageName)} \\(${escapeRe(target.installedVersion)}((?:-[^)]+)?)\\)$`, 'gm');
  for (const [path, text] of tree) {
    if (baseName(path) !== 'Gemfile.lock') continue;
    const next = text.replace(spec, `$1${target.packageName} (${target.fixVersion}$2)`);
    if (next === text) continue;
    patch.files.set(path, next);
    const dir = dirOf(path);
    patch.regenerate.push({ ecosystem: 'bundler', dir, command: `bundle lock --update ${target.packageName} --conservative`, outputs: ['Gemfile.lock'] });
    patch.lockfiles.push(path);
  }
  return patch.files.size > 0 ? patch : null;
};

// -- pinned tools (binary) -----------------------------------------------------------

export const binaryPatcher: SourcePatcher = (tree, target, ctx) => {
  const dockerfile = tree.get(ctx.dockerfile);
  if (dockerfile === undefined || !isSafeToken(target.fixVersion)) return null;
  const arg = findPinnedArg(dockerfile, pinnedArgNames(target.packageName));
  if (!arg || arg.value.replace(/^v/, '') === target.fixVersion.replace(/^v/, '')) return null;
  const patch = emptyPatch(target.purl, 'binary');
  patch.files.set(ctx.dockerfile, bumpPinnedArg(dockerfile, arg, target.fixVersion));
  return patch;
};
