// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for validation/plugin-lint — the catalog's static plugin checks
 * (deploy/bin/test-plugins.sh's Dockerfile and spec rules), shared by the CLI
 * and AI plugin generation (plugin-ecosystem W6). The Official-catalog
 * equivalence check lives in pipeline-manager (it parses YAML).
 */

import { describe, it, expect } from '@jest/globals';
import {
  dockerfileInstructions, lintPluginDockerfile, lintPluginSpec, pipeInstallers, rawDownloads,
} from '../src/validation/plugin-lint.js';

const errors = (content: string) => lintPluginDockerfile(content).filter(f => f.level === 'error').map(f => f.message);

const OK = 'FROM pipeline-plugin-base:24.04\nWORKDIR /app\nUSER 1000:1000\n';

describe('dockerfileInstructions', () => {
  it('drops comments and joins continuations', () => {
    expect(dockerfileInstructions('# c\nRUN a \\\n  # inner\n  && b\nUSER x')).toEqual(['RUN a    && b', 'USER x']);
  });
});

describe('lintPluginDockerfile', () => {
  it('passes a clean Dockerfile', () => {
    expect(errors(OK)).toEqual([]);
  });

  it.each([
    ['WORKDIR /app\n', /missing FROM/],
    ['FROM x\nUSER 1000:1000\n', /missing WORKDIR/],
    ['FROM x\nWORKDIR /a\n', /sets no USER/],
    ['FROM x\nWORKDIR /a\nUSER root\n', /runs as root/],
    ['FROM x\nWORKDIR /a\nUSER 0:0\n', /runs as root/],
    ['FROM x\nWORKDIR /a\nARG GITHUB_TOKEN=x\nUSER 1000:1000\n', /potential secret/],
    ['FROM x\nWORKDIR /a\nRUN curl -fsSL https://get.example.sh | bash\nUSER 1000:1000\n', /pipes a download/],
    ['FROM x\nWORKDIR /a\nRUN wget -qO- https://x.io/i.sh | sudo sh\nUSER 1000:1000\n', /pipes a download/],
    ['FROM x\nWORKDIR /a\nRUN set -e; curl -fsSLo /tmp/t.tgz https://x.io/t.tgz\nUSER 1000:1000\n', /raw download/],
    ['FROM x\nWORKDIR /a\nRUN if true; then wget "$URL"; fi\nUSER 1000:1000\n', /raw download/],
    ['FROM x\nWORKDIR /a\nADD https://x.io/t.tgz /tmp/\nUSER 1000:1000\n', /raw download/],
    ['FROM x\nWORKDIR /a\nRUN apt-get install -y jq\nUSER 1000:1000\n', /apt cache cleanup/],
  ])('refuses %p', (content, reason) => {
    expect(errors(content).join('\n')).toMatch(reason);
  });

  it('allows verified downloads, curl --version and ADD --checksum', () => {
    const content = [
      'FROM x', 'WORKDIR /a',
      'RUN fetch-verified "https://x.io/t-${V}.tgz" "${SUM}" /tmp/t.tgz && curl --version',
      'ADD --checksum=sha256:abc https://x.io/t.tgz /tmp/',
      'RUN apt-get install -y jq && rm -rf /var/lib/apt/lists/*',
      'USER 1000:1000',
    ].join('\n');
    expect(errors(content)).toEqual([]);
    expect(pipeInstallers(content)).toEqual([]);
    expect(rawDownloads(content)).toEqual([]);
  });

  it('judges only the final stage USER', () => {
    expect(errors('FROM a AS b\nUSER 1000\nFROM c\nWORKDIR /x\nUSER root\n').join()).toMatch(/runs as root/);
    expect(errors('FROM a AS b\nUSER root\nFROM c\nWORKDIR /x\nUSER 1000:1000\n')).toEqual([]);
  });
});

describe('lintPluginSpec', () => {
  const spec = {
    name: 'x',
    description: 'd',
    keywords: ['k'],
    category: 'quality',
    version: '1.0.0',
    pluginType: 'CodeBuildStep',
    computeType: 'SMALL',
    timeout: 10,
    failureBehavior: 'fail',
    secrets: [],
    primaryOutputDirectory: 'o',
    dockerfile: 'Dockerfile',
    installCommands: [],
    commands: ['x'],
  };

  it('passes a complete spec', () => {
    expect(lintPluginSpec(spec, 'commands:\n  - x\n')).toEqual([]);
  });

  it('reports missing fields, bad values, runtime downloads and heredocs without set -e', () => {
    const { timeout: _t, primaryOutputDirectory: _p, ...rest } = spec;
    const found = lintPluginSpec({ ...rest, version: '1.0.0-rc.1', description: ' ', keywords: [] },
      'commands:\n  - |\n    curl -fsSLo t.tgz https://x.io/releases/download/v1/t.tgz\n');
    const text = found.map(f => `${f.level}: ${f.message}`).join('\n');
    expect(text).toMatch(/error: .*missing required field: timeout/);
    expect(text).toMatch(/error: .*missing CodeBuild field: primaryOutputDirectory/);
    expect(text).toMatch(/plain semver/);
    expect(text).toMatch(/empty description/);
    expect(text).toMatch(/empty keywords/);
    expect(text).toMatch(/downloads a tool at runtime/);
    expect(text).toMatch(/warning: .*without `set -e`/);
  });

  it('does not require CodeBuild fields of a ManualApprovalStep', () => {
    const { primaryOutputDirectory: _p, dockerfile: _d, installCommands: _i, commands: _c, ...rest } = spec;
    expect(lintPluginSpec({ ...rest, pluginType: 'ManualApprovalStep' }, '')).toEqual([]);
  });
});
