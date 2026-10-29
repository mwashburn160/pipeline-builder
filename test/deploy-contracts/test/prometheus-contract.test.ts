// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guard for Istio mesh metric collection.
 *
 * The ambient profile enables mesh telemetry on its own — `defaultProviders.
 * metrics: [prometheus]`, and every mesh pod ships prometheus.io/* annotations
 * (ztunnel :15020, istiod + istio-cni :15014). What was missing for a long time
 * was the collection side: the only pod-discovery job was namespace-scoped to
 * `pipeline-builder`, so istio-system was never scraped and several hundred
 * live `istio_tcp_*` series — the mesh topology plus mTLS coverage — were simply
 * discarded. Nothing failed; the data just never arrived.
 *
 * These assertions pin both halves of the fix across every kubernetes target,
 * because each half is silent when absent.
 */

import { describe, it, expect } from '@jest/globals';
import { K8S_TARGETS, read } from '../src/index.js';


/** Every target that runs Prometheus against an Istio ambient mesh. */


describe.each(K8S_TARGETS)('istio mesh metrics — %s', (target) => {
  const promCfg = read(`${target}/config/prometheus/prometheus.yml`);
  const netpol = read(`${target}/k8s/networkpolicy.yaml`);

  it('scrapes the istio-system namespace', () => {
    expect(promCfg).toContain("job_name: 'istio-mesh'");
    // The job must target istio-system — the mesh components live there, and
    // the app job deliberately does not look outside pipeline-builder.
    const job = promCfg.slice(promCfg.indexOf("job_name: 'istio-mesh'"));
    expect(job).toContain('istio-system');
  });

  it('keeps the annotation-based discovery contract the mesh pods satisfy', () => {
    const job = promCfg.slice(promCfg.indexOf("job_name: 'istio-mesh'"));
    // ztunnel/istiod/istio-cni carry prometheus.io/scrape + /port; the job has
    // to honour both or it silently scrapes the wrong port (or nothing).
    expect(job).toContain('__meta_kubernetes_pod_annotation_prometheus_io_scrape');
    expect(job).toContain('__meta_kubernetes_pod_annotation_prometheus_io_port');
  });

  it('grants prometheus egress to the mesh metrics ports', () => {
    // Without this the scrape is dropped wherever NetworkPolicy is enforced:
    // allow-internal-egress is same-namespace only, and nothing else covers
    // 15020/15014. Note kindnet (minikube/ec2) does not enforce policy, so this
    // failure would appear ONLY on eks — hence the guard.
    expect(netpol).toContain('allow-prometheus-mesh-scrape');
    const policy = netpol.slice(netpol.indexOf('allow-prometheus-mesh-scrape'));
    expect(policy).toContain('15020'); // ztunnel
    expect(policy).toContain('15014'); // istiod + istio-cni
  });

  it('alerts on plaintext traffic between meshed workloads', () => {
    const rules = read(`${target}/config/prometheus/alert-rules.yml`);
    expect(rules).toContain('alert: MeshMTLSDegraded');
    const rule = rules.slice(rules.indexOf('alert: MeshMTLSDegraded'));
    // The scoping predicates are the whole rule — without them this pages on
    // ingress traffic, kubelet probes and our own istio-system scrape, all of
    // which are legitimately not mTLS. Behaviour is proven separately by the
    // promtool unit tests in
    // deploy/local/minikube/config/prometheus/alert-rules.test.yml.
    expect(rule).toContain('reporter="destination"');
    expect(rule).toContain('source_workload!="unknown"');
    expect(rule).toContain('source_workload_namespace="pipeline-builder"');
    expect(rule).toContain('destination_workload_namespace="pipeline-builder"');
  });

  it('alerts on refused internal-route calls and on service tokens that will not verify', () => {
    // The two failure modes per-service signing introduces, and neither is
    // visible in any other signal: a refused internal call is a 403 the CALLER
    // may swallow, and an unverifiable service token is a 401 on a background
    // hop. Without these, a half-finished key rotation (private key rolled out
    // before the bundle) looks like nothing at all.
    const rules = read(`${target}/config/prometheus/alert-rules.yml`);
    expect(rules).toContain('alert: InternalRouteRefused');
    expect(rules).toContain('internal_route_refused_total');
    expect(rules).toContain('alert: ServiceTokenVerifyFailing');
    expect(rules).toContain('service_token_verify_total{result!="ok"}');
    // `subject_mismatch` — a valid signature from the WRONG service — must page,
    // so the rule may not filter results down to the benign ones.
    expect(rules.slice(rules.indexOf('alert: ServiceTokenVerifyFailing'))).toContain('severity: critical');
  });

  it('alerts when a scraped service stops responding', () => {
    const rules = read(`${target}/config/prometheus/alert-rules.yml`);
    // Every other rule needs the service alive enough to emit the metric it
    // alerts on, so a crashlooping or hung pod tripped nothing at all.
    expect(rules).toContain('alert: ServiceDown');
    expect(rules).toContain('up{job="kubernetes-pods"} == 0');
  });

  it('scrapes the observability stack itself', () => {
    // Without these, a Loki/Thanos/Alertmanager failure is invisible — and
    // LokiRateCapBreach was a DEAD RULE, alerting on a metric
    // (loki_discarded_samples_total) that only Loki emits and nothing collected.
    const files: Record<string, string> = {
      'prometheus.yaml': '9090',
      'alertmanager.yaml': '9093',
      'loki.yaml': '3100',
      'alloy.yaml': '12345',
      'jaeger.yaml': '14269',
    };
    for (const [file, port] of Object.entries(files)) {
      const manifest = read(`${target}/k8s/${file}`);
      expect(manifest).toContain('prometheus.io/scrape: "true"');
      expect(manifest).toContain(`prometheus.io/port: "${port}"`);
    }
    // thanos-query and thanos-store-gateway share one manifest on their own ports.
    const thanos = read(`${target}/k8s/thanos-query.yaml`);
    expect(thanos).toContain('prometheus.io/port: "10902"'); // store-gateway
    expect(thanos).toContain('prometheus.io/port: "9090"'); // query
  });

  it('deploys an exporter sidecar for every datastore', () => {
    // Postgres/Mongo/Redis/pgbouncer speak no Prometheus, so without these the
    // entire data tier is unmonitored — including the single-primary Postgres
    // that is the documented data-tier SPOF.
    const sidecars: Array<[string, string, string]> = [
      ['postgres.yaml', 'postgres-exporter', '9187'],
      ['mongodb.yaml', 'mongodb-exporter', '9216'],
      ['pgbouncer.yaml', 'pgbouncer-exporter', '9127'],
    ];
    for (const [file, container, port] of sidecars) {
      const m = read(`${target}/k8s/${file}`);
      expect(m).toContain(`name: ${container}`);
      expect(m).toContain(`prometheus.io/port: "${port}"`);
    }
    // redis lives in redis.yaml locally and redis-sentinel.yaml on AWS.
    const redisFile = target.includes('minikube') ? 'redis.yaml' : 'redis-sentinel.yaml';
    const redis = read(`${target}/k8s/${redisFile}`);
    expect(redis).toContain('name: redis-exporter');
    expect(redis).toContain('prometheus.io/port: "9121"');
  });

  it('alerts when a datastore stops answering its exporter', () => {
    const rules = read(`${target}/config/prometheus/alert-rules.yml`);
    // Distinct from ServiceDown: these fire while the exporter is healthy and
    // `up` is 1, which is what a hung/wedged database looks like from outside.
    // Metric names were verified against the exporter binaries, not docs.
    expect(rules).toContain('expr: mongodb_up == 0');
    expect(rules).toContain('expr: redis_up == 0');

    // POSTGRES IS SCOPED, and this asserts the scoping rather than the bare
    // expression. The read replica runs the SAME postgres-exporter image, so an
    // unqualified `pg_up == 0` matched the standby too — firing a
    // severity:critical alert whose text says "every service loses writes" and
    // whose remediation points at deploy/postgres, for a standby whose loss the
    // read path already absorbs by falling back.
    expect(rules).toContain('expr: pg_up{service!="postgres-replica"} == 0');
    expect(rules).not.toContain('expr: pg_up == 0');
    // `!=` and not `==`: an ABSENT label satisfies `!=`, and on docker it IS
    // absent — that target scrapes through a static config with no
    // relabelling, so its pg_up carries no `service` label at all.
    // `service == "postgres"` would match nothing there, silently disabling a
    // critical alert on the target where that is hardest to notice.
    expect(rules).not.toContain('pg_up{service="postgres"} == 0');
  });

  it('gives the standby its own, non-critical unreachable alert', () => {
    // Only where the standby HAS an exporter — docker runs a single one,
    // pointed at the primary, and observes its standby from the primary's side
    // (PostgresReplicationStopped) instead.
    const rules = read(`${target}/config/prometheus/alert-rules.yml`);
    expect(rules).toContain('expr: pg_up{service="postgres-replica"} == 0');
    const block = rules.slice(rules.indexOf('- alert: PostgresReplicaUnreachable'));
    // Losing a standby costs read throughput and a promotion candidate — not
    // writes, and not correctness. Paging for it would train people to ignore
    // the channel that carries the primary's alert.
    expect(/severity: warning/.test(block.slice(0, 400))).toBe(true);
  });

  it('ships Grafana and Kiali as LEAN-droppable admin UIs', () => {
    for (const file of ['grafana.yaml', 'kiali.yaml']) {
      expect(() => read(`${target}/k8s/${file}`)).not.toThrow();
    }
    // Both must be registered, or the manifests are dead files.
    const kustomization = read(`${target}/k8s/kustomization.yaml`);
    expect(kustomization).toContain('grafana.yaml');
    expect(kustomization).toContain('kiali.yaml');
    // Reached through nginx on a subpath, like pgAdmin. On the AWS targets the
    // admin routes live in admin-uis.conf (gated, off by default — see the
    // admin-console contract below); locally they are in nginx.conf itself.
    const nginx = target.startsWith('deploy/aws/')
      ? read(`${target}/nginx/admin-uis.conf`)
      : read(`${target}/nginx/nginx.conf`);
    expect(nginx).toContain('location /grafana/');
    expect(nginx).toContain('location /kiali/');
  });

  it('keeps Kiali read-only and token-authenticated', () => {
    // nginx applies NO auth to /kiali/, and Kiali has no tenant model — it shows
    // every org's mesh. `anonymous` here would publish that to anyone who can
    // reach the gateway.
    const kiali = read(`${target}/k8s/kiali.yaml`);
    expect(kiali).toContain('strategy: token');
    expect(kiali).not.toContain('strategy: anonymous');
    expect(kiali).toContain('view_only_mode: true');
    // Read-only RBAC: no mutation verbs anywhere in the ClusterRole.
    const role = kiali.slice(kiali.indexOf('kind: ClusterRole'), kiali.indexOf('kind: ClusterRoleBinding'));
    for (const verb of ['"delete"', '"update"', '"patch"']) {
      expect(role).not.toContain(verb);
    }
  });

  it('alerts when the control plane stops reporting', () => {
    const rules = read(`${target}/config/prometheus/alert-rules.yml`);
    expect(rules).toContain('alert: IstiodDown');
    // Ties the alert to the scrape job added above — renaming one without the
    // other silently disables it.
    expect(rules).toContain('up{job="istio-mesh", mesh_component="istiod"}');
  });

  it('collects the metric its PersistentVolume alerts read, with the RBAC to do it', () => {
    // The alerts are worthless without the scrape job, and the scrape job 401s
    // without nodes/metrics: nodes/proxy only authorises going THROUGH the API
    // server, not a direct :10250 scrape. Egress on 10250 is already granted by
    // allow-kube-api-egress, asserted separately below.
    expect(promCfg).toContain("job_name: 'kubelet'");
    expect(promCfg).toMatch(/kubelet_volume_stats_\(available\|capacity\|used\)_bytes\|kubelet_volume_stats_inodes\(_free\)\?/);
    // ...and cAdvisor for the node disk, which is the ONLY storage signal the
    // hostPath targets have: their manual hostPath PVs report no volume stats.
    expect(promCfg).toContain("job_name: 'kubelet-cadvisor'");
    expect(promCfg).toContain('/metrics/cadvisor');
    expect(promCfg).toMatch(/container_fs_\(limit\|usage\)_bytes\|container_fs_inodes_\(free\|total\)/);
    const rbac = read(`${target}/k8s/prometheus.yaml`);
    expect(rbac).toContain('nodes/metrics');
    const np = read(`${target}/k8s/networkpolicy.yaml`);
    const kubeApi = np.split('---').find((d) => d.includes('name: allow-kube-api-egress')) ?? '';
    expect(kubeApi).toContain('prometheus');
    expect(kubeApi).toContain('10250');
  });

  it('collects the container CPU/memory series the Postgres ladder alerts read', () => {
    // THE GAP THIS CLOSES. Unlike alert-rules.yml, prometheus.yml is NOT
    // byte-identical across targets — three legitimate checksums, because the
    // scrape topologies genuinely differ — so this job had to be added to eks,
    // ec2 and minikube by hand. A target that was missed simply has no data:
    // its saturation alerts never fire, and a rule that matches nothing looks
    // exactly like a healthy database. Nothing else would catch that.
    expect(promCfg).toContain("job_name: 'kubelet-cadvisor-db'");
    const job = promCfg.slice(promCfg.indexOf("job_name: 'kubelet-cadvisor-db'"));
    // Usage AND the spec gauges: every threshold is a RATIO of usage to limit,
    // so the limit has to be queryable too. kube-state-metrics is not a
    // substitute — it exposes limits but no usage, and it is absent on minikube.
    // Matched WITHOUT the shared `container_` prefix: the job expresses these
    // as one regex alternation, `container_(cpu_usage_seconds_total|...)`, so
    // the full metric names never appear as literals.
    for (const metric of ['cpu_usage_seconds_total', 'memory_working_set_bytes',
      'spec_cpu_quota', 'spec_cpu_period', 'spec_memory_limit_bytes']) {
      expect(job).toContain(metric);
    }
    // Scoped to the database pods, which is what keeps the cardinality cost
    // near zero — cAdvisor unfiltered is ~3MB of series per node.
    expect(job).toMatch(/regex: 'postgres\(-replica\)\?-\.\*'/);
    // And it must NOT inherit the general job's label drop: `pod` and
    // `container` are what tell the primary from a standby, since cAdvisor
    // carries no workload label.
    const generalJob = promCfg.slice(
      promCfg.indexOf("job_name: 'kubelet-cadvisor'"),
      promCfg.indexOf("job_name: 'kubelet-cadvisor-db'"),
    );
    expect(generalJob).toContain('labeldrop');
    const nextJob = job.indexOf('job_name:', 'job_name:'.length);
    expect(job.slice(0, nextJob === -1 ? job.length : nextJob)).not.toContain('labeldrop');
  });

  it('collects node CPU with a denominator that survives the filter chain', () => {
    // Same per-target hand-wiring risk as the DB job above. The subtle failure
    // here is the DENOMINATOR: machine_cpu_cores carries no `id` label, so an
    // `id` keep written as a bare '/' drops it and NodeCpuSaturated silently
    // matches nothing — an idle node and a pegged one look identical.
    expect(promCfg).toContain("job_name: 'kubelet-cadvisor-node'");
    const job = promCfg.slice(promCfg.indexOf("job_name: 'kubelet-cadvisor-node'"));
    const next = job.indexOf('job_name:', 'job_name:'.length);
    const nodeJob = job.slice(0, next === -1 ? job.length : next);
    expect(nodeJob).toContain('machine_(cpu_cores|memory_bytes)');
    expect(nodeJob).toContain('container_(cpu_usage_seconds_total|memory_working_set_bytes)');
    // The alternation that admits the empty `id`. Without it there is no ratio.
    expect(nodeJob).toMatch(/regex: '\/\|'/);
    // It must NOT carry the filesystem job's device filter: neither series has
    // a `device` label, so that would drop both.
    expect(nodeJob).not.toContain('device');
  });

  it('collects CPU throttling for the app tier, with its denominator', () => {
    // Throttling is invisible to every usage-ratio rule in the file: a pod can
    // average 40% CPU and still stall in most 100ms periods. periods_total is
    // required because a throttled COUNT means nothing without a total.
    expect(promCfg).toContain("job_name: 'kubelet-cadvisor-apps'");
    const job = promCfg.slice(promCfg.indexOf("job_name: 'kubelet-cadvisor-apps'"));
    const next = job.indexOf('job_name:', 'job_name:'.length);
    const appsJob = job.slice(0, next === -1 ? job.length : next);
    // Matched as the ALTERNATION the job actually writes — the same trap the DB
    // job's assertion above documents: `container_cpu_cfs_(periods|throttled_periods)_total`
    // means neither full metric name appears as a literal anywhere.
    expect(appsJob).toContain('container_cpu_cfs_(periods|throttled_periods)_total');
    // Scoped the same way as the DB job — namespace, pod, container — which is
    // what keeps this a few hundred series instead of the cAdvisor firehose.
    expect(appsJob).toContain("regex: 'pipeline-builder'");
    expect(appsJob).toMatch(/source_labels: \[container\]/);
    // Postgres gets throttling too, on its own job, or the ladder would be
    // reasoning about saturation while blind to the quota enforcing it.
    const dbJob = promCfg.slice(promCfg.indexOf("job_name: 'kubelet-cadvisor-db'"));
    expect(dbJob.slice(0, dbJob.indexOf("job_name: 'kubelet-cadvisor-node'"))).toContain('cpu_cfs_throttled_periods_total');
    // And the cgroup memory pair, which is what ContainerMemoryNearLimit reads.
    // Not the Node heap: prom-client exports no heap LIMIT, so there would be no
    // denominator, and the heap is not what the kernel kills for anyway.
    expect(appsJob).toContain('container_memory_working_set_bytes');
    expect(appsJob).toContain('container_spec_memory_limit_bytes');
  });

  it('uses a ports-only egress rule, never an ipBlock', () => {
    // The mesh components are pod IPs in istio-system — RFC1918 on a VPC CNI —
    // so the shared public-egress ipBlock (RFC1918 excepted) would cut exactly
    // them off. Ports-only is what bounds this rule.
    const policy = netpol
      .slice(netpol.indexOf('allow-prometheus-mesh-scrape'))
      .split('---')[0];
    expect(policy).not.toContain('ipBlock');
    expect(policy).not.toContain('169.254');
  });
});

/**
 * The alert-rules file itself, as a COPY-SET.
 *
 * Every other test here asserts that each target CONTAINS a given rule, which cannot catch
 * the thing that actually happens: a rule added to two targets out of three. Nothing was
 * comparing the files, so the three Kubernetes copies could drift apart silently and the
 * first symptom would be an alert that never fires on one environment — the failure mode
 * an alert exists to prevent.
 *
 * The three k8s targets are byte-identical and must stay so. Docker is deliberately NOT in
 * that set: it runs no service mesh, so it ships everything EXCEPT the two Istio alerts.
 * Stating the difference as an exact list is what makes it a contract rather than a
 * tolerance — a third divergence has to be justified here, in writing.
 */
describe('alert-rules.yml is one file, copied', () => {
  const MESH_ONLY = ['MeshMTLSDegraded', 'IstiodDown'];
  /**
   * PersistentVolume capacity comes from the kubelet (kubelet_volume_stats_*),
   * which the docker target has no equivalent of — it is compose, not Kubernetes,
   * and its volumes are host bind mounts. Shipping these there would be three
   * rules that can never fire.
   *
   * They are NOT inert only on docker: ec2 and minikube bind MANUAL hostPath PVs
   * (storageClassName: ""), and the kubelet emits no volume stats for those, so
   * the rules have data on eks alone. They still ship to all three k8s targets
   * because this file is one copy-set — and because the moment a target moves to
   * a real CSI driver the rules are already there.
   */
  const KUBELET_ONLY = [
    'PersistentVolumeFillingUp', 'PersistentVolumeCriticallyFull', 'PersistentVolumeFillingUpFast',
    // Inodes are a second, independent way to run out of room: the same kubelet
    // volume series, so the same exclusion.
    'PersistentVolumeInodesFillingUp',
    // Absolute size for the pb-efs claims, which no percentage rule can cover
    // because EFS reports an unbounded capacity. Same series, same exclusion.
    'PersistentVolumeEfsOversized',
    // Node disk, from cAdvisor on the same kubelet. Docker has neither.
    'NodeDiskFillingUp', 'NodeDiskCriticallyFull', 'NodeDiskInodesFillingUp',
    // Container CPU/memory saturation, from the scoped `kubelet-cadvisor-db`
    // job. Docker's prometheus.yml has NO cadvisor reference at all — compose
    // containers expose no such series — so these three would match nothing
    // there, which is the failure mode indistinguishable from a healthy
    // database. The REPLICATION alerts are not in this list on purpose: they
    // come from the postgres-exporter custom query file, which docker mounts
    // too, so they work there.
    'PostgresPrimaryCpuSaturated', 'PostgresPrimaryMemoryPressure', 'PostgresReadReplicaSaturated',
    // The scale-DOWN signals, same cAdvisor basis and therefore same exclusion.
    'PostgresPrimaryUnderutilised', 'PostgresReadReplicaUnderutilised',
    // CPU throttling (kubelet-cadvisor-apps) and node CPU (kubelet-cadvisor-node).
    // Both are cAdvisor, which docker has no equivalent of.
    'ContainerCpuThrottling', 'NodeCpuSaturated',
    // Memory, from the same two jobs. ContainerMemoryNearLimit is the cgroup
    // figure on purpose — it is the only one that counts every tenant of the
    // limit, including the Chromium that renders PDFs inside `reporting`.
    'ContainerMemoryNearLimit', 'NodeMemorySaturated',
  ];
  /**
   * Scheduled-job health comes from kube-state-metrics, which translates API
   * objects into metrics. The docker target is compose: it has no Kubernetes
   * API, no CronJobs, and no kube-state-metrics to read them, so these two
   * would be rules that can never fire.
   *
   * They DO ship to all three k8s targets even though only eks and ec2 deploy
   * kube-state-metrics (minikube does not, matching pushgateway) — same reason
   * as KUBELET_ONLY: the file is one copy-set, and the rules are already in
   * place the moment a target gains the exporter.
   */
  const KUBE_STATE_ONLY = [
    'CronJobRunFailed', 'CronJobNotScheduled',
    // An unbound claim is an API-object state, not a volume metric — there is no
    // volume yet to collect stats from, which is exactly why kube-state-metrics
    // is the only place this can come from.
    'PersistentVolumeClaimPending',
    // Autoscaler health and pod lifecycle: all four are API-object state with no
    // /metrics equivalent. HpaScalingDisabled doubles as the metrics-server
    // monitor, since kube-system is scraped by nothing here.
    'HpaScalingDisabled', 'HpaAtMaxReplicas', 'PodNotScheduled', 'ContainerRestartLooping',
    // An OOMKill is reported as a container's last_terminated_reason — an
    // API-object field. The kubelet exposes no metric for it.
    'ContainerOOMKilled',
  ];
  /**
   * Alerts that need the POD-LABEL relabelling the `kubernetes-pods` scrape job
   * does. docker scrapes its exporters through static configs with no
   * relabelling, so its series carry `job`/`instance` and no `service` label —
   * there is nothing for `service="postgres-replica"` to match. It also runs a
   * single postgres-exporter, pointed at the primary, so its standby is
   * observed from the PRIMARY's side instead (PostgresReplicationStopped,
   * which docker does carry).
   */
  const POD_LABEL_ONLY = ['PostgresReplicaUnreachable'];
  /**
   * Alerts needing the pgbouncer-exporter sidecar, which docker does not run at
   * all — a pre-existing gap on that target, not one read-splitting introduced.
   * Their metric names were verified by running the pinned exporter image
   * against a real pgbouncer; `cl_waiting` is a SHOW POOLS column, not a metric
   * name, and the exporter renames it to client_waiting_connections.
   */
  const PGBOUNCER_EXPORTER_ONLY = ['PostgresReadPoolQueuing', 'PostgresReadPoolExhausted'];
  /**
   * The rung CONTROLLER's own health. The ladder patches pod resources through
   * the Kubernetes API as the platform pod's ServiceAccount, so on docker there
   * is no API server to patch and `POSTGRES_RUNG_ENABLED` ships false — the
   * controller only ever answers "not running in a Kubernetes pod". Its metrics
   * are therefore never emitted there, and a rule with no series is
   * indistinguishable from health, which is the thing this split exists to
   * avoid. docker also carries none of the saturation rules that drive the
   * ladder (they need cAdvisor), so alerting on the controller alone would be
   * the only half of the loop present.
   */
  const RUNG_CONTROLLER_ONLY = ['PostgresRungAtCeiling', 'PostgresRungBlockedByReplicaCeiling', 'PostgresRungError'];
  const alertNames = (text: string) =>
    [...text.matchAll(/^ {6}- alert: (\w+)$/gm)].map((m) => m[1]);

  it('is byte-identical across the three Kubernetes targets', () => {
    const [first, ...rest] = K8S_TARGETS.map((t) => read(`${t}/config/prometheus/alert-rules.yml`));
    for (const other of rest) expect(other).toBe(first);
  });

  it('gives docker every rule except the ones needing a mesh or a kubelet', () => {
    const k8s = alertNames(read(`${K8S_TARGETS[0]}/config/prometheus/alert-rules.yml`));
    const docker = alertNames(read('deploy/local/docker/config/prometheus/alert-rules.yml'));
    // Docker has no istiod and no sidecars, so those two rules would alert forever;
    // no kubelet, so the PersistentVolume rules would have no series at all;
    // and no Kubernetes API, so the CronJob rules have nothing to read.
    expect(k8s.filter((a) => !docker.includes(a)).sort()).toEqual([...MESH_ONLY, ...KUBELET_ONLY, ...KUBE_STATE_ONLY, ...POD_LABEL_ONLY, ...PGBOUNCER_EXPORTER_ONLY, ...RUNG_CONTROLLER_ONLY].sort());
    // Nothing the other way round: a rule must never exist ONLY on the dev stack.
    expect(docker.filter((a) => !k8s.includes(a))).toEqual([]);
  });

  it('names every alert exactly once per file, so one cannot shadow another', () => {
    for (const target of [...K8S_TARGETS, 'deploy/local/docker']) {
      const names = alertNames(read(`${target}/config/prometheus/alert-rules.yml`));
      expect(names.length).toBe(new Set(names).size);
    }
  });
});

/**
 * Plugin-ecosystem operations (docs/runbooks/ecosystem-moderation.md): the alert
 * rules and the "Plugin ecosystem" Grafana dashboard ship on EVERY target —
 * the docker compose stack included — and the dashboard is one file copied
 * byte-for-byte, so a panel fixed on one target can't silently drift.
 */
describe('plugin ecosystem operations', () => {
  const ALL_TARGETS = [...K8S_TARGETS, 'deploy/local/docker'];
  const dashboardPath = (target: string) => (target === 'deploy/local/docker'
    ? `${target}/config/grafana/provisioning/dashboards`
    : `${target}/config/grafana/dashboards`);

  it.each(ALL_TARGETS)('%s alerts on SLA breaches (incl. the 4h security lane), re-sign failures and approver shortage', (target) => {
    const rules = read(`${target}/config/prometheus/alert-rules.yml`);
    for (const alert of ['EcosystemSecurityLaneSLABreach', 'EcosystemStandardLaneSLABreach', 'EcosystemResignFailures', 'EcosystemResignStalled', 'EcosystemApproverShortage']) {
      expect(rules).toContain(`alert: ${alert}`);
    }
    const security = rules.slice(rules.indexOf('alert: EcosystemSecurityLaneSLABreach'));
    expect(security).toContain('ecosystem_requests_sla_breached{lane="security"}');
    expect(security.slice(0, security.indexOf('- alert:', 10))).toContain('severity: critical');
  });

  it('ships one identical dashboard and provider on every target', () => {
    const [first, ...rest] = ALL_TARGETS.map((t) => read(`${dashboardPath(t)}/plugin-ecosystem.json`));
    for (const other of rest) expect(other).toBe(first);
    const dashboard = JSON.parse(first!) as { uid: string; title: string; panels: Array<{ targets?: Array<{ expr: string }> }> };
    expect(dashboard).toMatchObject({ uid: 'plugin-ecosystem', title: 'Plugin ecosystem' });
    const exprs = dashboard.panels.flatMap((p) => p.targets ?? []).map((t) => t.expr).join('\n');
    for (const metric of ['ecosystem_requests_pending', 'ecosystem_requests_oldest_pending_age_seconds', 'ecosystem_decisions_total', 'ecosystem_auto_approvals_total', 'ecosystem_resign_images_total', 'ecosystem_notifications_total']) {
      expect(exprs).toContain(metric);
    }
    for (const t of ALL_TARGETS) expect(read(`${dashboardPath(t)}/dashboards.yaml`)).toContain('path: /etc/grafana/provisioning/dashboards');
  });

  it.each(K8S_TARGETS)('%s mounts the grafana-dashboards ConfigMap its setup script creates', (target) => {
    const grafana = read(`${target}/k8s/grafana.yaml`);
    expect(grafana).toContain('mountPath: /etc/grafana/provisioning/dashboards');
    expect(grafana).toContain('name: grafana-dashboards');
    const setup = read('deploy/bin/k8s-resources.sh');
    expect(setup).toMatch(/configmap\s+grafana-dashboards/);
    expect(setup).toContain('grafana/dashboards/plugin-ecosystem.json');
  });

  it('compose mounts the provisioning directory the dashboards live in', () => {
    expect(read('deploy/local/docker/docker-compose.yml')).toContain('./config/grafana/provisioning:/etc/grafana/provisioning:ro');
  });
});

/**
 * The admin consoles on the AWS gateway are OFF unless the operator opts
 * in, and when on, every request passes platform's superadmin gate first. Each
 * property fails silently: a missing auth_request would publish a datastore to
 * the internet, and the only symptom would be that it works.
 */
describe.each(['deploy/aws/ec2', 'deploy/aws/eks'])('admin consoles on the AWS gateway — %s', (target) => {
  const nginx = read(`${target}/nginx/nginx.conf`);
  const enabled = read(`${target}/nginx/admin-uis.conf`);
  const disabled = read(`${target}/nginx/admin-uis-disabled.conf`);
  const CONSOLES = ['/pgadmin/', '/mongo-express/', '/grafana/', '/kiali/'];

  it('keeps no console route in nginx.conf itself — only the deploy-time include', () => {
    expect(nginx).toContain('include /etc/nginx/admin-uis.conf;');
    for (const c of CONSOLES) expect(nginx).not.toContain(`location ${c} {`);
  });

  it('gates every console behind the platform superadmin check and strips the token', () => {
    for (const c of CONSOLES) {
      const block = enabled.slice(enabled.indexOf(`location ${c} {`)).split('\n        }\n')[0];
      expect([c, block.includes('auth_request /_pb_admin_console_check;')]).toEqual([c, true]);
      expect([c, block.includes('proxy_set_header Cookie $pb_cookie_without_console;')]).toEqual([c, true]);
    }
    expect(enabled).toContain('internal;');
    expect(enabled).toContain(':3000/admin/console-check');
  });

  it('404s the consoles by default', () => {
    expect(disabled).toMatch(/location ~ \^\/\(pgadmin\|mongo-express\|grafana\|kiali\)/);
    expect(disabled).toContain('return 404;');
    expect(read(`${target}/.env.example`)).toMatch(/^ADMIN_UIS_ENABLED=false$/m);
    const res = read('deploy/bin/k8s-resources.sh');
    expect(res).toContain('"${ADMIN_UIS_ENABLED:-false}" = true');
    expect(res).toContain('admin-uis-disabled.conf');
  });

  // The client IP comes from real_ip, trusting only the load balancer.
  it('derives the client IP from X-Forwarded-For only behind the trusted proxy CIDRs, and overwrites it', () => {
    expect(nginx).toContain('include /etc/nginx/real-ip.conf;');
    expect(nginx).toContain('real_ip_header X-Forwarded-For;');
    expect(nginx).toContain('real_ip_recursive on;');
    expect(nginx).not.toContain('$proxy_add_x_forwarded_for');
    expect(enabled).not.toContain('$proxy_add_x_forwarded_for');
    expect(nginx).toContain('limit_req_zone $binary_remote_addr zone=public_submissions');
    expect(read(`${target}/.env.example`)).toMatch(/^TRUST_PROXY=1$/m);
  });
});

