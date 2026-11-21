// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The remediation canary fixtures as BUILD CONTEXTS: what makes each one build
 * on amd64 and arm64, get past the build gate, and still be fixable by the
 * nightly dry run under the system org's default settings. These are the
 * properties an end-to-end run found broken (no go.sum, a Cargo.lock without
 * checksums under `--locked`, a hard-coded amd64 download, bases that aged into
 * fixable Criticals, a fix beyond the default upgrade level).
 */

import { describe, expect, it } from '@jest/globals';
import { comparePackageVersions, DEFAULT_LIBRARY_UPGRADE_LEVEL, libraryUpgradeAllowed, libraryUpgradeRequirement } from '@pipeline-builder/api-core';

import { CANARY_FIXTURES, canaryContext, type CanaryFixture } from '../src/services/remediation/canary.js';
import { findPinnedArg, parseFromLines, pinnedArgNames } from '../src/services/remediation/dockerfile.js';

const each = (filter: (f: CanaryFixture) => boolean = () => true) => CANARY_FIXTURES.filter(filter).map((f) => [f.type, f] as const);
const dockerfileOf = (f: CanaryFixture): string => f.files.Dockerfile!;

/** The Dockerfile's stages: the lines from each FROM up to the next. */
function stages(dockerfile: string): string[] {
  const lines = dockerfile.split('\n');
  const starts = parseFromLines(dockerfile).map((s) => s.line);
  return starts.map((start, i) => lines.slice(start, starts[i + 1] ?? lines.length).join('\n'));
}

/** An architecture name, even inside a file name (`yq_linux_amd64`). */
const ARCH_TOKEN = /(?<![A-Za-z0-9])(?:amd64|x86_64|x64|aarch64|arm64)(?![A-Za-z0-9])/;

describe('every fixture builds on amd64 and arm64', () => {
  it.each(each())('%s: no architecture is hard-coded outside a ${TARGETARCH} mapping', (_t, f) => {
    for (const [file, text] of Object.entries(canaryContext(f))) {
      // The one allowed form: `case "${TARGETARCH}" in amd64) … ;; arm64) … ;; esac`.
      const unmapped = text.replace(/case "\$\{TARGETARCH\}" in[\s\S]*?esac/g, '');
      expect({ file, arch: ARCH_TOKEN.exec(unmapped)?.[0] ?? null }).toEqual({ file, arch: null });
    }
  });

  it.each(each())('%s: a stage that reads TARGETARCH declares it', (_t, f) => {
    for (const stage of stages(dockerfileOf(f))) {
      if (stage.includes('TARGETARCH')) expect(stage).toMatch(/^ARG TARGETARCH$/m);
    }
  });

  it.each(each((f) => f.type === 'go-module'))('%s: go.sum carries every required module, so `go build` needs no network', (_t, f) => {
    const sum = f.files['go.sum'] ?? '';
    const required = [...(f.files['go.mod'] ?? '').matchAll(/^(?:require\s+)?\s*(\S+)\s+(v\S+)\s*$/gm)].filter(([, mod]) => mod !== 'module' && mod !== 'go');
    expect(required.length).toBeGreaterThan(0);
    for (const [, mod, version] of required) {
      expect(sum).toMatch(new RegExp(`^${mod!.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} ${version} h1:\\S+=$`, 'm'));
      expect(sum).toMatch(new RegExp(`^${mod!.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} ${version}/go.mod h1:\\S+=$`, 'm'));
    }
  });

  it.each(each((f) => f.type === 'rust-crate'))('%s: Cargo.lock is complete for `cargo build --locked` (checksums, every dependency)', (_t, f) => {
    const lock = f.files['Cargo.lock'] ?? '';
    const packages = lock.split('[[package]]').slice(1);
    const names = new Set(packages.map((p) => /name = "([^"]+)"/.exec(p)?.[1]));
    for (const p of packages) {
      if (p.includes('source = "registry+')) expect(p).toMatch(/checksum = "[0-9a-f]{64}"/);
      for (const [, dep] of p.matchAll(/^ "([^" ]+)[^"]*",?$/gm)) expect(names).toContain(dep);
    }
    expect(packages.find((p) => p.includes(`name = "${f.packageName}"`))).toContain(`version = "${f.installed}"`);
  });
});

describe('every fixture gets past the build gate', () => {
  it.each(each())('%s: bases are version tags, never digests or latest (a digest pin ages into fixable Criticals; the remediation rebuild pulls the tag)', (_t, f) => {
    const stageNames = new Set(parseFromLines(dockerfileOf(f)).map((s) => s.alias).filter(Boolean));
    for (const from of parseFromLines(dockerfileOf(f))) {
      if (stageNames.has(from.image.toLowerCase())) continue;
      expect(from.image).not.toContain('@sha256:');
      expect(from.image).toMatch(/:[^:/]*\d[^:/]*$/);
    }
  });

  it.each(each())('%s: the published stage upgrades its base packages, so only the pinned package carries the advisory', (_t, f) => {
    const final = stages(dockerfileOf(f)).at(-1)!;
    expect(final).toMatch(/apt-get upgrade -y|apk upgrade --no-cache|microdnf upgrade -y/);
  });
});

describe('the nightly dry run can fix every fixture', () => {
  it.each(each())('%s: the fix is an upgrade within the default upgrade level', (_t, f) => {
    expect(comparePackageVersions(f.fixed, f.installed, f.type)).toBeGreaterThan(0);
    expect({ level: libraryUpgradeRequirement(f.installed, f.fixed, f.type), allowed: libraryUpgradeAllowed(f.installed, f.fixed, DEFAULT_LIBRARY_UPGRADE_LEVEL, f.type) })
      .toEqual({ level: expect.any(String), allowed: true });
  });

  it('apk: the vulnerable version is the base patch release\'s, held back from the upgrade (so the OVERLAY fixes it)', () => {
    const f = CANARY_FIXTURES.find((x) => x.type === 'apk')!;
    expect(parseFromLines(dockerfileOf(f)).at(-1)!.image).toMatch(/^alpine:\d+\.\d+\.\d+$/);
    expect(dockerfileOf(f)).toMatch(new RegExp(`apk upgrade --no-cache --ignore (?:\\S+ )*${f.packageName}\\b`));
    expect(dockerfileOf(f)).not.toMatch(new RegExp(`apk add [^&]*\\b${f.packageName}\\b`));
  });

  it.each(each((f) => f.type !== 'apk'))('%s: the context pins the vulnerable version', (_t, f) => {
    const context = Object.entries(f.files).filter(([k]) => k !== 'plugin-spec.yaml').map(([, v]) => v).join('\n');
    expect(context).toContain(f.installed.replace(/^v/, ''));
    expect(context).not.toContain(f.fixed.replace(/^\d+:/, '').replace(/^v/, ''));
  });

  it.each(each((f) => f.type === 'binary'))('%s: the tool version is an ARG the binary patcher can bump', (_t, f) => {
    expect(findPinnedArg(dockerfileOf(f), pinnedArgNames(f.packageName))?.value).toBe(f.installed);
  });

  it('the advisory ids are real ones (GHSA or CVE), never placeholders', () => {
    for (const f of CANARY_FIXTURES) expect(f.advisory).toMatch(/^(?:GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}|CVE-\d{4}-\d{4,})$/);
  });
});
