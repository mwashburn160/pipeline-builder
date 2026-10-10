// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The k8s bring-up, backup tooling, the per-target env files and config
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
  const buckets = (/^PB_OBJECTSTORE_BUCKETS="([^"]+)"/m.exec(common)?.[1] ?? '').split(' ').sort();

  it('have one implementation that every target wraps', () => {
    const modes: Record<string, string> = { 'deploy/local/docker': 'direct', 'deploy/local/minikube': 'k8s', 'deploy/aws/ec2': 'k8s', 'deploy/aws/eks': 'k8s' };
    for (const target of ALL_TARGETS) {
      for (const script of ['backup', 'restore']) {
        const wrapper = read(`${target}/bin/${script}.sh`);
        expect([target, script, wrapper.includes(`bin" && pwd)/${script}.sh" --connect ${modes[target]} "$@"`)]).toEqual([target, script, true]);
      }
    }
    for (const script of ['backup', 'restore']) expect(read(`deploy/bin/${script}.sh`)).toContain('OBJECTSTORE_BUCKETS:-$PB_OBJECTSTORE_BUCKETS');
  });

  it('back up every bucket each target creates, and the eks CronJob mirrors the same set', () => {
    expect(buckets.length).toBeGreaterThan(5);
    const created = (text: string): string[] => {
      const loop = /for b in ([a-z -]+); do rc bucket create --ignore-existing/.exec(text)?.[1]?.trim().split(/\s+/) ?? [];
      const locked = [...text.matchAll(/rc bucket create --ignore-existing --with-lock local\/([a-z-]+)/g)].map((m) => m[1]!);
      return [...loop, ...locked].sort();
    };
    expect(created(read('deploy/local/docker/docker-compose.yml'))).toEqual(buckets);
    for (const target of K8S_TARGETS) expect([target, created(read(`${target}/k8s/rustfs.yaml`))]).toEqual([target, buckets]);
    const cron = /OBJECTSTORE_BUCKETS:-([a-z -]+)\}/.exec(read('deploy/aws/eks/k8s/backup-cronjob.yaml'))?.[1]?.trim().split(/\s+/).sort();
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

describe('generated files', () => {
  it('scripts/gen-readme-index.mjs --check: the generated files are current', () => {
    const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/gen-readme-index.mjs'), '--check'], { encoding: 'utf-8' });
    expect([r.status, r.stderr]).toEqual([0, '']);
  });
});

describe('.env.example files', () => {
  // NOT generated: each target's .env.example is a source file of its own. Key
  // parity across the four is enforced in env-contract.test.ts.
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

describe('services.txt', () => {
  // Generated by projen into EVERY target (the copies are held equal below);
  // the rows are the same list wherever a deploy script reads it.
  const rows = read('deploy/local/docker/services.txt').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(' '));

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

  // The copies being IDENTICAL says nothing about them being VALID, and that gap
  // shipped: a `\1` backreference in an editing pass wrote a literal 0x01 over a
  // comment prefix in ALL FOUR promtail configs at once, so every equality check
  // above still passed while promtail CrashLoopBackOff'd on every target with
  // "yaml: control characters are not allowed". Parse them, and reject the
  // control bytes YAML forbids outright — a corrupted comment is invisible to a
  // diff-style guard but fatal to the process that has to read the file.
  it('every deploy config YAML parses and carries no control characters', () => {
    const files = [
      ...K8S_TARGETS.flatMap((t) => [`${t}/config/promtail/promtail-config.yml`, `${t}/config/prometheus/alert-rules.yml`]),
      ...ALL_TARGETS.map((t) => `${t}/config/alertmanager/alertmanager.yml`),
    ].filter((f) => existsSync(join(REPO_ROOT, f)));
    expect(files.length).toBeGreaterThan(0);

    const problems: string[] = [];
    for (const f of files) {
      const raw = read(f);
      // Tab, LF and CR are the only control characters YAML allows.
      const bad = [...raw].findIndex((ch) => ch < ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r');
      if (bad >= 0) {
        const line = raw.slice(0, bad).split('\n').length;
        problems.push(`${f}: control character 0x${raw.charCodeAt(bad).toString(16).padStart(2, '0')} at line ${line}`);
        continue;
      }
      try {
        yamlDocs(f);
      } catch (err) {
        problems.push(`${f}: ${(err as Error).message}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('grafana dashboards on every target', () => {
    const dir = (t: string) => (t.endsWith('docker') ? `${t}/config/grafana/provisioning/dashboards` : `${t}/config/grafana/dashboards`);
    same(ALL_TARGETS.map((t) => `${dir(t)}/dashboards.yaml`));
    same(ALL_TARGETS.map((t) => `${dir(t)}/plugin-ecosystem.json`));
  });

  it('the AWS gateways share nginx.conf, the disabled admin-console routes and the registry token check', () => {
    for (const f of ['nginx.conf', 'admin-uis-disabled.conf', 'registry-auth.js']) same([`deploy/aws/ec2/nginx/${f}`, `deploy/aws/eks/nginx/${f}`]);
  });

  it('postgres-init.sql on every target', () => {
    // The schema, the RLS policies and the roles every service logs in as. A
    // target that drifts here builds a DIFFERENT database from the same commit,
    // which no other test would notice: the schema suites boot PGlite from the
    // docker copy only.
    same(ALL_TARGETS.map((t) => `${t}/postgres-init.sql`));
  });

  /**
   * THE DRIFT REGISTRY, and why it is computed rather than listed.
   *
   * The manifest trees are deliberately standalone — no shared kustomize base —
   * so a copy is the unit of change and a drift test is the only thing holding
   * the copies together. The assertions above each pin one file by hand, which
   * works until somebody adds a twelfth copied file and nobody notices it needs
   * pinning. Nine already had: istio-internal-routes.yaml (559 lines of
   * per-route mesh AuthorizationPolicy), both per-org isolation templates, and
   * the Thanos/Jaeger/mongo-express/rustfs-console workloads were byte-identical
   * on all three k8s targets with nothing asserting they stay that way.
   *
   * So this computes the set instead: every file that EXISTS on all three k8s
   * targets and is IDENTICAL on all three must be classified below. A file
   * identical across all three is substrate-independent by construction —
   * minikube, a single EC2 box and EKS Auto Mode share no storage model, no
   * ingress and no node shape, so if a file is the same on all three it is the
   * same because it does not depend on any of that. Divergence is then a bug,
   * not a port.
   *
   * REQUIRED_IDENTICAL is asserted. COINCIDENTAL is the escape hatch for a file
   * that merely happens to match today, and every entry needs a reason — an
   * unannotated one is how a file that SHOULD be pinned gets parked instead.
   *
   * Adding a copied file therefore fails this test until it is classified,
   * which is the point: the decision is made once, in writing, by whoever
   * added it.
   */
  const REQUIRED_IDENTICAL = [
    // Mesh authorization, per internal route. A copy that drifts makes one
    // service silently unreachable on one target — or opens a route on it.
    'k8s/istio-internal-routes.yaml',
    // Per-org tenant isolation. Drift here means weaker isolation on one
    // target than the others, which no other test would see.
    'k8s/per-org/namespace-template.yaml',
    'k8s/per-org/network-policy-template.yaml',
    'k8s/per-org/README.md',
    // Observability + admin workloads: same pinned images, same in-cluster
    // object store, nothing substrate-specific. Same argument the
    // loki/alertmanager/objstore assertion below already makes for their configs.
    'k8s/thanos-query.yaml',
    'k8s/thanos-compact.yaml',
    'k8s/jaeger.yaml',
    'k8s/mongo-express.yaml',
    'k8s/rustfs-console.yaml',
    // Pinned individually above too; listed here so the computed check below
    // accounts for them rather than reporting them as unclassified.
    'config/prometheus/alert-rules.yml',
    'config/promtail/promtail-config.yml',
    'config/alertmanager/alertmanager.yml',
    'config/loki/loki-config.yml',
    'config/thanos/objstore.yml',
    'config/grafana/dashboards/dashboards.yaml',
    'config/grafana/dashboards/plugin-ecosystem.json',
    'postgres-init.sql',
    'mongodb-init.js',
    'services.txt',
    'nginx/jwt.js',
    'nginx/metrics.js',
  ];

  /** Identical today, but not required to be. Each needs a reason. */
  const COINCIDENTAL: Record<string, string> = {};

  it('pins every file that is identical across all three k8s targets', () => {
    for (const rel of REQUIRED_IDENTICAL) same(K8S_TARGETS.map((t) => `${t}/${rel}`));
  });

  it('leaves no copied file unclassified', () => {
    // Computed, so a newly copied file shows up here instead of being forgotten.
    const relsOn = (t: string) => {
      const out: string[] = [];
      const walk = (dir: string, prefix: string) => {
        for (const e of readdirSync(join(REPO_ROOT, t, dir), { withFileTypes: true })) {
          if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.isDirectory()) walk(`${dir}/${e.name}`, rel);
          else out.push(rel);
        }
      };
      walk('.', '');
      return out;
    };
    const onAll = relsOn(K8S_TARGETS[0]!)
      .filter((rel) => K8S_TARGETS.every((t) => existsSync(join(REPO_ROOT, t, rel))));
    const identical = onAll.filter((rel) => {
      const first = read(`${K8S_TARGETS[0]}/${rel}`);
      return K8S_TARGETS.slice(1).every((t) => read(`${t}/${rel}`) === first);
    });
    expect(identical.length).toBeGreaterThan(15); // guards a vacuous pass

    const unclassified = identical.filter((rel) => !REQUIRED_IDENTICAL.includes(rel) && !(rel in COINCIDENTAL));
    expect({
      unclassified,
      fix: 'This file is byte-identical on all three Kubernetes targets, so nothing stops the '
        + 'copies drifting apart. Add it to REQUIRED_IDENTICAL (the usual answer — a file the '
        + 'same on all three does not depend on the substrate), or to COINCIDENTAL with the '
        + 'reason it is allowed to differ.',
    }).toEqual({ unclassified: [], fix: expect.any(String) });

    // And no stale entry: a path that no longer matches must not keep excusing itself.
    const stale = [...REQUIRED_IDENTICAL, ...Object.keys(COINCIDENTAL)].filter((rel) => !identical.includes(rel));
    expect(stale).toEqual([]);
  });

  it('runs ONE backup implementation on both AWS targets', () => {
    // The two copies' DOCUMENTS must match; their prose is expected to differ,
    // because the ec2 header carries a warning the eks one must not claim —
    // ec2 runs Postgres, Mongo and RustFS on one box with one disk, so a dump
    // written to RustFS sits on the same hardware as the database it came from.
    //
    // This is the whole guarantee that the two targets stay one implementation.
    // They were already identical in substance and nothing checked it, while
    // ec2 ALSO had a second schedule (a host systemd timer at 03:30 against the
    // CronJob's 03:00) that nothing tied to the other target at all.
    const docs = (t: string) => yamlDocs(`deploy/aws/${t}/k8s/backup-cronjob.yaml`);
    expect(docs('ec2')).toEqual(docs('eks'));

    for (const t of ['ec2', 'eks']) {
      const cj = docs(t).find((d: any) => d.kind === 'CronJob') as any;
      // Schedule and suspend come from .env, not from the manifest: a literal
      // here is a target that cannot be rescheduled without an edit.
      expect([t, cj.spec.schedule]).toEqual([t, '${BACKUP_SCHEDULE}']);
      expect([t, cj.spec.suspend]).toEqual([t, '${BACKUP_SUSPEND}']);
      expect([t, cj.spec.jobTemplate.spec.template.spec.containers[0].image]).toEqual([t, '${BACKUP_IMAGE}']);
      // Applied by the normal deploy, which is what substitutes those tokens.
      expect([t, read(`deploy/aws/${t}/k8s/kustomization.yaml`).includes('backup-cronjob.yaml')]).toEqual([t, true]);
    }

    // And the host timer is really gone — not merely disabled. A reinstated one
    // would be a second schedule again, which is the bug this replaced.
    const boot = read('deploy/aws/ec2/bin/bootstrap.sh');
    expect(boot).not.toContain('OnCalendar');
    expect(boot).not.toContain('systemctl enable --now pipeline-backup');
  });

  it('the inline job scripts are valid shell, as the container will receive them', () => {
    // A YAML block scalar hides shell errors completely: the manifest parses,
    // `kubectl apply` succeeds, and the job fails at 02:00 on a syntax error.
    // This caught a real one — a `case "$sz" in ''|*[!0-9]*)` whose quotes were
    // eaten in an editing pass, which would have broken every backup run with
    // nothing upstream objecting.
    //
    // The scripts must be checked AFTER the block scalar is resolved, because
    // that is what strips the indentation the nested heredocs depend on: the
    // rclone config and the Pushgateway payload both terminate at column 0 only
    // once YAML has done that, so checking the raw file would prove nothing.
    const shells: Array<[string, string]> = [];
    for (const t of ['deploy/aws/ec2', 'deploy/aws/eks']) {
      for (const f of ['k8s/backup-cronjob.yaml', 'k8s/rustfs.yaml']) {
        for (const d of yamlDocs(`${t}/${f}`) as any[]) {
          const pod = d?.kind === 'CronJob' ? d.spec.jobTemplate.spec.template.spec
            : d?.kind === 'Job' ? d.spec.template.spec : null;
          if (!pod) continue;
          for (const c of pod.containers ?? []) {
            const script = (c.args ?? []).find((a: string) => typeof a === 'string' && a.includes('\n'));
            if (script) shells.push([`${t}/${f} ${d.metadata.name}/${c.name}`, script]);
          }
        }
      }
    }
    expect(shells.length).toBeGreaterThanOrEqual(4); // guards a vacuous pass

    const bad: string[] = [];
    for (const [label, script] of shells) {
      // `bash -n` parses without executing: syntax only, no side effects.
      const r = spawnSync('bash', ['-n'], { input: script, encoding: 'utf-8' });
      if (r.status !== 0) bad.push(`${label}: ${(r.stderr || '').trim().split('\n')[0]}`);
    }
    expect(bad).toEqual([]);
  });

  it('the AWS gateways also share what only they have', () => {
    // pushgateway and the RustFS console routes exist on ec2+eks and nowhere
    // else, so the all-three check above cannot see them. Same reasoning as
    // nginx.conf: two copies, one behaviour.
    for (const rel of ['k8s/pushgateway.yaml', 'nginx/rustfs-console.conf', 'nginx/rustfs-console-disabled.conf']) {
      same([`deploy/aws/ec2/${rel}`, `deploy/aws/eks/${rel}`]);
    }
  });

  it('the observability configs on every target', () => {
    // Loki's tenancy + retention, Alertmanager's routing/receivers and the
    // Thanos objstore refs are substrate-independent: every target runs the
    // same pinned images against the same in-cluster object store. A copy that drifts
    // gives one environment different retention, different alert routing or a
    // Thanos sidecar that cannot upload — none of which any other test sees.
    same(ALL_TARGETS.map((t) => `${t}/config/loki/loki-config.yml`));
    same(ALL_TARGETS.map((t) => `${t}/config/alertmanager/alertmanager.yml`));
    same(ALL_TARGETS.map((t) => `${t}/config/thanos/objstore.yml`));
  });

  it('the njs gateway modules and mongodb-init.js on every target', () => {
    // jwt.js verifies the token on EVERY gateway request and metrics.js counts
    // them; mongodb-init.js creates the indexes a fresh platform DB needs
    // before the service first connects. All three are pure logic with no
    // per-substrate parameter, so any difference is a fix that landed in one
    // environment only.
    same(ALL_TARGETS.map((t) => `${t}/nginx/jwt.js`));
    same(ALL_TARGETS.map((t) => `${t}/nginx/metrics.js`));
    same(ALL_TARGETS.map((t) => `${t}/mongodb-init.js`));
  });

  it('services.txt on every target', () => {
    // Generated per target by projen from one list in .projenrc.ts, so a
    // difference here means a stale copy (someone edited it by hand, or a
    // target was added without re-running projen) — and a deploy script would
    // then generate keys for a different set of services than the manifests
    // mount.
    same(ALL_TARGETS.map((t) => `${t}/services.txt`));
  });
});

describe('config copies are consumed from the target that owns them', () => {
  it('the k8s bring-up reads every ConfigMap source out of the target it was handed', () => {
    // The helper that used to resolve a shared directory is gone: nothing in
    // the bring-up may reach outside the <deploy_dir> / <config_dir> /
    // <nginx_dir> triple it is called with, or a target would deploy another
    // target's file.
    const creator = shellFunction(read('deploy/bin/k8s-resources.sh'), 'pb_create_config_maps');
    for (const src of [
      '--from-file=mongo-init.js="$_deploy/mongodb-init.js"',
      '--from-file=jwt.js="$_nginx/jwt.js"',
      '--from-file=metrics.js="$_nginx/metrics.js"',
      '--from-file=loki-config.yml="$_config/loki/loki-config.yml"',
      '--from-file=objstore.yml="$_config/thanos/objstore.yml"',
      '--from-file=alertmanager.yml="$_config/alertmanager/alertmanager.yml"',
    ]) {
      expect([src, creator.includes(src)]).toEqual([src, true]);
    }
    // …and EVERY source it mounts, not just the ones listed above, is rooted in
    // one of those three arguments — so a new shared path cannot creep back in.
    for (const m of creator.matchAll(/--from-file=[^=\s]+="([^"]+)"/g)) {
      expect([m[1], /^\$_(deploy|config|nginx)\//.test(m[1]!)]).toEqual([m[1], true]);
    }
  });

  it('each k8s target pre-flights alert delivery against its OWN alertmanager.yml', () => {
    for (const target of K8S_TARGETS) {
      expect([target, read(SETUP[target])])
        .toEqual([target, expect.stringContaining('pb_check_alert_delivery "$ENV_FILE" "$CONFIG_DIR/alertmanager/alertmanager.yml"')]);
    }
  });

  it('compose bind-mounts docker\'s own copies', () => {
    const compose = read('deploy/local/docker/docker-compose.yml');
    for (const mount of [
      './config/thanos/objstore.yml:/etc/thanos/objstore.yml:ro',
      "'./nginx/jwt.js:/etc/nginx/njs/jwt.js:ro'",
      "'./nginx/metrics.js:/etc/nginx/njs/metrics.js:ro'",
      "'./mongodb-init.js:/docker-entrypoint-initdb.d/mongo-init.js:ro'",
      "'./config/alertmanager/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro'",
      "'./config/loki/loki-config.yml:/etc/loki/loki-config.yml:ro'",
    ]) {
      expect([mount, compose.includes(mount)]).toEqual([mount, true]);
    }
    expect(compose).not.toContain('../../shared/');
  });
});

describe('postgres-init.sql', () => {
  it('ships as a per-target copy that the target itself consumes', () => {
    for (const target of ALL_TARGETS) expect([target, existsSync(join(REPO_ROOT, target, 'postgres-init.sql'))]).toEqual([target, true]);
    // compose bind-mounts its own copy; the k8s targets ConfigMap theirs out of
    // the target directory the bring-up was handed ($_deploy), never a path
    // outside that target's tree.
    expect(read('deploy/local/docker/docker-compose.yml'))
      .toContain("'./postgres-init.sql:/docker-entrypoint-initdb.d/init.sql:ro'");
    expect(read('deploy/bin/k8s-resources.sh')).toContain('--from-file=init.sql="$_deploy/postgres-init.sql"');
  });

  it('is what the pipeline-data schema suites boot PGlite from', () => {
    // Those suites assert what the DB actually enforces; pointed at a stale or
    // absent file they would silently assert nothing.
    expect(read('packages/pipeline-data/test/helpers/pglite-init.ts'))
      .toContain("resolve(REPO_ROOT, 'deploy/local/docker/postgres-init.sql')");
  });
});

describe('services.txt consumers', () => {
  it('resolve the list from the target they are provisioning, never a shared path', () => {
    // service-signing-keys.sh is invoked per target with that target's certs
    // dir, so the identities it mints keys for come from the same tree as the
    // keys themselves.
    const keys = read('deploy/bin/service-signing-keys.sh');
    expect(keys).toContain('SERVICES_TXT="$TARGET_DIR/services.txt"');
    expect(keys).toContain('TARGET_DIR="$(cd "$(dirname "$CERT_DIR")"');
    for (const setup of ['deploy/local/docker/bin/setup.sh', 'deploy/local/minikube/bin/setup.sh', 'deploy/aws/ec2/bin/startup.sh', 'deploy/aws/eks/bin/setup.sh']) {
      expect([setup, /service-signing-keys\.sh" "\$(DEPLOY_DIR\/certs|CERT_DIR)"/.test(read(setup))]).toEqual([setup, true]);
    }
    // The two repo-wide scripts are not run for a target at all; both read the
    // docker copy (identical by the drift check above).
    for (const script of ['deploy/bin/sync-image-tags.sh', 'deploy/bin/verify-npm-deps.sh']) {
      expect([script, read(script).includes('local/docker/services.txt')]).toEqual([script, true]);
    }
  });
});
