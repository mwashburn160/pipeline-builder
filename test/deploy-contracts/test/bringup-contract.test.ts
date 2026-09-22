// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The k8s bring-up, backup tooling, generated env files and per-target config
 * copies. Each target keeps its own standalone manifest and config tree; what
 * keeps them from drifting is (a) ONE shell implementation of the bring-up
 * (deploy/bin/k8s-resources.sh) that every target calls, and (b) the equality
 * checks below for the files that are deliberately copied per target.
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from '@jest/globals';
import { ALL_TARGETS, K8S_TARGETS, REPO_ROOT, read, yamlDocs } from '../src/index.js';

/** Each k8s target's provisioning script. */
const SETUP: Record<(typeof K8S_TARGETS)[number], string> = {
  'deploy/local/minikube': 'deploy/local/minikube/bin/setup.sh',
  'deploy/aws/ec2': 'deploy/aws/ec2/bin/startup.sh',
  'deploy/aws/eks': 'deploy/aws/eks/bin/setup.sh',
};

type K8sDoc = { kind?: string; metadata?: { name?: string }; spec?: Record<string, unknown> };

/** The body of a shell function `name() {` … the next top-level `}`. */
function shellFunction(text: string, name: string): string {
  const start = text.indexOf(`${name}() {`);
  expect([name, start >= 0]).toEqual([name, true]);
  return text.slice(start, text.indexOf('\n}\n', start));
}

/** Every `secretKeyRef: { name: <secret>, key }` key referenced in a target's manifests. */
function secretKeysReferenced(target: string, secret: string): Set<string> {
  const keys = new Set<string>();
  const re = new RegExp(`secretKeyRef:\\s*\\n\\s*name:\\s*${secret}\\s*\\n\\s*key:\\s*(\\S+)`, 'g');
  for (const f of ['postgres.yaml', 'pgbouncer.yaml']) {
    for (const m of read(`${target}/k8s/${f}`).matchAll(re)) keys.add(m[1]!);
  }
  return keys;
}

describe.each(K8S_TARGETS)('%s bring-up', (target) => {
  const setup = read(SETUP[target]);

  it('creates the app Secrets and ConfigMaps through the shared creators, never inline copies', () => {
    for (const fn of ['pb_create_app_secrets', 'pb_create_ghcr_secret', 'pb_create_registry_secrets', 'pb_create_token_signing_secret',
      'pb_create_plugin_signing_secrets', 'pb_create_service_key_secrets', 'pb_create_config_maps', 'pb_app_env_resources']) {
      expect([fn, setup.includes(fn)]).toEqual([fn, true]);
    }
    // An inline `secret postgres-secret …` once shipped without the public
    // reader's password, so the pooled login for /api/public/plugins was never
    // created on minikube while the plugin service believed it was configured.
    expect(setup).not.toMatch(/^\s*(secret|pb_secret)\s+postgres-secret/m);
  });

  it('gives postgres-secret every key its manifests reference', () => {
    const creator = shellFunction(read('deploy/bin/k8s-resources.sh'), 'pb_create_app_secrets');
    const line = creator.slice(creator.indexOf('pb_secret postgres-secret'), creator.indexOf('pb_secret mongodb-secret'));
    const referenced = secretKeysReferenced(target, 'postgres-secret');
    expect(referenced.has('ECOSYSTEM_PUBLIC_READER_PASSWORD')).toBe(true);
    for (const key of referenced) expect([key, line.includes(`--from-literal=${key}=`)]).toEqual([key, true]);
  });

  it('applies through the shared istiod-gated apply + mesh re-enrollment', () => {
    expect(setup).toContain('pb_apply_manifests "$K8S_DIR"');
    expect(setup).not.toMatch(/kubectl kustomize "\$K8S_DIR"/);
  });

  it('never scales a service on memory utilization', () => {
    // These services carry a large baseline heap, so a memory target pins the
    // HPA to maxReplicas forever.
    for (const f of ['platform', 'pipeline', 'plugin', 'billing', 'compliance', 'message', 'quota', 'reporting', 'image-registry', 'ask']) {
      for (const doc of yamlDocs<K8sDoc>(`${target}/k8s/${f}.yaml`)) {
        if (doc.kind !== 'HorizontalPodAutoscaler') continue;
        const metrics = (doc.spec?.metrics ?? []) as Array<{ resource?: { name?: string } }>;
        expect([f, metrics.map((m) => m.resource?.name)]).toEqual([f, metrics.map(() => 'cpu')]);
      }
    }
  });
});

describe('k8s bring-up shared helpers', () => {
  const res = read('deploy/bin/k8s-resources.sh');

  it('gates the apply on istiod, then restarts every workload so istio-cni enrolls it', () => {
    const apply = shellFunction(res, 'pb_apply_manifests');
    const gate = apply.indexOf('wait --for=condition=Available deployment/istiod');
    const kustomize = apply.indexOf('kustomize "$_dir"');
    const restart = apply.indexOf('rollout restart');
    expect(gate).toBeGreaterThan(0);
    expect(kustomize).toBeGreaterThan(gate);
    expect(restart).toBeGreaterThan(kustomize);
  });

  it('takes the ghcr pull token from GHCR_TOKEN or ~/.npmrc', () => {
    expect(shellFunction(res, 'pb_create_ghcr_secret')).toContain('$HOME/.npmrc');
  });

  it('minikube reads only its own .env', () => {
    const setup = read('deploy/local/minikube/bin/setup.sh');
    expect(setup).not.toContain('../docker/.env');
    expect(setup).not.toContain('/docker" && pwd)/.env');
  });
});

describe('backup and restore', () => {
  const common = read('deploy/bin/common.sh');
  const buckets = (/^PB_MINIO_BUCKETS="([^"]+)"/m.exec(common)?.[1] ?? '').split(' ').sort();

  it('have one implementation that every target wraps', () => {
    const modes: Record<string, string> = { 'deploy/local/docker': 'direct', 'deploy/local/minikube': 'k8s', 'deploy/aws/ec2': 'k8s', 'deploy/aws/eks': 'k8s' };
    for (const target of ALL_TARGETS) {
      for (const script of ['backup', 'restore']) {
        const wrapper = read(`${target}/bin/${script}.sh`);
        expect([target, script, wrapper.includes(`bin" && pwd)/${script}.sh" --connect ${modes[target]} "$@"`)]).toEqual([target, script, true]);
      }
    }
    for (const script of ['backup', 'restore']) expect(read(`deploy/bin/${script}.sh`)).toContain('MINIO_BUCKETS:-$PB_MINIO_BUCKETS');
  });

  it('back up every bucket each target creates, and the eks CronJob mirrors the same set', () => {
    expect(buckets.length).toBeGreaterThan(5);
    const created = (text: string): string[] => {
      const loop = /for b in ([a-z -]+); do mc mb --ignore-existing/.exec(text)?.[1]?.trim().split(/\s+/) ?? [];
      const locked = [...text.matchAll(/mc mb --ignore-existing --with-lock local\/([a-z-]+)/g)].map((m) => m[1]!);
      return [...loop, ...locked].sort();
    };
    expect(created(read('deploy/local/docker/docker-compose.yml'))).toEqual(buckets);
    for (const target of K8S_TARGETS) expect([target, created(read(`${target}/k8s/minio.yaml`))]).toEqual([target, buckets]);
    const cron = /MINIO_BUCKETS:-([a-z -]+)\}/.exec(read('deploy/aws/eks/backup/backup-cronjob.yaml'))?.[1]?.trim().split(/\s+/).sort();
    expect(cron).toEqual(buckets);
  });
});

/** Env var names the services read: `envInt('X'`, `process.env.X`, `env.X`, or a quoted `'X'`. */
function serviceEnvReads(): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) for (const m of readFileSync(p, 'utf-8').matchAll(/(?:['"`]|process\.env\.|env\.)([A-Z][A-Z0-9_]{2,})\b/g)) names.add(m[1]!);
    }
  };
  const roots = [join(REPO_ROOT, 'platform/src')];
  for (const group of ['api', 'packages']) {
    for (const p of readdirSync(join(REPO_ROOT, group))) if (existsSync(join(REPO_ROOT, group, p, 'src'))) roots.push(join(REPO_ROOT, group, p, 'src'));
  }
  roots.forEach(walk);
  return names;
}

describe('generated .env.example files', () => {
  it.each(['scripts/gen-env-examples.mjs', 'scripts/gen-readme-index.mjs'])('%s --check: the generated files are current', (script) => {
    const r = spawnSync(process.execPath, [join(REPO_ROOT, script), '--check'], { encoding: 'utf-8' });
    expect([r.status, r.stderr]).toEqual([0, '']);
  });

  it('docker-compose passes through every docker .env.example key a service reads', () => {
    // Compose gives each service an explicit `environment:` list, so a key
    // that is only in .env is silently ignored on the docker target.
    const env = read('deploy/local/docker/.env.example');
    const compose = read('deploy/local/docker/docker-compose.yml');
    const composeKeys = new Set(compose.match(/[A-Z][A-Z0-9_]{2,}/g));
    // Read by deploy scripts only (init-platform, load-plugins, …), never a container.
    const SCRIPT_ONLY = new Set(['PLUGIN_BUILD_STRATEGY']);
    const read_ = serviceEnvReads();
    const tunables = [...env.matchAll(/^#?\s?([A-Z][A-Z0-9_]{2,})=/gm)].map((m) => m[1]!);
    const missing = tunables.filter((k) => read_.has(k) && !composeKeys.has(k) && !SCRIPT_ONLY.has(k));
    expect(missing).toEqual([]);
  });
});

describe('deploy/shared/services.txt', () => {
  const rows = read('deploy/shared/services.txt').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(' '));

  it('lists every backend service, and each has its own signing-key Secret mount on every k8s target', () => {
    const services = rows.filter(([kind]) => kind === 'service').map(([, name]) => name!);
    expect(services).toEqual(expect.arrayContaining(['platform', 'pipeline', 'plugin', 'quota', 'billing', 'message', 'compliance', 'reporting', 'image-registry', 'ask']));
    for (const target of K8S_TARGETS) {
      for (const svc of services) expect([target, svc, read(`${target}/k8s/${svc}.yaml`).includes(`secretName: service-key-${svc}`)]).toEqual([target, svc, true]);
    }
  });

  it('points every entry at a real project directory', () => {
    for (const [, name, dir] of rows) expect([name, existsSync(join(REPO_ROOT, dir!, 'package.json'))]).toEqual([name, true]);
  });
});

describe('per-target config copies stay identical', () => {
  const same = (paths: string[]) => {
    const [first, ...rest] = paths;
    for (const p of rest) expect([p, read(p)]).toEqual([p, read(first!)]);
  };

  it('alert rules and promtail on the three k8s targets', () => {
    same(K8S_TARGETS.map((t) => `${t}/config/prometheus/alert-rules.yml`));
    same(K8S_TARGETS.map((t) => `${t}/config/promtail/promtail-config.yml`));
  });

  it('grafana dashboards on every target', () => {
    const dir = (t: string) => (t.endsWith('docker') ? `${t}/config/grafana/provisioning/dashboards` : `${t}/config/grafana/dashboards`);
    same(ALL_TARGETS.map((t) => `${dir(t)}/dashboards.yaml`));
    same(ALL_TARGETS.map((t) => `${dir(t)}/plugin-ecosystem.json`));
  });

  it('the AWS gateways share nginx.conf, the disabled admin-console routes and the registry token check', () => {
    for (const f of ['nginx.conf', 'admin-uis-disabled.conf', 'registry-auth.js']) same([`deploy/aws/ec2/nginx/${f}`, `deploy/aws/eks/nginx/${f}`]);
  });
});

describe('postgres-init.sql', () => {
  it('has one shared copy that every target consumes', () => {
    for (const target of ALL_TARGETS) expect([target, existsSync(join(REPO_ROOT, target, 'postgres-init.sql'))]).toEqual([target, false]);
    expect(read('deploy/local/docker/docker-compose.yml'))
      .toContain("'../../shared/postgres-init.sql:/docker-entrypoint-initdb.d/init.sql:ro'");
    expect(read('deploy/bin/k8s-resources.sh')).toContain('--from-file=init.sql="$_shared/postgres-init.sql"');
  });
});
