// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-account pipeline runners — the deploy half.
 *
 * The pipeline service signs every run request it sends to a customer's runner
 * Lambda with a DEDICATED Ed25519 key (deploy/bin/runner-signing-keys.sh). These
 * assertions hold that:
 *   - the script writes an Ed25519 PKCS#8 key, is idempotent, and rotates in two
 *     phases (`--rotate` keeps the retiring key, `--finish` drops it);
 *   - every target runs it and hands the key to the PIPELINE service ONLY, at
 *     the paths the service reads, optionally (no key ⇒ runners unavailable,
 *     the service still starts);
 *   - the retired global on/off switch is gone (runners are a per-org feature flag);
 *   - the runbook names the emergency stop (remove the signing key, or revoke an
 *     org's feature);
 *   - the mesh admits pipeline to message's notify route (health notices).
 */

import { spawnSync } from 'child_process';
import { createPrivateKey } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from '@jest/globals';
import { ALL_TARGETS, K8S_TARGETS, REPO_ROOT, read, yamlDocs } from '../src/index.js';

type Doc = Record<string, any>;

const SCRIPT = join(REPO_ROOT, 'deploy/bin/runner-signing-keys.sh');
const KEY_PATH = '/etc/pipeline-builder/runner-signing/runner-signing.key';
const PREV_PATH = '/etc/pipeline-builder/runner-signing/runner-signing-previous.key';
const MOUNT = '/etc/pipeline-builder/runner-signing';

const SETUP: Record<(typeof ALL_TARGETS)[number], string> = {
  'deploy/local/docker': 'deploy/local/docker/bin/setup.sh',
  'deploy/local/minikube': 'deploy/local/minikube/bin/setup.sh',
  'deploy/aws/ec2': 'deploy/aws/ec2/bin/startup.sh',
  'deploy/aws/eks': 'deploy/aws/eks/bin/setup.sh',
};

function run(certDir: string, ...args: string[]) {
  const r = spawnSync('bash', [SCRIPT, certDir, ...args], { encoding: 'utf-8', env: { ...process.env, PB_PRIVATE_KEY_MODE: '' } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('deploy/bin/runner-signing-keys.sh', () => {
  const dirs: string[] = [];
  const certDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'pb-runner-keys-'));
    dirs.push(d);
    return join(d, 'certs');
  };
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('writes an Ed25519 PKCS#8 private key, 0600 off the docker target', () => {
    const dir = certDir();
    expect(run(dir).status).toBe(0);
    const file = join(dir, 'runner-signing/runner-signing.key');
    const pem = readFileSync(file, 'utf-8');
    expect(pem).toContain('-----BEGIN PRIVATE KEY-----'); // PKCS#8, not a raw/legacy form
    expect(createPrivateKey(pem).asymmetricKeyType).toBe('ed25519');
    expect(statSync(file).mode % 0o1000).toBe(0o600);
  });

  it('keeps 0644 next to a docker-compose.yml (compose bind-mounts it across uids)', () => {
    const dir = certDir();
    writeFileSync(join(dir, '..', 'docker-compose.yml'), 'services: {}\n');
    expect(run(dir).status).toBe(0);
    expect(statSync(join(dir, 'runner-signing/runner-signing.key')).mode % 0o1000).toBe(0o644);
  });

  it('is idempotent: a re-run never replaces the key', () => {
    const dir = certDir();
    run(dir);
    const before = readFileSync(join(dir, 'runner-signing/runner-signing.key'), 'utf-8');
    expect(run(dir).status).toBe(0);
    expect(readFileSync(join(dir, 'runner-signing/runner-signing.key'), 'utf-8')).toBe(before);
    expect(existsSync(join(dir, 'runner-signing/runner-signing-previous.key'))).toBe(false);
  });

  it('rotates in two phases: --rotate keeps the retiring key, --finish drops it', () => {
    const dir = certDir();
    run(dir);
    const first = readFileSync(join(dir, 'runner-signing/runner-signing.key'), 'utf-8');
    expect(run(dir, '--rotate').status).toBe(0);
    expect(readFileSync(join(dir, 'runner-signing/runner-signing-previous.key'), 'utf-8')).toBe(first);
    const second = readFileSync(join(dir, 'runner-signing/runner-signing.key'), 'utf-8');
    expect(second).not.toBe(first);
    expect(run(dir, '--finish').status).toBe(0);
    expect(readdirSync(join(dir, 'runner-signing')).filter((f) => !f.startsWith('.'))).toEqual(['runner-signing.key']);
    expect(readFileSync(join(dir, 'runner-signing/runner-signing.key'), 'utf-8')).toBe(second);
  });

  it('refuses a second --rotate while a retiring key exists ("run --finish first"), touching neither key', () => {
    const dir = certDir();
    run(dir);
    expect(run(dir, '--rotate').status).toBe(0);
    const cur = readFileSync(join(dir, 'runner-signing/runner-signing.key'), 'utf-8');
    const prev = readFileSync(join(dir, 'runner-signing/runner-signing-previous.key'), 'utf-8');
    const again = run(dir, '--rotate');
    expect(again.status).not.toBe(0);
    expect(again.out).toContain('run --finish first');
    expect(readFileSync(join(dir, 'runner-signing/runner-signing.key'), 'utf-8')).toBe(cur);
    expect(readFileSync(join(dir, 'runner-signing/runner-signing-previous.key'), 'utf-8')).toBe(prev);
  });

  it('refuses a rotate with no current key, both phases at once, and a missing cert_dir', () => {
    expect(run(certDir(), '--rotate').status).not.toBe(0);
    expect(run(certDir(), '--rotate', '--finish').status).not.toBe(0);
    expect(spawnSync('bash', [SCRIPT], { encoding: 'utf-8' }).status).not.toBe(0);
  });
});

describe.each(ALL_TARGETS)('runner signing wiring — %s', (target) => {
  it('generates the key during bring-up', () => {
    expect(read(SETUP[target])).toMatch(/runner-signing-keys\.sh" "\$(DEPLOY_DIR\/certs|CERT_DIR)"/);
  });
});

describe('runner signing wiring — docker compose', () => {
  const compose = yamlDocs<Doc>('deploy/local/docker/docker-compose.yml')[0]!;
  const services = compose.services as Record<string, Doc>;

  it('hands the key directory to pipeline, at the paths the service reads', () => {
    const p = services.pipeline!;
    expect(p.environment.RUNNER_SIGNING_KEY_FILE).toBe(`\${RUNNER_SIGNING_KEY_FILE:-${KEY_PATH}}`);
    expect(p.environment.RUNNER_SIGNING_KEY_PREVIOUS_FILE).toBe(`\${RUNNER_SIGNING_KEY_PREVIOUS_FILE:-${PREV_PATH}}`);
    expect(p.volumes).toContain(`./certs/runner-signing:${MOUNT}:ro`);
  });

  it('mounts it into NO other service', () => {
    for (const [name, svc] of Object.entries(services)) {
      if (name === 'pipeline') continue;
      expect([name, JSON.stringify(svc ?? {}).includes('runner-signing')]).toEqual([name, false]);
    }
  });
});

describe.each(K8S_TARGETS)('runner signing wiring — %s manifests', (target) => {
  const pipelineDeployment = yamlDocs<Doc>(`${target}/k8s/pipeline.yaml`).find((d) => d.kind === 'Deployment')!;
  const pod = pipelineDeployment.spec.template.spec;
  const container = pod.containers.find((c: Doc) => c.name === 'pipeline');

  it('creates the Secret through the shared creator', () => {
    expect(read(SETUP[target as keyof typeof SETUP])).toMatch(/pb_create_runner_signing_secret "\$(DEPLOY_DIR\/certs|CERT_DIR)\/runner-signing"/);
  });

  it('mounts the optional runner-signing-key Secret into pipeline, read-only, at the service\'s paths', () => {
    const vol = pod.volumes.find((v: Doc) => v.name === 'runner-signing-key');
    expect(vol.secret).toMatchObject({ secretName: 'runner-signing-key', optional: true });
    expect(container.volumeMounts).toContainEqual({ name: 'runner-signing-key', mountPath: MOUNT, readOnly: true });
    const envOf = (n: string) => container.env.find((e: Doc) => e.name === n)?.value;
    expect(envOf('RUNNER_SIGNING_KEY_FILE')).toBe(KEY_PATH);
    expect(envOf('RUNNER_SIGNING_KEY_PREVIOUS_FILE')).toBe(PREV_PATH);
  });

  it('references the Secret from NO other manifest', () => {
    const dir = join(REPO_ROOT, target, 'k8s');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.yaml') && n !== 'pipeline.yaml')) {
      expect([f, read(`${target}/k8s/${f}`).includes('runner-signing-key')]).toEqual([f, false]);
    }
  });
});

describe('pb_create_runner_signing_secret', () => {
  const lib = read('deploy/bin/k8s-resources.sh');
  const fn = lib.slice(lib.indexOf('pb_create_runner_signing_secret() {'), lib.indexOf('\n}\n', lib.indexOf('pb_create_runner_signing_secret() {')));

  it('builds runner-signing-key from the key, plus the retiring key only when present', () => {
    expect(fn).toContain('--from-file=runner-signing.key="$_dir/runner-signing.key"');
    expect(fn).toContain('[ -f "$_dir/runner-signing-previous.key" ] && _args+=(--from-file=runner-signing-previous.key=');
    expect(fn).toContain('pb_secret runner-signing-key');
  });
});

describe.each(K8S_TARGETS)('runner mesh policy — %s', (target) => {
  const policies = yamlDocs<Doc>(`${target}/k8s/istio-internal-routes.yaml`).filter((d) => d.kind === 'AuthorizationPolicy');
  const principal = (sa: string) => `cluster.local/ns/pipeline-builder/sa/${sa}`;

  it('admits pipeline to message notify (runner health notices)', () => {
    const p = policies.find((d) => d.metadata.name === 'message-internal-routes')!;
    const rule = p.spec.rules.find((r: Doc) => r.to[0].operation.paths.includes('/messages/internal/notify'));
    expect(rule.from[0].source.notPrincipals).toContain(principal('pipeline'));
  });
});

/**
 * The runner dispatch tunables and their safe defaults (pipeline service only),
 * read from the ONE copy — `RUNNER_SETTING_DEFAULTS` in the service's
 * vocabulary.ts, the literal `runnerSettings()` falls back to — as source text.
 */
const RUNNER_TUNABLES: Record<string, string> = (() => {
  const src = read('api/pipeline/src/runners/vocabulary.ts');
  const body = /export const RUNNER_SETTING_DEFAULTS = \{([\s\S]*?)\} as const;/.exec(src)?.[1] ?? '';
  return Object.fromEntries([...body.matchAll(/^\s*([A-Z0-9_]+): '([^']*)',?\s*$/gm)].map((m) => [m[1]!, m[2]!]));
})();

it('reads the runner tunables from the service (guards against a vacuously passing extraction)', () => {
  expect(Object.keys(RUNNER_TUNABLES).sort()).toEqual([
    'MIN_RUNNER_VERSION', 'RUNNER_DISPATCH_CONCURRENCY', 'RUNNER_FAILED_REQUEST_RETENTION_DAYS',
    'RUNNER_PLATFORM_EGRESS_IPS', 'RUNNER_REQUEST_RETENTION_DAYS', 'RUNNER_UPGRADE_GRACE_DAYS',
  ]);
});

describe.each(ALL_TARGETS)('runner dispatch tunables — %s', (target) => {
  const env = read(`${target}/.env.example`);

  it.each(Object.entries(RUNNER_TUNABLES))('declares %s=%s', (key, value) => {
    expect(env).toContain(`\n${key}=${value}\n`);
  });
});

describe('runner dispatch tunables — docker compose', () => {
  const services = yamlDocs<Doc>('deploy/local/docker/docker-compose.yml')[0]!.services as Record<string, Doc>;

  it('passes each to pipeline with the same default', () => {
    for (const [key, value] of Object.entries(RUNNER_TUNABLES)) {
      expect([key, services.pipeline!.environment[key]]).toEqual([key, `\${${key}:-${value}}`]);
    }
  });

  it('passes them to NO other service', () => {
    for (const [name, svc] of Object.entries(services)) {
      if (name === 'pipeline') continue;
      const text = JSON.stringify(svc ?? {});
      for (const key of Object.keys(RUNNER_TUNABLES)) expect([name, key, text.includes(key)]).toEqual([name, key, false]);
    }
  });
});

describe('runner-signing runbook', () => {
  const runbook = read('docs/runbooks/secret-rotation.md');
  const start = runbook.indexOf('## Runner-signing key');
  const section = runbook.slice(start, runbook.indexOf('\n## ', start + 1));

  it('documents the two-phase rotation the script implements, with its waits', () => {
    expect(start).toBeGreaterThan(-1);
    expect(section).toContain('runner-signing-keys.sh deploy/<target>/certs --rotate');
    expect(section).toContain('runner-signing-keys.sh deploy/<target>/certs --finish');
    expect(section).toContain('/api/pipelines/runner/jwks.json');
    expect(section).toMatch(/at least 10 minutes/);
    expect(section).toMatch(/1 hour/);
    expect(section.indexOf('--rotate')).toBeLessThan(section.indexOf('--finish'));
  });

  it('names the emergency stop: remove the signing key, or revoke one org\'s feature', () => {
    expect(section).toContain('**Emergency stop**');
    expect(section).toContain('`runner-signing-key`');
    expect(section).toContain('`cross_account_runners`');
  });

  it('lists every accepted runner URL host pattern', () => {
    expect(section).toContain('`<id>.lambda-url.<region>.on.aws`');
    expect(section).toContain('`<id>.execute-api.<region>.amazonaws.com`');
    expect(section).toContain('`<id>.execute-api.<region>.amazonaws.com.cn`');
  });
});

describe('the retired global runner switch', () => {
  // Runners are now a per-org feature flag (`cross_account_runners`); the old
  // deployment-wide on/off env var must not linger anywhere an operator reads.
  // Built from parts so this file is not itself a hit.
  const RETIRED = ['CROSS_ACCOUNT', 'RUNNERS', 'ENABLED'].join('_');
  const hits: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(REPO_ROOT, rel))) {
      if (['node_modules', 'certs', 'coverage', 'lib', 'dist'].includes(entry)) continue;
      const child = `${rel}/${entry}`;
      if (statSync(join(REPO_ROOT, child)).isDirectory()) walk(child);
      else if (readFileSync(join(REPO_ROOT, child), 'utf-8').includes(RETIRED)) hits.push(child);
    }
  };

  it('appears nowhere in deploy/, docs/ or test/deploy-contracts', () => {
    for (const root of ['deploy', 'docs', 'test/deploy-contracts/test']) walk(root);
    expect(hits).toEqual([]);
  });
});
