// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The nightly remediation canary (plan "Tests and delivery"): one small fixture
 * plugin per package type, kept in the SYSTEM org, each pinned to a library
 * version with a known, fixable HIGH advisory (High, not Critical, so the
 * build gate stores it). Every night the rescan targets it and remediation
 * runs it as a DRY RUN — built, patched and verified exactly like a real one,
 * but never published — and records the outcome:
 *
 *   plugin_remediation_canary_last_success_timestamp_seconds   the last pass in which EVERY fixture came out clean
 *   plugin_remediation_canary_ok{type}                          1 = flagged and fixed on its last run
 *
 * A fixture that stops being targeted, or stops coming out clean, means the
 * scanner or that type's patcher broke (the stale-canary alert watches the
 * timestamp). The same fixtures drive the per-type engine tests.
 *
 * Fixtures are loaded into the system org by {@link ensureRemediationCanaries}
 * (a build per missing fixture, through the normal build queue) at the end of
 * each completed rescan pass.
 */

import { randomUUID } from 'crypto';
import path from 'path';

import { createLogger, errorMessage, isSystemOrgId, SYSTEM_ACTOR_ID, SYSTEM_ORG_ID, type GrypePackageType } from '@pipeline-builder/api-core';
import { setGauge } from '@pipeline-builder/api-server';
import { Config } from '@pipeline-builder/pipeline-core';
import { schema } from '@pipeline-builder/pipeline-data';
import AdmZip from 'adm-zip';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { elevatedTx } from './store.js';
import { BUILD_TEMP_ROOT } from '../../helpers/docker-build.js';
import { createBuildJobData } from '../../helpers/plugin-helpers.js';
import type { RegistryInfo } from '../../helpers/registry-auth.js';
import { pluginArtifactKey, putPluginArtifact } from '../plugin-artifact-storage.js';

const logger = createLogger('plugin-remediation-canary');

export const CANARY_PREFIX = 'remediation-canary-';
export const CANARY_VERSION = '1.0.0';

export interface CanaryFixture {
  type: GrypePackageType;
  /** The package carrying the known advisory, its pinned version and the version that fixes it. */
  packageName: string;
  installed: string;
  fixed: string;
  advisory: string;
  /** The build context (relative path → content); plugin-spec.yaml and config.yaml are added. */
  files: Record<string, string>;
}

const df = (...lines: string[]): string => `${lines.join('\n')}\n`;

/**
 * One fixture per package type the patcher table covers. Each must, on amd64
 * AND arm64 (test/remediation-canary-fixtures.test.ts holds these):
 *
 *  - build offline-complete: go.sum and a checksummed Cargo.lock beside the
 *    manifests, an architecture taken from `${TARGETARCH}`, never hard-coded;
 *  - pass the build gate: bases are VERSION TAGS (a digest pin ages into fixable
 *    Criticals before a new install loads it; the remediation rebuild pulls the
 *    tag), and the published stage upgrades its base packages, so the pinned
 *    package is the only one carrying a fixable High;
 *  - stay fixable by the dry run under the system org's DEFAULT settings: the
 *    fix is within `DEFAULT_LIBRARY_UPGRADE_LEVEL`, and `fixed` is the highest
 *    fix grype reports for the package (what api-core `chooseFixVersion` picks).
 *
 * OS packages need the vulnerable version from somewhere the live archive no
 * longer keeps it: deb from a frozen snapshot.debian.org trixie-security, rpm
 * from AlmaLinux's 9.8 vault, apk from the alpine:3.24.3 patch release with
 * the package held back from `apk upgrade` (so the overlay, not a source
 * patch, fixes it). The fixed versions come from the live archives.
 *
 * Last verified 2026-11-21 with syft 1.56 + grype 0.121 (the plugin image's
 * scan path) on linux/amd64 and linux/arm64. A fixture whose package gets a new
 * advisory keeps working (the fix moves with it); one whose new advisory is
 * Critical, or whose fix leaves the default upgrade level, needs re-pinning.
 */
export const CANARY_FIXTURES: readonly CanaryFixture[] = [
  {
    type: 'deb',
    packageName: 'libexpat1',
    installed: '2.8.3-1~deb13u1',
    fixed: '2.9.0-1~deb13u1',
    advisory: 'CVE-2026-66046',
    files: {
      Dockerfile: df(
        'FROM debian:13-slim',
        'RUN echo \'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20261001T000000Z trixie-security main\' > /etc/apt/sources.list.d/canary-snapshot.list \\',
        '    && apt-get update && apt-get upgrade -y \\',
        '    && apt-get install -y --no-install-recommends libexpat1=2.8.3-1~deb13u1 \\',
        '    && rm -rf /var/lib/apt/lists/*',
        'USER 1000:1000',
      ),
    },
  },
  {
    type: 'apk',
    packageName: 'libcrypto3',
    installed: '3.5.9-r0',
    fixed: '3.5.9-r1',
    advisory: 'CVE-2026-88823',
    files: { Dockerfile: df('FROM alpine:3.24.3', 'RUN apk upgrade --no-cache --ignore libcrypto3 libssl3 && apk add --no-cache bash', 'USER 1000:1000') },
  },
  {
    type: 'rpm',
    packageName: 'expat',
    installed: '2.5.0-6.el9_8.7',
    fixed: '0:2.5.0-9.el9_9.8',
    advisory: 'CVE-2026-115506',
    files: {
      Dockerfile: df(
        'FROM almalinux:9-minimal',
        'RUN printf \'[canary-vault]\\nname=AlmaLinux 9.8 BaseOS (vault)\\nbaseurl=https://vault.almalinux.org/9.8/BaseOS/$basearch/os/\\ngpgcheck=1\\ngpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-AlmaLinux-9\\n\' > /etc/yum.repos.d/canary-vault.repo \\',
        '    && microdnf upgrade -y && microdnf install -y expat-2.5.0-6.el9_8.7 && microdnf clean all',
        'USER 1000:1000',
      ),
    },
  },
  {
    type: 'npm',
    packageName: 'lodash',
    installed: '4.17.21',
    fixed: '4.18.0',
    advisory: 'GHSA-r5fr-rjxr-66jc',
    files: {
      // npm itself is removed after the install: its bundled dependencies carry advisories of their own.
      'Dockerfile': df(
        'FROM node:24-alpine',
        'RUN apk upgrade --no-cache',
        'WORKDIR /app',
        'COPY package.json package-lock.json ./',
        'RUN npm ci --ignore-scripts \\',
        '    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg',
        'USER node',
      ),
      'package.json': `${JSON.stringify({ name: 'remediation-canary-npm', version: '1.0.0', private: true, dependencies: { lodash: '4.17.21' } }, null, 2)}\n`,
      'package-lock.json': `${JSON.stringify({ name: 'remediation-canary-npm', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'remediation-canary-npm', version: '1.0.0', dependencies: { lodash: '4.17.21' } }, 'node_modules/lodash': { version: '4.17.21' } } }, null, 2)}\n`,
    },
  },
  {
    type: 'python',
    packageName: 'urllib3',
    installed: '2.7.0',
    fixed: '2.8.0',
    advisory: 'GHSA-vxq7-64xx-v4gw',
    files: {
      'Dockerfile': df('FROM python:3.12-slim', 'RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*', 'COPY requirements.txt /tmp/requirements.txt', 'RUN pip install --no-cache-dir -r /tmp/requirements.txt', 'USER 1000:1000'),
      'requirements.txt': 'urllib3==2.7.0\n',
    },
  },
  {
    type: 'go-module',
    packageName: 'github.com/golang-jwt/jwt/v5',
    installed: 'v5.2.1',
    fixed: 'v5.2.2',
    advisory: 'GHSA-mh63-6h87-95cp',
    files: {
      'Dockerfile': df('FROM golang:1.27-alpine AS build', 'WORKDIR /src', 'COPY . .', 'RUN CGO_ENABLED=0 go build -o /canary .', 'FROM alpine:3.24', 'RUN apk upgrade --no-cache', 'COPY --from=build /canary /usr/local/bin/canary', 'USER 1000:1000'),
      'go.mod': 'module example.com/canary\n\ngo 1.22\n\nrequire github.com/golang-jwt/jwt/v5 v5.2.1\n',
      'go.sum': 'github.com/golang-jwt/jwt/v5 v5.2.1 h1:OuVbFODueb089Lh128TAcimifWaLhJwVflnrgM17wHk=\ngithub.com/golang-jwt/jwt/v5 v5.2.1/go.mod h1:pqrtFR0X4osieyHYxtmOUWsAWrfe1Q5UVIyoH402zdk=\n',
      'main.go': 'package main\n\nimport (\n\t"fmt"\n\n\t"github.com/golang-jwt/jwt/v5"\n)\n\nfunc main() { fmt.Println(jwt.SigningMethodHS256.Alg()) }\n',
    },
  },
  {
    type: 'java-archive',
    packageName: 'jackson-databind',
    installed: '2.18.10',
    fixed: '2.18.11',
    advisory: 'GHSA-cxp5-3px4-pw24',
    files: {
      // The jars alone: a JRE in the published stage would bring the JDK's own advisories.
      'Dockerfile': df('FROM maven:3.9-eclipse-temurin-21 AS build', 'WORKDIR /src', 'COPY pom.xml .', 'RUN mvn -q dependency:copy-dependencies -DoutputDirectory=/libs', 'FROM alpine:3.24', 'RUN apk upgrade --no-cache', 'COPY --from=build /libs /opt/libs', 'USER 1000:1000'),
      'pom.xml': '<project>\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>example</groupId>\n  <artifactId>canary</artifactId>\n  <version>1.0.0</version>\n  <dependencies>\n    <dependency>\n      <groupId>com.fasterxml.jackson.core</groupId>\n      <artifactId>jackson-databind</artifactId>\n      <version>2.18.10</version>\n    </dependency>\n  </dependencies>\n</project>\n',
    },
  },
  {
    type: 'gem',
    packageName: 'rack',
    installed: '2.2.24',
    fixed: '2.2.25',
    advisory: 'GHSA-5v64-555j-wjxm',
    files: {
      'Dockerfile': df('FROM ruby:3.3-slim', 'RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*', 'WORKDIR /app', 'COPY Gemfile Gemfile.lock ./', 'RUN bundle install', 'USER 1000:1000'),
      'Gemfile': "source 'https://rubygems.org'\ngem 'rack', '~> 2.2'\n",
      'Gemfile.lock': 'GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (2.2.24)\n\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n  rack (~> 2.2)\n',
    },
  },
  {
    type: 'rust-crate',
    packageName: 'regex',
    installed: '1.5.4',
    fixed: '1.5.5',
    advisory: 'GHSA-m5pq-gvj9-9vr8',
    files: {
      // `cargo auditable` embeds the dependency list in the binary: without it syft sees no crates at all.
      'Dockerfile': df('FROM alpine:3.24 AS build', 'RUN apk add --no-cache cargo cargo-auditable', 'WORKDIR /src', 'COPY . .', 'RUN cargo auditable build --release --locked', 'FROM alpine:3.24', 'RUN apk upgrade --no-cache && apk add --no-cache libgcc', 'COPY --from=build /src/target/release/canary /usr/local/bin/canary', 'USER 1000:1000'),
      'Cargo.toml': '[package]\nname = "canary"\nversion = "1.0.0"\nedition = "2021"\n\n[dependencies]\nregex = "1.5"\n',
      'Cargo.lock': [
        '# This file is automatically @generated by Cargo.',
        '# It is not intended for manual editing.',
        'version = 4',
        '',
        '[[package]]',
        'name = "aho-corasick"',
        'version = "0.7.20"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        'checksum = "cc936419f96fa211c1b9166887b38e5e40b19958e5b895be7c1f93adec7071ac"',
        'dependencies = [',
        ' "memchr",',
        ']',
        '',
        '[[package]]',
        'name = "canary"',
        'version = "1.0.0"',
        'dependencies = [',
        ' "regex",',
        ']',
        '',
        '[[package]]',
        'name = "memchr"',
        'version = "2.8.3"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        'checksum = "cf8baf1c55e62ffcace7a9f06f4bd9cd3f0c4beb022d3b367256b91b87513d98"',
        '',
        '[[package]]',
        'name = "regex"',
        'version = "1.5.4"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        'checksum = "d07a8629359eb56f1e2fb1652bb04212c072a87ba68546a04065d525673ac461"',
        'dependencies = [',
        ' "aho-corasick",',
        ' "memchr",',
        ' "regex-syntax",',
        ']',
        '',
        '[[package]]',
        'name = "regex-syntax"',
        'version = "0.6.29"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        'checksum = "f162c6dd7b008981e4d40210aca20b4bd0f9b60ca9271061b07f78537722f2e1"',
        '',
      ].join('\n'),
      'src/main.rs': 'fn main() { println!("{}", regex::Regex::new("a+").unwrap().is_match("aa")); }\n',
    },
  },
  {
    type: 'dotnet',
    packageName: 'Snappier',
    installed: '1.3.0',
    fixed: '1.3.1',
    advisory: 'GHSA-pggp-6c3x-2xmx',
    files: {
      'Dockerfile': df('FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build', 'WORKDIR /src', 'COPY . .', 'RUN dotnet publish -c Release -o /out', 'FROM mcr.microsoft.com/dotnet/runtime:10.0', 'RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*', 'COPY --from=build /out /app', 'USER 1000:1000'),
      'Canary.csproj': '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net10.0</TargetFramework>\n  </PropertyGroup>\n  <ItemGroup>\n    <PackageReference Include="Snappier" Version="1.3.0" />\n  </ItemGroup>\n</Project>\n',
      'Program.cs': 'System.Console.WriteLine(Snappier.Snappy.CompressToArray(new byte[] { 1, 2, 3 }).Length);\n',
    },
  },
  {
    type: 'binary',
    packageName: 'node',
    installed: '24.22.2',
    fixed: '24.22.3',
    advisory: 'CVE-2026-123865',
    files: {
      // A tool downloaded at a pinned ARG, for the build's own architecture; only the binary is published.
      Dockerfile: df(
        'FROM debian:13-slim AS fetch',
        'ARG TARGETARCH',
        'ARG NODE_VERSION=24.22.2',
        'RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \\',
        '    && case "${TARGETARCH}" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; esac \\',
        '    && curl -fsSLo /tmp/node.tar.gz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.gz" \\',
        '    && tar -xzf /tmp/node.tar.gz -C /usr/local/bin --strip-components=2 "node-v${NODE_VERSION}-linux-${arch}/bin/node"',
        'FROM debian:13-slim',
        'RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*',
        'COPY --from=fetch /usr/local/bin/node /usr/local/bin/node',
        'USER 1000:1000',
      ),
    },
  },
];

export const canaryPluginName = (type: GrypePackageType): string => `${CANARY_PREFIX}${type.replace(/[^a-z0-9]+/g, '-')}`;
export const isCanaryPlugin = (orgId: string, name: string): boolean => isSystemOrgId(orgId) && name.startsWith(CANARY_PREFIX);
export const canaryFixtureFor = (name: string): CanaryFixture | null => CANARY_FIXTURES.find((f) => canaryPluginName(f.type) === name) ?? null;

/** The full fixture context (Dockerfile, manifests, plugin-spec.yaml, config.yaml). */
export function canaryContext(f: CanaryFixture): Record<string, string> {
  const name = canaryPluginName(f.type);
  return {
    ...f.files,
    'config.yaml': 'pluginSpec: plugin-spec.yaml\ndockerfile: Dockerfile\nbuildType: build_image\n',
    'plugin-spec.yaml': [
      `name: ${name}`,
      `description: Remediation canary for ${f.type} packages (pinned to ${f.packageName} ${f.installed}, fixed in ${f.fixed})`,
      'category: quality',
      `version: ${CANARY_VERSION}`,
      'pluginType: CodeBuildStep',
      'computeType: SMALL',
      'dockerfile: Dockerfile',
      'commands:',
      '  - echo canary',
      'smokeTest: "true"',
      '',
    ].join('\n'),
  };
}

/** Record one canary run's outcome (`plugin_remediation_canary_ok{type}`), then refresh the fleet gauge. */
export async function recordCanaryOutcome(name: string, ok: boolean): Promise<void> {
  const f = canaryFixtureFor(name);
  if (!f) return;
  setGauge('plugin_remediation_canary_ok', { type: f.type }, ok ? 1 : 0);
  await refreshCanaryGauge();
}

export interface CanaryStatus {
  fixtures: number;
  /** Fixture plugin names whose latest run was not flagged-and-fixed clean (or never ran). */
  failing: string[];
  /** When the latest all-clean pass finished (the newest of its runs), or null. */
  lastPassAt: Date | null;
}

/** The canary's state from the remediation rows (the same answer on every pod). */
export async function canaryStatus(): Promise<CanaryStatus> {
  const r = schema.pluginRemediation;
  const names = CANARY_FIXTURES.map((f) => canaryPluginName(f.type));
  const rows = await elevatedTx((tx) => tx.select({ name: r.pluginName, stage: r.stage, outcome: r.outcome, createdAt: r.createdAt, finishedAt: r.finishedAt })
    .from(r).where(and(eq(r.orgId, SYSTEM_ORG_ID), inArray(r.pluginName, names)))) as Array<{ name: string; stage: string; outcome: string | null; createdAt: Date; finishedAt: Date | null }>;
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const cur = latest.get(row.name);
    if (!cur || row.createdAt > cur.createdAt) latest.set(row.name, row);
  }
  const failing = names.filter((n) => { const l = latest.get(n); return !l || l.stage !== 'done' || l.outcome !== 'cleared'; });
  const lastPassAt = failing.length === 0
    ? names.map((n) => latest.get(n)!.finishedAt).reduce<Date | null>((m, d) => (d && (!m || d > m) ? d : m), null)
    : null;
  return { fixtures: names.length, failing, lastPassAt };
}

/**
 * `plugin_remediation_canary_last_success_timestamp_seconds`: when the latest
 * pass in which EVERY fixture came out flagged-and-fixed clean finished
 * (PluginRemediationCanaryStale fires past 48 h). Left untouched while a
 * fixture is failing, so the timestamp ages. Never throws.
 */
export async function refreshCanaryGauge(): Promise<void> {
  try {
    const status = await canaryStatus();
    if (status.lastPassAt) setGauge('plugin_remediation_canary_last_success_timestamp_seconds', {}, Math.floor(status.lastPassAt.getTime() / 1000));
  } catch (err) {
    logger.debug('Canary gauge not refreshed', { error: errorMessage(err) });
  }
}

/** Enqueue a system-org build for every fixture not yet stored. Never throws. */
export async function ensureRemediationCanaries(enqueue: (jobName: string, data: ReturnType<typeof createBuildJobData>) => Promise<void>): Promise<number> {
  try {
    const p = schema.plugin;
    const names = CANARY_FIXTURES.map((f) => canaryPluginName(f.type));
    const present = new Set((await elevatedTx((tx) => tx.select({ name: p.name }).from(p)
      .where(and(eq(p.orgId, SYSTEM_ORG_ID), inArray(p.name, names), isNull(p.deletedAt)))) as Array<{ name: string }>).map((r) => r.name));
    let queued = 0;
    for (const f of CANARY_FIXTURES) {
      const name = canaryPluginName(f.type);
      if (present.has(name)) continue;
      const zip = new AdmZip();
      for (const [file, content] of Object.entries(canaryContext(f))) zip.addFile(file, Buffer.from(content, 'utf8'));
      const requestId = randomUUID();
      const s3Key = pluginArtifactKey(SYSTEM_ORG_ID, requestId);
      await putPluginArtifact(s3Key, zip.toBuffer());
      const data = createBuildJobData({
        requestId,
        orgId: SYSTEM_ORG_ID,
        userId: SYSTEM_ACTOR_ID,
        access: { isSystemAdmin: true, canPublish: true },
        buildRequest: {
          // Not on this replica: the worker rehydrates the context from `s3Key`.
          contextDir: path.join(BUILD_TEMP_ROOT, `canary-${requestId}`),
          s3Key,
          dockerfile: 'Dockerfile',
          name,
          version: CANARY_VERSION,
          orgId: SYSTEM_ORG_ID,
          registry: Config.get('registry') as RegistryInfo,
          buildArgs: {},
          buildType: 'build_image',
        },
        pluginRecord: { orgId: SYSTEM_ORG_ID, name, version: CANARY_VERSION, commands: ['echo canary'], visibility: 'private', dockerfile: f.files.Dockerfile ?? null, smokeTest: 'true', category: 'quality', description: `Remediation canary (${f.type})` },
      });
      // No plugins-quota slot was reserved, so none is released either.
      await enqueue(`${name}:${CANARY_VERSION}`, { ...data, quotaReleased: true });
      queued++;
    }
    return queued;
  } catch (err) {
    logger.warn('Remediation canary fixtures not loaded', { error: errorMessage(err) });
    return 0;
  }
}
