// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end: the real `pipeline-manager` command tree, driven in-process
 * against a local stub of the platform API (test/e2e/helpers/stub-platform.ts).
 *
 * One signed-in developer's day, in order — each test builds on the state the
 * previous one left in the temp HOME, exactly as consecutive shell commands do:
 *
 *   auth login (device flow, --org)  →  status  →  pipeline create  →
 *   pipeline list (expired session → refresh)  →  pipeline synth (real CDK
 *   assembly)  →  a revoked session and a rejected key fail with exit codes.
 *
 * Asserted at the edges a user and the platform see: exit codes, stdout, the
 * stored credentials file, and the request payloads on the wire.
 *
 * HERMETIC: temp HOME and config, 127.0.0.1 only, no AWS (the synth's `cdk`
 * is a shim that runs the CLI's own CDK app — see helpers/cdk-shim.ts).
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { STEP_MANIFEST_FILE } from '@pipeline-builder/pipeline-core';
import { installCdkShim, type CdkShim } from './helpers/cdk-shim.js';
import { runCli, type RunOptions } from './helpers/run-cli.js';
import { startStubPlatform, TOOLCHAIN, type StubPlatform } from './helpers/stub-platform.js';

// The only seam: the CLI probes for `cdk` with an execSync that does not pass
// an env, so it cannot see the shim's PATH from inside a jest sandbox. The probe
// answers "installed"; the synth itself still goes through the real
// executeCdkShellCommand (which does pass the env) to the shim.
const actualCdkUtils = await import('../../src/utils/cdk-utils.js');
jest.unstable_mockModule('../../src/utils/cdk-utils.js', () => ({
  ...actualCdkUtils,
  getCdkInfo: () => ({ available: true, version: '2.1148.1 (shim)' }),
  checkCdkAvailable: () => true,
  ensureCdkAvailable: () => undefined,
}));

interface StoreFile {
  version: number;
  activePlatform?: string;
  sessions: Record<string, { accessToken: string; refreshToken?: string; expiresAt: number; organizationId?: string; savedAt: string }>;
}

const ROOT = mkdtempSync(join(os.tmpdir(), 'pm-e2e-'));
const HOME = join(ROOT, 'home');
const WORK = join(ROOT, 'work');
const STORE = join(HOME, '.pipeline-manager', 'credentials.json');
const cwd = process.cwd();

let stub: StubPlatform;
let shim: CdkShim;
let baseEnv: Record<string, string | undefined>;
let pipelineId: string;
let synthStdout = '';

const readStore = (): StoreFile => JSON.parse(readFileSync(STORE, 'utf-8')) as StoreFile;
const session = () => readStore().sessions[stub.url.toLowerCase()];

function cli(args: string[], options: RunOptions = {}) {
  return runCli(HOME, args, { env: { ...baseEnv, ...options.env } });
}

beforeAll(async () => {
  mkdirSync(HOME, { recursive: true });
  mkdirSync(WORK, { recursive: true });
  // An empty project config, so the package's own config.yml (localhost:8443)
  // is not what resolves the platform — `auth login --url` must be.
  const config = join(ROOT, 'config.yml');
  writeFileSync(config, 'api: {}\n');

  stub = await startStubPlatform();
  shim = installCdkShim(ROOT);
  baseEnv = {
    CLI_CONFIG_PATH: config,
    PATH: `${shim.binDir}:${process.env.PATH ?? ''}`,
    // No credential or platform may leak in from the developer's shell or CI.
    PLATFORM_TOKEN: undefined,
    PLATFORM_BASE_URL: undefined,
    PLATFORM_SECRET_NAME: undefined,
    PIPELINE_ID: undefined,
    CODEBUILD_BUILD_ID: undefined,
    IMAGE_REGISTRY_PULL_HOST: undefined,
    NODE_ENV: undefined,
    DEBUG: undefined,
    CI: 'true', // never try to open a browser
    NO_COLOR: '1',
  };
  // `pipeline create` writes ./output/pipeline-<id>.json next to the caller.
  process.chdir(WORK);
}, 60_000);

afterAll(async () => {
  process.chdir(cwd);
  await stub?.close();
  shim?.cleanup();
  rmSync(ROOT, { recursive: true, force: true });
});

describe('pipeline-manager e2e (stub platform)', () => {
  it('auth login: device flow, then switches org and keeps the sign-in refresh token', async () => {
    const before = Date.now();
    const res = await cli(['auth', 'login', '--url', stub.url, '--no-browser', '--org', 'org-2']);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Your code:  WXYZ-1234');
    expect(res.stdout).toContain(`${stub.url}/device?code=WXYZ-1234`);
    expect(res.stdout).toContain('Switched to organization org-2');
    expect(res.stdout).toContain('Signed in');

    // Wire: every auth call declares the CLI transport; the poll honoured
    // `authorization_pending` and came back with the device code.
    const [code] = stub.calls('/api/auth/device/code', 'POST');
    expect(code!.headers['x-pb-client']).toBe('cli');
    const polls = stub.calls('/api/auth/device/token', 'POST');
    expect(polls).toHaveLength(2);
    for (const poll of polls) {
      expect(poll.body).toEqual({ device_code: 'dc-secret-1' });
      expect(poll.headers['x-pb-client']).toBe('cli');
    }
    const [sw] = stub.calls('/api/auth/switch-org', 'POST');
    expect(sw!.body).toEqual({ organizationId: 'org-2' });
    expect(sw!.headers.authorization).toBe('Bearer at-1');
    expect(sw!.headers['x-pb-client']).toBe('cli');

    // Store: the SWITCHED access token, the sign-in's refresh token (switch-org
    // returns only an access token; its decoy refresh token is ignored), the
    // switched expiry, owner-only file, and this platform remembered as active.
    const store = readStore();
    expect(store.version).toBe(1);
    expect(store.activePlatform).toBe(stub.url);
    const s = session()!;
    expect(s.accessToken).toBe('at-2');
    expect(s.refreshToken).toBe('rt-1');
    expect(s.organizationId).toBe('org-2');
    expect(s.expiresAt).toBeGreaterThanOrEqual(before + 600_000);
    expect(s.expiresAt).toBeLessThan(Date.now() + 900_000);
    expect((statSync(STORE).mode % 0o1000).toString(8)).toBe('600');
  }, 30_000);

  it('status --json: reports the stored session and that the platform accepts it', async () => {
    const res = await cli(['status', '--json']);

    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as Record<string, string>;
    expect(out).toMatchObject({
      'success': true as unknown as string,
      'Platform': stub.url,
      'Credential': 'stored session ("auth login")',
      'Platform Health': 'reachable',
      'Signed In': 'yes',
      'Signed In As': 'dev@acme.test',
      'Organization': 'Acme',
      'Token Expired': 'no',
    });
    const [profile] = stub.calls('/api/user/profile', 'GET');
    expect(profile!.headers.authorization).toBe('Bearer at-2');
  });

  it('pipeline create -f props.json: posts the resolved create request', async () => {
    const props = {
      project: 'checkout',
      organization: 'acme',
      synth: {
        source: { type: 'github', options: { repo: 'acme/checkout', branch: 'main' } },
        plugin: { name: 'cdk-synth' },
      },
    };
    writeFileSync(join(WORK, 'props.json'), JSON.stringify(props));

    const res = await cli(['pipeline', 'create', '-f', 'props.json']);

    expect(res.code).toBe(0);
    const [create] = stub.calls('/api/pipelines', 'POST');
    expect(create!.query).toEqual({});
    expect(create!.headers.authorization).toBe('Bearer at-2');
    expect(create!.body).toEqual({
      project: 'checkout',
      organization: 'acme',
      pipelineName: 'acme-checkout-pipeline',
      props,
      visibility: 'org',
      isActive: true,
    });
    pipelineId = [...stub.state.pipelines.keys()][0]!;
    expect(res.stdout).toContain(pipelineId);
    const saved = JSON.parse(readFileSync(join(WORK, 'output', `pipeline-${pipelineId}.json`), 'utf-8')) as { id: string };
    expect(saved.id).toBe(pipelineId);
  });

  it('expired session: renewed before any command (X-Pb-Client: cli) and the rotated pair stored', async () => {
    // Age the stored access token past its expiry, as a day off would.
    const store = readStore();
    store.sessions[stub.url.toLowerCase()]!.expiresAt = Date.now() - 1_000;
    writeFileSync(STORE, JSON.stringify(store));

    // Regression: commands on the SYNC client (`pipeline list`) used to exit
    // "Not signed in" on an expired session — only the async path renewed. The
    // CLI now renews an expired stored session before ANY command runs.
    const listed = await cli(['pipeline', 'list', '--format', 'json']);
    expect(listed.code).toBe(0);
    const [refresh] = stub.calls('/api/auth/refresh', 'POST');
    expect(refresh!.headers['x-pb-client']).toBe('cli');
    expect(stub.calls('/api/pipelines', 'GET').length).toBeGreaterThan(0);

    // The renewed pair was stored, so the async path needs no second refresh.
    const res = await cli(['pipeline', 'synth', '--id', pipelineId, '--show-resolved']);
    expect(res.code).toBe(0);
    expect(refresh!.body).toEqual({ refreshToken: 'rt-1' });
    // Renewed by the pre-command hook on the earlier `pipeline list`, so this run
    // simply uses the stored pair.
    expect(res.stderr).toContain('Using the stored session');

    const s = session()!;
    expect(s.accessToken).toBe('at-3');
    expect(s.refreshToken).toBe('rt-1-rotated');
    expect(s.organizationId).toBe('org-2');
    expect(s.expiresAt).toBeGreaterThan(Date.now());
    const [get] = stub.calls(`/api/pipelines/${pipelineId}`, 'GET');
    expect(get!.headers.authorization).toBe('Bearer at-3');
    // --show-resolved prints the resolved props: the ids, the plugins and the
    // toolchain release the synth would use.
    const resolved = JSON.parse(res.stdout.slice(res.stdout.indexOf('{'))) as Record<string, unknown>;
    expect(resolved).toMatchObject({ pipelineId, orgId: 'org-1', project: 'checkout' });

    // And with a fresh session the synchronous path works again.
    const list = await cli(['pipeline', 'list', '--format', 'json', '--project', 'checkout']);
    expect(list.code).toBe(0);
    const query = stub.calls('/api/pipelines', 'GET').at(-1);
    expect(query!.query).toMatchObject({ project: 'checkout', limit: '50', offset: '0' });
    expect(list.stdout).toContain(pipelineId);
  }, 30_000);

  it('pipeline synth --json: resolves plugins + toolchain and writes a real CDK assembly', async () => {
    const outDir = join(ROOT, 'cdk.out');
    const lookupsBefore = stub.calls('/api/plugins/lookup', 'POST').length;

    // The stub listens on 127.0.0.1, which the synth rightly refuses as an image
    // pull host CodeBuild can't reach; name a public one, as an operator would.
    const res = await cli(['pipeline', 'synth', '--id', pipelineId, '--output', outDir, '--json'], {
      env: { IMAGE_REGISTRY_PULL_HOST: 'registry.acme.test' },
    });

    expect(res.code).toBe(0);
    synthStdout = res.stdout;
    const out = JSON.parse(res.stdout.slice(res.stdout.lastIndexOf('{\n  "success"'))) as { success: boolean; output: string };
    expect(out).toMatchObject({ success: true, output: outDir });

    // Both toolchain halves were looked up, each recorded against the pipeline.
    const lookups = stub.calls('/api/plugins/lookup', 'POST').slice(lookupsBefore).map((r) => r.body as Record<string, unknown>);
    expect(lookups).toEqual(expect.arrayContaining([
      expect.objectContaining({ filter: expect.objectContaining({ name: 'cdk-synth' }), context: { pipelineId, stepKeys: ['synth'] } }),
      expect.objectContaining({ filter: { name: 'pipeline-bootstrap' }, context: { pipelineId, stepKeys: ['build-image'] } }),
    ]));

    // The CLI built the command the CDK CLI expects.
    const invocations = readFileSync(shim.logFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    const synth = invocations.find((a) => a[0] === 'synth')!;
    expect(synth).toEqual(expect.arrayContaining([`--output=${outDir}`]));
    expect(synth.find((a) => a.startsWith('--app='))).toMatch(/^--app=node \S*boilerplate\.js$/);

    // A cloud assembly with the pipeline stack, its CodePipeline, and the step
    // manifest `deploy` ships with the registry registration.
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(true);
    const templateFile = readdirSync(outDir).find((f) => f.endsWith('.template.json'))!;
    expect(templateFile).toBeDefined();
    const template = JSON.parse(readFileSync(join(outDir, templateFile), 'utf-8')) as { Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }> };
    const pipelines = Object.values(template.Resources).filter((r) => r.Type === 'AWS::CodePipeline::Pipeline');
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0]!.Properties!.Name).toBe('acme-checkout-pipeline');
    // The synth step runs the RESOLVED cdk-synth image — pinned by digest, from
    // the pull host — and installs the CDK CLI version the release names.
    const projects = Object.values(template.Resources).filter((r) => r.Type === 'AWS::CodeBuild::Project');
    const images = projects.map((p) => (p.Properties!.Environment as { Image: string }).Image);
    expect(images).toEqual(expect.arrayContaining([
      expect.stringMatching(new RegExp(`^registry\\.acme\\.test(:\\d+)?/system/cdk-synth@sha256:${'c'.repeat(64)}$`)),
    ]));
    expect(JSON.stringify(template)).toContain(`aws-cdk@${TOOLCHAIN.versions.awsCdk}`);
    const steps = JSON.parse(readFileSync(join(outDir, STEP_MANIFEST_FILE), 'utf-8')) as unknown;
    expect(JSON.stringify(steps)).toContain('cdk-synth');
  }, 120_000);

  // Regression: helper progress lines ("Toolchain release", …) used to land on
  // stdout ahead of the JSON; `--json` now routes every diagnostic to stderr.
  it('synth --json: stdout is exactly one JSON document', () => {
    expect(() => JSON.parse(synthStdout)).not.toThrow();
  });

  it('a revoked refresh token: the session is forgotten, the active platform kept, and the command fails', async () => {
    const store = readStore();
    store.sessions[stub.url.toLowerCase()]!.expiresAt = Date.now() - 1_000;
    writeFileSync(STORE, JSON.stringify(store));
    stub.state.refreshStatus = 401;

    const res = await cli(['pipeline', 'synth', '--id', pipelineId, '--show-resolved']);

    // Signed out is an AUTHENTICATION failure (exit 4), not an API error (3).
    expect(res.code).toBe(4);
    expect(res.stderr).toContain('could not be renewed');
    expect(res.stderr).toContain('Authentication required');
    expect(session()).toBeUndefined();
    // The active platform survives a dead session, so `auth login` signs back in there.
    expect(readStore().activePlatform).toBe(stub.url);
    stub.state.refreshStatus = undefined;
  });

  it('PLATFORM_TOKEN wins over the store, and a key the platform rejects exits 4 (auth)', async () => {
    const res = await cli(['pipeline', 'list', '--format', 'json'], { env: { PLATFORM_TOKEN: 'pb_pat_not-a-real-key' } });

    expect(res.code).toBe(4);
    const last = stub.requests[stub.requests.length - 1]!;
    expect(last.path).toBe('/api/pipelines');
    expect(last.headers.authorization).toBe('Bearer pb_pat_not-a-real-key');
  });

  it('auth login --token: stdout is ONLY the access token (for `export PLATFORM_TOKEN=$(…)`)', async () => {
    stub.state.pendingPolls = 0;
    const res = await cli(['auth', 'login', '--url', stub.url, '--no-browser', '--token']);

    expect(res.code).toBe(0);
    const token = session()!.accessToken;
    expect(res.stdout).toBe(`${token}\n`);
    // The approval prompt still reaches the person — on stderr, out of the capture.
    expect(res.stderr).toContain('WXYZ-1234');
  }, 30_000);
});
