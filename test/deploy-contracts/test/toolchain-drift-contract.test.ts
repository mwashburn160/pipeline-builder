// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Toolchain drift: every place that pins the same tool must pin the same
 * version. Each of these lives in several files nobody edits together — a
 * Dockerfile ARG, a projen constant, a hand-authored workflow — and a skew
 * fails silently: the release scans with a different grype than the plugin
 * service runs, a plugin compiles with an older Go than the services, CI tests
 * on a Node the images do not ship. syft had ALREADY drifted (api/plugin 1.55.0
 * vs the release's 1.52.0) when this suite was written.
 *
 * cosign has its own, stricter test (versions AND per-arch digests) in
 * hardening-contract.test.ts.
 */

import { readdirSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';
import { REPO_ROOT, read } from '../src/index.js';

/** First capture of `re` in repo file `rel`, or undefined. */
const grab = (rel: string, re: RegExp): string | undefined => re.exec(read(rel))?.[1];

/** Every workflow file, generated and hand-authored. */
const WORKFLOWS = readdirSync(join(REPO_ROOT, '.github/workflows'))
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => `.github/workflows/${f}`);

/** Every Dockerfile that builds a released service image. */
const SERVICE_DOCKERFILES = ['platform', 'frontend', 'api/ask', 'api/billing', 'api/compliance', 'api/image-registry',
  'api/message', 'api/pipeline', 'api/plugin', 'api/quota', 'api/reporting'].map((d) => `${d}/Dockerfile`);

/** Assert every [label, value] pair carries the same, defined value. */
function expectAllEqual(pairs: Array<[string, string | undefined]>): string {
  for (const [label, v] of pairs) expect([label, v]).toEqual([label, expect.any(String)]);
  const want = pairs[0][1];
  for (const [label, v] of pairs) expect([label, v]).toEqual([label, want]);
  return want as string;
}

describe('Go', () => {
  it('plugin go-base GO_VERSION == GO_IMAGE in api/plugin and api/image-registry', () => {
    const go = expectAllEqual([
      ['deploy/plugins/_base/_go-base GO_VERSION', grab('deploy/plugins/_base/_go-base/Dockerfile', /^ARG GO_VERSION=([0-9.]+)\s*$/m)],
      ['api/plugin GO_IMAGE', grab('api/plugin/Dockerfile', /^ARG GO_IMAGE=golang:([0-9.]+)-/m)],
      ['api/image-registry GO_IMAGE', grab('api/image-registry/Dockerfile', /^ARG GO_IMAGE=golang:([0-9.]+)-/m)],
    ]);
    // A full patch version, never a floating `1.27`.
    expect(go).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('Node', () => {
  const projenNode = grab('.projenrc.ts', /minNodeVersion:\s*'([0-9.]+)'/);

  it('every service image, the CodeBuild bootstrap, the plugin node base and cdk-deploy* ship projen\'s minNodeVersion', () => {
    const pairs: Array<[string, string | undefined]> = [['.projenrc.ts minNodeVersion', projenNode]];
    for (const df of [...SERVICE_DOCKERFILES, 'deploy/codebuild/bootstrap/Dockerfile']) {
      pairs.push([`${df} NODE_IMAGE`, grab(df, /^ARG NODE_IMAGE=node:([0-9.]+)-/m)]);
    }
    pairs.push(['deploy/plugins/_base/_node-base NODE_BUILD', grab('deploy/plugins/_base/_node-base/Dockerfile', /^ARG NODE_BUILD=([0-9.]+)\s*$/m)]);
    for (const p of ['deploy/plugins/deploy/cdk-deploy', 'deploy/plugins/deploy/cdk-deploy-multi-region']) {
      pairs.push([`${p} NODE_VERSION`, grab(`${p}/Dockerfile`, /^ARG NODE_VERSION=([0-9.]+)\s*$/m)]);
    }
    expect(expectAllEqual(pairs)).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('every workflow\'s setup-node pins that exact version (no floating major)', () => {
    let seen = 0;
    for (const wf of WORKFLOWS) {
      for (const [, v] of read(wf).matchAll(/node-version:\s*['"]?([^\s'"]+)/g)) {
        seen++;
        expect([wf, v]).toEqual([wf, projenNode]);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe('pnpm', () => {
  it('the CodeBuild bootstrap and the generated workflows use the repo\'s pnpm', () => {
    const pnpm = grab('.projenrc.ts', /const pnpmVersion = '([0-9.]+)'/);
    const pairs: Array<[string, string | undefined]> = [
      ['.projenrc.ts pnpmVersion', pnpm],
      ['package.json packageManager', grab('package.json', /"packageManager":\s*"pnpm@([0-9.]+)"/)],
      ['deploy/codebuild/bootstrap PNPM_VERSION', grab('deploy/codebuild/bootstrap/Dockerfile', /^ARG PNPM_VERSION="?([0-9.]+)"?\s*$/m)],
    ];
    for (const wf of WORKFLOWS) {
      // pnpm/action-setup `with: version:` — hand-authored workflows omit it
      // (the action then reads packageManager, which is checked above).
      for (const [, v] of read(wf).matchAll(/uses: pnpm\/action-setup@\S+(?:\s*#.*)?\n\s+with:\n\s+version:\s*(\S+)/g)) {
        pairs.push([`${wf} pnpm/action-setup`, v]);
      }
    }
    expectAllEqual(pairs);
  });
});

describe('AWS CDK CLI', () => {
  it('is one version across the bootstrap image and every plugin that installs it', () => {
    // WHY THIS EXISTS. Nothing held these equal and they drifted: the CodeBuild
    // bootstrap sat at 2.1126.0 while cdk-deploy and cdk-deploy-multi-region
    // moved to 2.1147.0. The CLI BUNDLES its dependencies (the published package
    // declares none), so a finding inside it cannot be patched with another
    // `npm install` — the pin is the only lever, and the stale one shipped a
    // `tar` old enough to fail the plugin vulnerability gate. A version skew
    // here also means `cdk synth` and `cdk deploy` run different CLIs against
    // one app, which is its own class of confusing failure.
    const pairs: Array<[string, string | undefined]> = [
      ['bootstrap AWS_CDK_VERSION',
        grab('deploy/codebuild/bootstrap/Dockerfile', /^ARG AWS_CDK_VERSION="?([0-9.]+)"?\s*$/m)],
      ['cdk-deploy',
        grab('deploy/plugins/deploy/cdk-deploy/Dockerfile', /aws-cdk@([0-9.]+)/)],
      ['cdk-deploy-multi-region',
        grab('deploy/plugins/deploy/cdk-deploy-multi-region/Dockerfile', /aws-cdk@([0-9.]+)/)],
    ];
    // Guards a vacuous pass: a renamed ARG or a reformatted install line would
    // otherwise make every entry undefined, and undefined equals undefined.
    for (const [label, version] of pairs) {
      expect({ label, found: version !== undefined }).toEqual({ label, found: true });
    }
    expectAllEqual(pairs);
  });

  it('is installed by exactly the plugins that need their own CLI', () => {
    // cdk-synth deliberately installs NO CDK — it is FROM pipeline-bootstrap and
    // inherits the binary. If it ever grows its own `npm install -g aws-cdk`,
    // that is a fourth pin and belongs in the list above.
    const synth = read('deploy/plugins/infrastructure/cdk-synth/Dockerfile');
    expect(synth).not.toMatch(/aws-cdk@/);
  });
});

describe('syft / grype — the release and the plugin service scan with the same tools', () => {
  const projen = read('projenrc/workflow.ts');
  const plugin = read('api/plugin/Dockerfile');

  it.each([['SYFT'], ['GRYPE']])('%s: api/plugin == projenrc/workflow.ts == every workflow that installs it (version AND sha256)', (tool) => {
    const version = new RegExp(`${tool}_VERSION:\\s*'?([0-9.]+)'?`);
    const sha = new RegExp(`${tool}_SHA256:\\s*'?([0-9a-f]{64})'?`);
    const versions: Array<[string, string | undefined]> = [
      ['api/plugin/Dockerfile', new RegExp(`^ARG ${tool}_VERSION=([0-9.]+)\\s*$`, 'm').exec(plugin)?.[1]],
      ['projenrc/workflow.ts', version.exec(projen)?.[1]],
    ];
    const shas: Array<[string, string | undefined]> = [['projenrc/workflow.ts', sha.exec(projen)?.[1]]];
    let installers = 0;
    for (const wf of WORKFLOWS) {
      const text = read(wf);
      for (const [, v] of text.matchAll(new RegExp(version, 'g'))) versions.push([wf, v]);
      for (const [, s] of text.matchAll(new RegExp(sha, 'g'))) shas.push([wf, s]);
      if (text.includes(`${tool.toLowerCase()}_\${${tool}_VERSION}_linux_amd64.tar.gz`)) installers++;
    }
    expectAllEqual(versions);
    expectAllEqual(shas);
    // Guards a vacuous pass: the release (and the scans) really install it.
    expect(installers).toBeGreaterThan(0);
  });
});
