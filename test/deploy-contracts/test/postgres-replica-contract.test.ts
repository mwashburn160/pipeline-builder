// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The read replica's contract with the primary.
 *
 * WHY THIS FILE EXISTS AT ALL. The plan this implements originally called for
 * ONE StatefulSet carrying both the primary and the standbys, so that "replicas
 * are sized like the primary" was structural — a single pod template cannot
 * drift from itself. That topology turned out to be unbuildable here: it cannot
 * give the standby its own NetworkPolicy rules or mesh identity, cannot express
 * "minimum 1 replica" without `replicas: 2`, and would have forced the primary
 * through a volume-adoption migration whose failure mode is a database that
 * looks like it lost everything (see decision D1 in the plan).
 *
 * So the parity became a convention — and this file is what stops it being one.
 * That is the standing preference in this repo: duplicate the manifest, guard
 * the copy with a drift test, never share a base.
 *
 * WHAT DRIFT WOULD ACTUALLY COST, which is why these are assertions and not
 * comments:
 *
 *   - A standby with a LOWER `max_connections` (or max_worker_processes,
 *     max_wal_senders, max_prepared_transactions, max_locks_per_transaction)
 *     than the primary REFUSES TO START as a hot standby. Postgres says so
 *     plainly in the log and the pod CrashLoops, but the manifest that caused
 *     it looks perfectly reasonable.
 *   - A standby sized below the primary is a promotion candidate that cannot
 *     take over, which is most of the value of having one.
 *   - A standby whose `shared_buffers` no longer matches its memory limit is
 *     the same half-applied-rung bug the ladder exists to prevent, just on the
 *     copy nobody looks at.
 */

import { describe, it, expect } from '@jest/globals';
import { parse } from 'yaml';
import { ALL_TARGETS, K8S_TARGETS, read, yamlDocs } from '../src/index.js';

type Doc = Record<string, any>;

/** Server flags that are meaningful only on a standby, so parity skips them. */
const STANDBY_ONLY = new Set(['max_standby_streaming_delay', 'hot_standby_feedback']);

/** `['-c', 'a=1', '-c', 'b=2']` -> `{ a: '1', b: '2' }`. */
function serverArgs(args: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of args ?? []) {
    const m = /^([a-z_]+)=(.+)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function container(docs: Doc[], kind: string, name: string, cname: string): Doc {
  const wl = docs.find((d) => d.kind === kind && d.metadata?.name === name);
  if (!wl) throw new Error(`${kind}/${name} not found`);
  const c = wl.spec.template.spec.containers.find((x: Doc) => x.name === cname);
  if (!c) throw new Error(`${kind}/${name} has no container ${cname}`);
  return c;
}

describe.each(K8S_TARGETS)('%s — primary/replica parity', (target) => {
  const primaryDocs = yamlDocs<Doc>(`${target}/k8s/postgres.yaml`);
  const replicaDocs = yamlDocs<Doc>(`${target}/k8s/postgres-replica.yaml`);
  const primary = container(primaryDocs, 'Deployment', 'postgres', 'postgres');
  const replica = container(replicaDocs, 'StatefulSet', 'postgres-replica', 'postgres-replica');

  it('finds both workloads (guards a vacuous pass)', () => {
    // If either lookup silently returned undefined, every assertion below
    // would compare undefined to undefined and pass.
    expect(primary.image).toEqual(expect.stringContaining('postgres@sha256:'));
    expect(replica.image).toBe(primary.image);
  });

  it('gives the replica the same resource rung as the primary', () => {
    expect(replica.resources).toEqual(primary.resources);
  });

  it('gives the replica requests equal to its limits (Guaranteed QoS)', () => {
    // Stated separately from the parity assertion: if someone "fixes" both
    // workloads to be Burstable together, parity still holds and this catches
    // it. The data tier must not be evicted before a stateless pod.
    expect(replica.resources.requests).toEqual(replica.resources.limits);
  });

  it('shares every server setting that is not standby-specific', () => {
    const p = serverArgs(primary.args);
    const r = serverArgs(replica.args);
    expect(Object.keys(p).length).toBeGreaterThanOrEqual(6);
    const mismatched = Object.entries(p)
      .filter(([k, v]) => r[k] !== v)
      .map(([k, v]) => `${k}: primary=${v} replica=${r[k] ?? '(absent)'}`);
    expect(mismatched).toEqual([]);
  });

  it('adds nothing to the replica beyond the standby-only settings', () => {
    const p = serverArgs(primary.args);
    const extra = Object.keys(serverArgs(replica.args))
      .filter((k) => !(k in p) && !STANDBY_ONLY.has(k));
    expect(extra).toEqual([]);
  });

  it('keeps shared_buffers and effective_cache_size matched to the memory limit', () => {
    // The pairing the ladder exists to enforce: 25% and ~60% of the limit. A
    // rung change that moves the pod and forgets the server config buys page
    // cache and nothing else, and reports success either way.
    for (const [who, c] of [['primary', primary], ['replica', replica]] as const) {
      const args = serverArgs(c.args);
      const limit = String(c.resources.limits.memory);
      const mib = /^(\d+)Gi$/.test(limit) ? Number(/^(\d+)Gi$/.exec(limit)![1]) * 1024 : NaN;
      expect({ who, limit, parsed: Number.isNaN(mib) }).toEqual({ who, limit, parsed: false });
      const shared = /^(\d+)(MB|GB)$/.exec(args.shared_buffers);
      expect({ who, shared_buffers: args.shared_buffers, ok: shared !== null }).toEqual({ who, shared_buffers: args.shared_buffers, ok: true });
      const sharedMib = shared![2] === 'GB' ? Number(shared![1]) * 1024 : Number(shared![1]);
      expect({ who, ratio: Math.round((sharedMib / mib) * 100) }).toEqual({ who, ratio: 25 });
    }
  });

  it('declares the standby-only settings, which are the point of a read replica', () => {
    const r = serverArgs(replica.args);
    // max_standby_streaming_delay buys read queries time before replay
    // conflicts cancel them; hot_standby_feedback stops the primary vacuuming
    // rows a standby's open query still needs. Without the second, long reads
    // on the standby fail with "canceling statement due to conflict with
    // recovery" and the cause is on the OTHER server.
    expect(r.max_standby_streaming_delay).toBeDefined();
    expect(r.hot_standby_feedback).toBe('on');
  });

  it('puts max_slot_wal_keep_size on the primary, where the slots live', () => {
    // The guard that stops a stuck standby filling the PRIMARY's volume and
    // stopping writes. On the standby the setting is inert.
    expect(serverArgs(primary.args).max_slot_wal_keep_size).toBeDefined();
  });
});

describe.each(K8S_TARGETS)('%s — the replica is reachable and observable', (target) => {
  const docs = yamlDocs<Doc>(`${target}/k8s/postgres-replica.yaml`);
  const ss = docs.find((d) => d.kind === 'StatefulSet')!;

  it('is registered in the kustomization (or it is never applied)', () => {
    const kz = parse(read(`${target}/k8s/kustomization.yaml`));
    expect(kz.resources).toContain('postgres-replica.yaml');
  });

  it('exposes a real ClusterIP read Service, not the headless one', () => {
    // pgbouncer names exactly one host per [databases] entry and cannot
    // load-balance, so reaching more than one standby depends on kube-proxy
    // spreading new connections over this Service. A headless Service resolves
    // to pod addresses and would pin every connection to the first one DNS
    // returned.
    const svc = docs.find((d) => d.kind === 'Service' && d.metadata.name === 'postgres-read');
    expect(svc).toBeDefined();
    expect(svc!.spec.clusterIP).toBeUndefined();
    expect(svc!.spec.selector).toEqual({ app: 'postgres-replica' });
  });

  it('keeps the primary OUT of the read Service', () => {
    // A Service carrying both would round-robin WRITES onto a read-only
    // standby and fail roughly half of them with "cannot execute INSERT in a
    // read-only transaction".
    const svc = docs.find((d) => d.kind === 'Service' && d.metadata.name === 'postgres-read')!;
    expect(svc.spec.selector.app).not.toBe('postgres');
  });

  it('uses EXEC probes on loopback, never httpGet or tcpSocket', () => {
    // Under Istio ambient the kubelet -> podIP probe path does not work on this
    // cluster; every network-probed workload CrashLooped until it moved to an
    // exec probe on 127.0.0.1 (54bca985d).
    const c = ss.spec.template.spec.containers.find((x: Doc) => x.name === 'postgres-replica')!;
    for (const probe of ['readinessProbe', 'livenessProbe'] as const) {
      expect(c[probe].exec).toBeDefined();
      expect(c[probe].httpGet).toBeUndefined();
      expect(c[probe].tcpSocket).toBeUndefined();
      expect(JSON.stringify(c[probe].exec.command)).toContain('127.0.0.1');
    }
  });

  it('refuses to start unseeded — the first-init trap', () => {
    // THE failure this guard exists for: the official entrypoint runs initdb on
    // an empty PGDATA, which on a standby produces a second, INDEPENDENT
    // cluster that passes every probe here, serves queries, and shares no data
    // with the primary. Reads against it return an empty database rather than
    // an error. So the seeding step must exit non-zero rather than fall
    // through.
    const init = (ss.spec.template.spec.initContainers ?? []).find((c: Doc) => c.name === 'basebackup');
    expect(init).toBeDefined();
    const script = (init!.args ?? []).join('\n');
    expect(script).toContain('pg_basebackup');
    expect(script).toContain('exit 1');
    expect(script).toMatch(/refusing to start an UNSEEDED standby|refusing to start an unseeded standby/);
    // And it must not mount the init SQL, so even a standby that somehow
    // reached an empty PGDATA could not build its own schema.
    const c = ss.spec.template.spec.containers.find((x: Doc) => x.name === 'postgres-replica')!;
    expect(JSON.stringify(c.volumeMounts)).not.toContain('initdb');
  });

  it('seeds from the primary directly, not through pgbouncer', () => {
    // Replication needs a replication-mode startup packet, which pgbouncer does
    // not proxy — a standby seeded through the pooler fails at connect.
    const init = (ss.spec.template.spec.initContainers ?? []).find((c: Doc) => c.name === 'basebackup')!;
    const host = (init.env ?? []).find((e: Doc) => e.name === 'DB_PRIMARY_HOST');
    expect(host?.value).toBe('postgres');
  });

  it('is covered by a NetworkPolicy and a mesh ALLOW policy', () => {
    // Both fail silently when missing: the CNI drops read connections as a
    // timeout, and under ambient a workload with NO AuthorizationPolicy is
    // reachable by ANY mesh identity — a plugin build pod could read every
    // tenant's data straight off the standby.
    const netpol = yamlDocs<Doc>(`${target}/k8s/networkpolicy.yaml`)
      .find((d) => d.kind === 'NetworkPolicy' && d.spec?.podSelector?.matchLabels?.app === 'postgres-replica');
    expect(netpol).toBeDefined();
    const authz = yamlDocs<Doc>(`${target}/k8s/istio.yaml`)
      .find((d) => d.kind === 'AuthorizationPolicy' && d.spec?.selector?.matchLabels?.app === 'postgres-replica');
    expect(authz).toBeDefined();
    // pgbouncer must be admitted (it is the only client), and prometheus must
    // be able to scrape 9187 or ServiceDown fires for a healthy standby.
    const principals = JSON.stringify(authz!.spec.rules);
    expect(principals).toContain('sa/pgbouncer');
    expect(principals).toContain('sa/prometheus');
    expect(principals).toContain('9187');
  });

  it('has its own ServiceAccount, so the mesh identity is not the primary\'s', () => {
    expect(ss.spec.template.spec.serviceAccountName).toBe('postgres-replica');
    const sa = yamlDocs<Doc>(`${target}/k8s/istio.yaml`)
      .find((d) => d.kind === 'ServiceAccount' && d.metadata?.name === 'postgres-replica');
    expect(sa).toBeDefined();
  });
});

const AWS_TARGETS = ['deploy/aws/eks', 'deploy/aws/ec2'] as const;
const envValue = (target: string, key: string): string | undefined =>
  new RegExp(`^${key}=(.*)$`, 'm').exec(read(`${target}/.env.example`))?.[1];

describe('replica counts are env-driven, and bounded by what storage can host', () => {
  it.each(AWS_TARGETS)('%s: the autoscaler owns the count, so the manifest must not', (target) => {
    // A declared `replicas` would be re-applied on every deploy, scaling the
    // standbys back in — terminating one mid-stream — before the HPA restored
    // them. Omitting the field makes KEDA the sole owner.
    const ss = yamlDocs<Doc>(`${target}/k8s/postgres-replica.yaml`).find((d) => d.kind === 'StatefulSet')!;
    expect(ss.spec.replicas).toBeUndefined();
  });

  it('keeps the local targets pinned at exactly one standby', () => {
    // No ScaledObject there, so the manifest value IS the count. A laptop or a
    // compose host gains nothing from a second full copy of the database: a
    // standby there shares the primary's CPU and disk, so it is a copy, not
    // capacity.
    const ss = yamlDocs<Doc>('deploy/local/minikube/k8s/postgres-replica.yaml').find((d) => d.kind === 'StatefulSet')!;
    expect(ss.spec.replicas).toBe(1);
    expect(yamlDocs<Doc>('deploy/local/minikube/k8s/postgres-replica.yaml').some((d) => d.kind === 'ScaledObject')).toBe(false);
  });

  it.each(AWS_TARGETS)('%s: scales out on usage, with KEDA knobs that are actually honoured', (target) => {
    const so = yamlDocs<Doc>(`${target}/k8s/postgres-replica.yaml`).find((d) => d.kind === 'ScaledObject');
    expect(so).toBeDefined();
    // scaleTargetRef defaults to Deployment; without this the ScaledObject
    // points at a Deployment that does not exist and reports a scaler error
    // rather than scaling anything.
    expect(so!.spec.scaleTargetRef.kind).toBe('StatefulSet');
    expect(so!.spec.scaleTargetRef.name).toBe('postgres-replica');
    // Env-driven, not hard-coded.
    expect(so!.spec.minReplicaCount).toBe('${PG_READ_REPLICA_MIN}');
    expect(so!.spec.maxReplicaCount).toBe('${PG_READ_REPLICA_MAX}');
    // cooldownPeriod/pollingInterval are IGNORED when minReplicaCount >= 1 —
    // KEDA hands scaling to a plain HPA and warns they are "configured but not
    // relevant". plugin.yaml carries the scar of setting values that were
    // silently never applied, so damping must live in `behavior`.
    expect(so!.spec.cooldownPeriod).toBeUndefined();
    expect(so!.spec.pollingInterval).toBeUndefined();
    const behavior = so!.spec.advanced.horizontalPodAutoscalerConfig.behavior;
    // A new standby is seeded with pg_basebackup, which loads the PRIMARY while
    // it is already under pressure. Long windows and one pod per period are
    // what stop automatic scale-up deepening the incident it reacts to.
    expect(behavior.scaleUp.stabilizationWindowSeconds).toBeGreaterThanOrEqual(600);
    expect(behavior.scaleUp.policies[0]).toMatchObject({ type: 'Pods', value: 1 });
    expect(behavior.scaleUp.policies[0].periodSeconds).toBeGreaterThanOrEqual(900);
    // Scale-down damped harder: raising the standby RUNG lowers utilization as
    // a share of the new, larger request, which looks like idleness.
    expect(behavior.scaleDown.stabilizationWindowSeconds)
      .toBeGreaterThanOrEqual(behavior.scaleUp.stabilizationWindowSeconds);
    // Utilization against requests, and requests == limits here, so the target
    // is a share of the real ceiling rather than of a smaller reservation.
    const triggers = (so!.spec.triggers as Doc[]).map((t) => t.type);
    expect(triggers).toEqual(expect.arrayContaining(['cpu', 'memory']));
    for (const t of so!.spec.triggers as Doc[]) expect(t.metricType).toBe('Utilization');
  });

  it('never lets the ceiling exceed the standby volumes a target can actually bind', () => {
    // THE FAILURE THIS PREVENTS: ec2 and minikube bind hostPath PVs manually,
    // so a volumeClaimTemplate provisions nothing — the autoscaler raises
    // replicas, the pod sits Pending forever, and nothing pages for a pod that
    // was never Ready. `pb_read_replica_env` refuses the deploy at runtime;
    // this catches it at build time. eks declares no PVs (pb-ebs provisions
    // dynamically) and is therefore unbounded here.
    const bad: string[] = [];
    for (const t of ALL_TARGETS) {
      const max = Number(envValue(t, 'PG_READ_REPLICA_MAX'));
      expect({ t, max: Number.isFinite(max) }).toEqual({ t, max: true });
      const file = `${t}/k8s/postgres-replica.yaml`;
      let declared = 0;
      try {
        declared = yamlDocs<Doc>(file).filter((d) => d.kind === 'PersistentVolume').length;
      } catch { declared = 0; } // docker: no k8s manifests
      if (declared > 0 && max > declared) bad.push(`${t}: max=${max} but ${declared} PV(s) declared`);
    }
    expect(bad).toEqual([]);
  });

  it('keeps the floor at 1 on every target', () => {
    const wrong = ALL_TARGETS
      .map((t) => `${t}=${envValue(t, 'PG_READ_REPLICA_MIN')}`)
      .filter((v) => !v.endsWith('=1'));
    expect(wrong).toEqual([]);
  });

  it('pins the local ceiling to 1 and allows 2 on AWS', () => {
    expect(envValue('deploy/local/minikube', 'PG_READ_REPLICA_MAX')).toBe('1');
    expect(envValue('deploy/local/docker', 'PG_READ_REPLICA_MAX')).toBe('1');
    for (const t of AWS_TARGETS) expect(envValue(t, 'PG_READ_REPLICA_MAX')).toBe('2');
  });

  it('substitutes the tokens at apply time, or the manifest ships a literal', () => {
    // `${PG_READ_REPLICA_MIN}` reaching the API server is rejected as a
    // non-integer one document deep into a stream of hundreds. The expansion is
    // a per-target sed allow-list, so a target can be missed silently.
    for (const [target, script] of [
      ['deploy/aws/eks', 'deploy/aws/eks/bin/setup.sh'],
      ['deploy/aws/ec2', 'deploy/aws/ec2/bin/startup.sh'],
    ] as const) {
      const sh = read(script);
      expect({ target, min: sh.includes('{PG_READ_REPLICA_MIN}|${PB_PG_READ_REPLICA_MIN}') })
        .toEqual({ target, min: true });
      expect({ target, max: sh.includes('{PG_READ_REPLICA_MAX}|${PB_PG_READ_REPLICA_MAX}') })
        .toEqual({ target, max: true });
      // ...and the validator runs BEFORE the apply, so a bad value fails the
      // deploy rather than producing a Pending pod.
      expect({ target, validated: /pb_read_replica_env "\$K8S_DIR"/.test(sh) })
        .toEqual({ target, validated: true });
      expect(sh.indexOf('pb_read_replica_env')).toBeLessThan(sh.indexOf('pb_apply_manifests "$K8S_DIR"'));
    }
  });

  it('keeps the alert rules count-agnostic, so one file serves all three', () => {
    // alert-rules.yml is byte-identical across the Kubernetes targets, which
    // means no rule may mention a replica COUNT: eks may scale to 2 and
    // minikube is fixed at 1. "zero", "per-slot" and "per-client" are fine.
    const rules = read('deploy/aws/eks/config/prometheus/alert-rules.yml');
    const replicaRules = rules.split('- alert:').filter((r) => /Replica|Replication/.test(r.split('\n')[0]));
    expect(replicaRules.length).toBeGreaterThanOrEqual(4);
    for (const rule of replicaRules) {
      const expr = /expr:([\s\S]*?)\n\s{8}(for|labels):/.exec(rule)?.[1] ?? '';
      // A threshold comparing against a replica count would look like
      // `< 3` / `!= 2` on a count series.
      expect(expr).not.toMatch(/connected_standbys\s*[<>!]=?\s*[1-9]/);
    }
  });
});

describe('postgres-exporter custom queries', () => {
  const docker = read('deploy/local/docker/config/postgres-exporter/queries.yml').replace(/\n+$/, '');

  it('is byte-identical in the compose file and every k8s ConfigMap', () => {
    // The replication ALERTS are written against the metric names this file
    // defines. A target whose copy drifts has no such series, so its rules
    // match nothing — which looks exactly like a healthy database.
    const drift: string[] = [];
    for (const t of K8S_TARGETS) {
      const cm = yamlDocs<Doc>(`${t}/k8s/postgres.yaml`)
        .find((d) => d.kind === 'ConfigMap' && d.metadata?.name === 'postgres-exporter-queries');
      if (!cm) { drift.push(`${t}: ConfigMap missing`); continue; }
      const embedded = String(cm.data['queries.yml']).replace(/\n+$/, '');
      if (embedded !== docker) drift.push(`${t}: differs from the compose copy`);
    }
    expect(drift).toEqual([]);
  });

  it('defines every metric the replication alerts reference', () => {
    // The guard against the failure this plan already tripped over once:
    // writing a rule against a metric nobody collects.
    const q = parse(docker) as Record<string, Doc>;
    const defined = new Set<string>();
    for (const [namespace, body] of Object.entries(q)) {
      for (const m of body.metrics as Doc[]) {
        for (const [col, meta] of Object.entries(m)) {
          if ((meta as Doc).usage !== 'LABEL') defined.add(`${namespace}_${col}`);
        }
      }
    }
    const rules = read('deploy/aws/eks/config/prometheus/alert-rules.yml');
    const referenced = [...new Set(rules.match(/\bpb_[a-z_]+\b/g) ?? [])];
    expect(referenced.length).toBeGreaterThanOrEqual(4);
    expect(referenced.filter((m) => !defined.has(m))).toEqual([]);
  });

  it('is mounted on the primary only, where replication slots live', () => {
    for (const t of K8S_TARGETS) {
      const exp = container(yamlDocs<Doc>(`${t}/k8s/postgres.yaml`), 'Deployment', 'postgres', 'postgres-exporter');
      const path = (exp.env ?? []).find((e: Doc) => e.name === 'PG_EXPORTER_EXTEND_QUERY_PATH');
      expect({ t, path: path?.value }).toEqual({ t, path: '/etc/postgres-exporter/queries.yml' });
      // The standby's exporter deliberately does NOT get it: the slot view is
      // empty there, and a second copy would be a second thing to keep in sync.
      const rep = container(yamlDocs<Doc>(`${t}/k8s/postgres-replica.yaml`), 'StatefulSet', 'postgres-replica', 'postgres-exporter');
      expect({ t, env: (rep.env ?? []).map((e: Doc) => e.name) }).toEqual({
        t, env: ['DATA_SOURCE_URI', 'DATA_SOURCE_USER', 'DATA_SOURCE_PASS'],
      });
    }
  });
});

describe('the read path is wired consistently across every target', () => {
  it('gives every target a read pool pointed at the standby Service', () => {
    const missing: string[] = [];
    for (const t of ALL_TARGETS) {
      const cfg = t === 'deploy/local/docker'
        ? read('deploy/local/docker/config/pgbouncer/pgbouncer.ini')
        : read(`${t}/k8s/pgbouncer.yaml`);
      if (!/pipeline_builder_read\s*=\s*host=postgres-read/.test(cfg)) missing.push(t);
    }
    expect(missing).toEqual([]);
  });

  it('leaves no per-tier pool behind', () => {
    // They were dead configuration — the names appeared in these four files and
    // nowhere else in the repository, so the isolation their comments claimed
    // was never in effect. See decision D2 in the plan. This assertion stops
    // them being reintroduced as decoration rather than as real routing.
    const leftovers: string[] = [];
    for (const t of ALL_TARGETS) {
      const cfg = t === 'deploy/local/docker'
        ? read('deploy/local/docker/config/pgbouncer/pgbouncer.ini')
        : read(`${t}/k8s/pgbouncer.yaml`);
      for (const tier of ['developer', 'pro', 'team', 'enterprise', 'unlimited']) {
        if (new RegExp(`^\\s*pipeline_builder_${tier}\\s*=`, 'm').test(cfg)) leftovers.push(`${t}: ${tier}`);
      }
    }
    expect(leftovers).toEqual([]);
  });

  it('caps every pool, so the pooler cannot overcommit the server', () => {
    // minikube and docker shipped UNCAPPED tier pools totalling up to 310
    // server connections against a Postgres running on the image default of
    // 100 — the exact "sorry, too many clients" failure the AWS copies were
    // fixed for, never backported. Latent only because those pools were dead.
    const uncapped: string[] = [];
    for (const t of ALL_TARGETS) {
      const cfg = t === 'deploy/local/docker'
        ? read('deploy/local/docker/config/pgbouncer/pgbouncer.ini')
        : read(`${t}/k8s/pgbouncer.yaml`);
      for (const line of cfg.split('\n')) {
        if (!/^\s*pipeline_builder\w*\s*=\s*host=/.test(line)) continue;
        if (!/max_db_connections=\d+/.test(line)) uncapped.push(`${t}: ${line.trim()}`);
      }
    }
    expect(uncapped).toEqual([]);
  });

  it('gives every target a max_connections high enough for its pooler', () => {
    // The budget the caps above add up to, against what the server allows.
    const bad: string[] = [];
    for (const t of ALL_TARGETS) {
      const isDocker = t === 'deploy/local/docker';
      const cfg = isDocker
        ? read('deploy/local/docker/config/pgbouncer/pgbouncer.ini')
        : read(`${t}/k8s/pgbouncer.yaml`);
      // Pools on the PRIMARY only; the read pool draws on the standby's budget.
      const primaryPools = cfg.split('\n')
        .filter((l) => /^\s*pipeline_builder\w*\s*=\s*host=postgres\b/.test(l))
        .map((l) => Number(/max_db_connections=(\d+)/.exec(l)![1]));
      const replicas = isDocker ? 1 : Number(/^\s*replicas:\s*(\d+)/m.exec(read(`${t}/k8s/pgbouncer.yaml`))![1]);
      const demand = primaryPools.reduce((a, b) => a + b, 0) * replicas;
      const server = isDocker
        ? Number(/max_connections=(\d+)/.exec(read('deploy/local/docker/docker-compose.yml'))![1])
        : Number(/"max_connections=(\d+)"/.exec(read(`${t}/k8s/postgres.yaml`))![1]);
      if (demand >= server) bad.push(`${t}: pooler can ask for ${demand}, server allows ${server}`);
    }
    expect(bad).toEqual([]);
  });

  it('documents the read and replication env on every target', () => {
    const missing: string[] = [];
    for (const t of ALL_TARGETS) {
      const env = read(`${t}/.env.example`);
      for (const k of ['DB_READ_HOST', 'DB_READ_DATABASE', 'DB_READ_ENABLED', 'DB_READ_MAX_LAG_SECONDS',
        'DB_READ_WRITE_PIN_TTL_SECONDS', 'DB_REPLICATION_USER', 'DB_REPLICATION_PASSWORD']) {
        if (!new RegExp(`^${k}=`, 'm').test(env)) missing.push(`${t}: ${k}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('ships with DB_READ_HOST unset, so reads stay on the primary until someone opts in', () => {
    // The whole feature is inert out of the box. Phase 5's guardrails exist but
    // have never run against a real replica, so a target that shipped with a
    // host configured would be serving replica reads with no operator having
    // chosen that.
    for (const t of ALL_TARGETS) {
      expect({ t, line: /^DB_READ_HOST=.*$/m.exec(read(`${t}/.env.example`))?.[0] })
        .toEqual({ t, line: 'DB_READ_HOST=""' });
    }
  });
});

describe('postgres-init.sql replication role', () => {
  it('is identical on every target', () => {
    const shas = ALL_TARGETS.map((t) => read(`${t}/postgres-init.sql`));
    expect(new Set(shas).size).toBe(1);
  });

  it('creates the replication role separately from the application role', () => {
    const sql = read('deploy/local/docker/postgres-init.sql');
    // Replication streams WAL, which is BELOW row-level security — a role that
    // can replicate can read every org's rows. The application role is
    // NOREPLICATION for that reason, and init must refuse rather than quietly
    // grant it.
    expect(sql).toContain('LOGIN REPLICATION NOSUPERUSER NOBYPASSRLS');
    expect(sql).toMatch(/NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD/);
    expect(sql).toContain('DB_REPLICATION_USER must not equal DB_USER');
  });

  it('is reachable by the primary on every target (the env must be passed in)', () => {
    // postgres-init.sql reads these with \\getenv from the POSTGRES container's
    // environment. Without them the role is silently skipped and the standby's
    // seeding step fails — correct, but only diagnosable from the standby's log.
    for (const t of K8S_TARGETS) {
      const env = JSON.stringify(container(yamlDocs<Doc>(`${t}/k8s/postgres.yaml`), 'Deployment', 'postgres', 'postgres').env);
      expect({ t, user: env.includes('DB_REPLICATION_USER'), pass: env.includes('DB_REPLICATION_PASSWORD') })
        .toEqual({ t, user: true, pass: true });
    }
    const compose = read('deploy/local/docker/docker-compose.yml');
    expect(compose).toContain('DB_REPLICATION_USER: ${DB_REPLICATION_USER:-}');
  });

  it('puts the credential in postgres-secret', () => {
    const script = read('deploy/bin/k8s-resources.sh');
    expect(script).toContain('--from-literal=DB_REPLICATION_USER=');
    expect(script).toContain('--from-literal=DB_REPLICATION_PASSWORD=');
  });

  it('generates the password and refuses to deploy on the placeholder', () => {
    const gen = read('deploy/bin/gen-env-secrets.sh');
    expect(gen).toContain('DB_REPLICATION_PASSWORD=${pgrepl}');
    // The CHANGE_ME guard: without this entry a deploy would proceed with a
    // literal placeholder as the replication password.
    expect(gen).toMatch(/\^\(SECRET_ENCRYPTION_KEY\|[^)]*DB_REPLICATION_PASSWORD/);
  });
});

describe('backups come off the standby', () => {
  it.each(['deploy/aws/eks', 'deploy/aws/ec2'])('%s dumps from postgres-read, falling back to the primary', (target) => {
    const cj = yamlDocs<Doc>(`${target}/k8s/backup-cronjob.yaml`).find((d) => d.kind === 'CronJob')!;
    const script = (cj.spec.jobTemplate.spec.template.spec.containers[0].args ?? []).join('\n');
    // pg_dump holds a transaction open and reads every table; on the primary
    // that is a scheduled load spike on the only write path there is.
    expect(script).toContain('BACKUP_POSTGRES_HOST:-postgres-read');
    // But a missing backup is worse than one that cost primary IO.
    expect(script).toContain('PG_BACKUP_HOST=postgres');
    // A dump from a standby is only as fresh as REPLAY, not as fresh as its
    // timestamp — without this the restore point is unknown.
    expect(script).toContain('restorepoint');
    expect(script).toContain('pg_last_wal_replay_lsn');
  });

  it('warns that a restore invalidates every standby', () => {
    // A restore starts a NEW TIMELINE. A standby left streaming may keep
    // serving its pre-restore copy with no error at all, so reads routed there
    // return the state just restored away from.
    const restore = read('deploy/bin/restore.sh');
    expect(restore).toContain('THE READ REPLICAS ARE NOW INVALID');
    expect(restore).toContain('pg_drop_replication_slot');
  });
});
