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

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';
import { parse } from 'yaml';
import { REPO_ROOT, read } from '../src/index.js';

/**
 * The managed toolchain release: two directories, one version, in their own
 * source root (deploy/toolchain) — one release, not catalog plugins.
 */
const TOOLCHAIN_ROOT = 'deploy/toolchain';
const BOOTSTRAP_DIR = `${TOOLCHAIN_ROOT}/pipeline-bootstrap`;
const SYNTH_DIR = `${TOOLCHAIN_ROOT}/cdk-synth`;
const BOOTSTRAP_DF = `${BOOTSTRAP_DIR}/Dockerfile`;

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

  it('every service image, pipeline-bootstrap, the plugin node base and cdk-deploy* ship projen\'s minNodeVersion', () => {
    const pairs: Array<[string, string | undefined]> = [['.projenrc.ts minNodeVersion', projenNode]];
    for (const df of [...SERVICE_DOCKERFILES, BOOTSTRAP_DF]) {
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
  it('pipeline-bootstrap and the generated workflows use the repo\'s pnpm', () => {
    const pnpm = grab('.projenrc.ts', /const pnpmVersion = '([0-9.]+)'/);
    const pairs: Array<[string, string | undefined]> = [
      ['.projenrc.ts pnpmVersion', pnpm],
      ['package.json packageManager', grab('package.json', /"packageManager":\s*"pnpm@([0-9.]+)"/)],
      ['pipeline-bootstrap PNPM_VERSION', grab(BOOTSTRAP_DF, /^ARG PNPM_VERSION="?([0-9.]+)"?\s*$/m)],
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

describe('log retention', () => {
  it('is ONE number: platform\'s query clamp and Loki\'s retention_period', () => {
    // These were two. The clamp was hard-coded at 7 days with a comment pointing
    // at `retention_period: 168h`, and only that comment kept them equal — so
    // raising retention alone would have kept 30 days of logs while the
    // dashboard still refused to show more than 7, and lowering it alone would
    // have returned an empty tail that reads as "nothing happened" rather than
    // "nothing is kept".
    //
    // Both now read LOG_RETENTION_HOURS. The DEFAULTS are what can still drift,
    // since each states its own fallback, so those are what this compares.
    const platform = grab(
      'platform/src/observability/log-controller.ts',
      /envInt\('LOG_RETENTION_HOURS',\s*(\d+)/,
    );
    const pairs: Array<[string, string | undefined]> = [['platform log-controller', platform]];
    for (const tree of ['deploy/local/docker', 'deploy/local/minikube', 'deploy/aws/eks', 'deploy/aws/ec2']) {
      pairs.push([`${tree} loki-config`, grab(
        `${tree}/config/loki/loki-config.yml`,
        /retention_period:\s*\$\{LOG_RETENTION_HOURS:-(\d+)\}h/,
      )]);
    }
    // Guards a vacuous pass: a renamed variable or a reformatted line would
    // otherwise make every entry undefined, and undefined equals undefined.
    for (const [label, value] of pairs) {
      expect({ label, found: value !== undefined }).toEqual({ label, found: true });
    }
    expectAllEqual(pairs);
  });

  it('reaches the Loki container in every target that runs one', () => {
    // `-config.expand-env` only helps if the variable is actually in the
    // container's environment; an unset one expands to the empty string and
    // Loki fails to parse `h` on its own.
    for (const tree of ['deploy/aws/eks', 'deploy/aws/ec2', 'deploy/local/minikube']) {
      expect({ tree, wired: read(`${tree}/k8s/loki.yaml`).includes('LOG_RETENTION_HOURS') })
        .toEqual({ tree, wired: true });
    }
    const compose = read('deploy/local/docker/docker-compose.yml');
    // Twice: the loki service expands it, and platform clamps to it.
    expect(compose.match(/LOG_RETENTION_HOURS/g)?.length).toBeGreaterThanOrEqual(2);
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
        grab(BOOTSTRAP_DF, /^ARG AWS_CDK_VERSION="?([0-9.]+)"?\s*$/m)],
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
    const synth = read(`${SYNTH_DIR}/Dockerfile`);
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

describe('managed toolchain release (pipeline-bootstrap + cdk-synth)', () => {
  // The failure message IS the runbook (deploy/toolchain/pipeline-bootstrap/README.md,
  // "Renovate base-digest PRs"): a Renovate `node:` digest PR stays red here until
  // someone runs the sync on its branch — a base bump is a new release.
  const SYNC = 'deploy/bin/sync-image-tags.sh --toolchain-only on this branch, then commit both deploy/toolchain/*/plugin-spec.yaml '
    + '(a Renovate base-digest PR needs this too; see deploy/toolchain/pipeline-bootstrap/README.md)';
  const bsSpec = () => parse(read(`${BOOTSTRAP_DIR}/plugin-spec.yaml`)) as Record<string, any>;
  const synthSpec = () => parse(read(`${SYNTH_DIR}/plugin-spec.yaml`)) as Record<string, any>;

  /**
   * The sourceDigest, recomputed exactly as deploy/bin/sync-image-tags.sh does:
   * every top-level file of both directories (bootstrap first, names sorted)
   * except the build outputs, config.yaml and README.md, each framed as
   * "<dir>/<file>\n" + its lines, with the GENERATED fields dropped — the
   * specs' version/toolchain/sourceDigest (and changelog), and cdk-synth's
   * `ARG BOOTSTRAP_IMAGE=` default. Keep the two in step.
   */
  function sourceDigest(): string {
    const hash = createHash('sha256');
    for (const dir of [BOOTSTRAP_DIR, SYNTH_DIR]) {
      const names = readdirSync(join(REPO_ROOT, dir))
        .filter((f) => !['image.tar', 'plugin.zip', 'config.yaml', 'README.md', '.DS_Store'].includes(f))
        .filter((f) => statSync(join(REPO_ROOT, dir, f)).isFile())
        .sort();
      for (const f of names) {
        const mode = f === 'plugin-spec.yaml' ? 'spec' : (dir === SYNTH_DIR && f === 'Dockerfile' ? 'synth-dockerfile' : 'plain');
        const lines = read(`${dir}/${f}`).split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        const out: string[] = [];
        let skip = false;
        for (const line of lines) {
          if (mode === 'spec') {
            if (skip) {
              if (/^[ \t]/.test(line) || line === '') continue;
              skip = false;
            }
            if (/^(version|toolchain|sourceDigest|changelog):/.test(line)) { skip = true; continue; }
          }
          if (mode === 'synth-dockerfile' && /^ARG BOOTSTRAP_IMAGE=/.test(line)) { out.push('ARG BOOTSTRAP_IMAGE=<generated>'); continue; }
          out.push(line);
        }
        hash.update(`${dir.split('/').pop()}/${f}\n`);
        hash.update(out.map((l) => `${l}\n`).join(''));
      }
    }
    return `sha256:${hash.digest('hex')}`;
  }

  it('both halves carry the same release version (X.Y.Z, no prerelease)', () => {
    const v = bsSpec().version;
    expect(String(v)).toMatch(/^\d+\.\d+\.\d+$/);
    expect({ cdkSynth: synthSpec().version }).toEqual({ cdkSynth: v });
  });

  it('the recorded sourceDigest matches the current build inputs', () => {
    // A stale digest means a build input changed without a new release: the
    // same version would name different bits. Fix: run the sync, commit both specs.
    const recorded = bsSpec().sourceDigest;
    const current = sourceDigest();
    expect({ sourceDigest: recorded, fix: `run ${SYNC}` }).toEqual({ sourceDigest: current, fix: `run ${SYNC}` });
  });

  it('toolchain equals the bootstrap Dockerfile ARGs', () => {
    const arg = (n: string) => grab(BOOTSTRAP_DF, new RegExp(`^ARG ${n}="?([^"\\s]+)"?\\s*$`, 'm'));
    expect({ toolchain: bsSpec().toolchain, fix: `run ${SYNC}` }).toEqual({
      toolchain: {
        pipelineManager: arg('PIPELINE_MANAGER_VERSION'),
        awsCdk: arg('AWS_CDK_VERSION'),
        cdkAssets: arg('CDK_ASSETS_VERSION'),
        esbuild: arg('ESBUILD_VERSION'),
        pnpm: arg('PNPM_VERSION'),
        node: grab(BOOTSTRAP_DF, /^ARG NODE_IMAGE=node:(\d+\.\d+\.\d+)-/m),
      },
      fix: `run ${SYNC}`,
    });
    // pipeline-manager is the released CLI.
    expect(bsSpec().toolchain.pipelineManager).toBe(JSON.parse(read('packages/pipeline-manager/package.json')).version);
  });

  it('cdk-synth is built FROM ARG BOOTSTRAP_IMAGE — this release\'s bootstrap — and nothing else', () => {
    const df = read(`${SYNTH_DIR}/Dockerfile`);
    expect(df.match(/^FROM\s+\S+/gm)).toEqual(['FROM ${BOOTSTRAP_IMAGE}']);
    expect(df).toContain(`ARG BOOTSTRAP_IMAGE="pipeline-bootstrap:${bsSpec().version}"`);
    // build-plugin-images.sh overrides it with the digest of the bootstrap it built.
    expect(read('deploy/bin/build-plugin-images.sh')).toContain('build_plugin_dir "$SYNTH_DIR/" --build-arg "BOOTSTRAP_IMAGE=${BOOTSTRAP_IMAGE_REF}"');
  });

  /**
   * Repo files (tracked + untracked, minus .gitignore'd build output) that
   * contain `needle`, outside node_modules, .git and docs/plans/.
   */
  function filesContaining(needle: RegExp): string[] {
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter((f) => f && !f.startsWith('docs/plans/') && !f.split('/').includes('node_modules'))
      .filter((f) => f !== 'test/deploy-contracts/test/toolchain-drift-contract.test.ts');
    const hits: string[] = [];
    for (const f of files) {
      const abs = join(REPO_ROOT, f);
      if (!existsSync(abs) || !statSync(abs).isFile() || statSync(abs).size > 8 * 1024 * 1024) continue;
      if (needle.test(read(f))) hits.push(f);
    }
    return hits;
  }

  it('no literal pipeline-bootstrap:1.0 tag anywhere (the tag is the release version)', () => {
    expect(filesContaining(new RegExp('pipeline-' + 'bootstrap:1\\.0(?![.\\d])'))).toEqual([]);
  });

  it('the CODEBUILD_DEFAULT_IMAGE[_DIGEST] env vars are gone (the toolchain release replaces them)', () => {
    expect(filesContaining(new RegExp('CODEBUILD_' + 'DEFAULT_IMAGE'))).toEqual([]);
  });

  it('the toolchain root holds exactly the two halves, and the catalog holds neither', () => {
    const halves = readdirSync(join(REPO_ROOT, TOOLCHAIN_ROOT)).filter((f) => statSync(join(REPO_ROOT, TOOLCHAIN_ROOT, f)).isDirectory()).sort();
    expect(halves).toEqual(['cdk-synth', 'pipeline-bootstrap']);
    const catalog = join(REPO_ROOT, 'deploy/plugins');
    const inCatalog = readdirSync(catalog)
      .filter((c) => statSync(join(catalog, c)).isDirectory())
      .flatMap((c) => halves.filter((h) => existsSync(join(catalog, c, h))).map((h) => `deploy/plugins/${c}/${h}`));
    expect(inCatalog).toEqual([]);
  });

  it('nothing references the pair\'s old catalog paths (deploy/plugins/infrastructure/…)', () => {
    // Also the category-relative form (`infrastructure/cdk-synth`) the catalog's
    // READMEs and icon table used.
    expect(filesContaining(new RegExp('infrastructure/' + '(pipeline-bootstrap|cdk-synth)\\b'))).toEqual([]);
  });

  it('nothing references the deleted deploy/codebuild/ or its build script', () => {
    expect(existsSync(join(REPO_ROOT, 'deploy', 'codebuild'))).toBe(false);
    expect(existsSync(join(REPO_ROOT, 'deploy/bin', 'build-codebuild-bootstrap.sh'))).toBe(false);
    expect(filesContaining(new RegExp(['deploy/' + 'codebuild', 'build-' + 'codebuild-bootstrap\\.sh'].join('|')))).toEqual([]);
  });
});
