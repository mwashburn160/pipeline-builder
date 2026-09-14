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

import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(process.cwd(), '..');

/** Every target that runs Prometheus against an Istio ambient mesh. */
const K8S_TARGETS = ['deploy/local/minikube', 'deploy/aws/ec2', 'deploy/aws/eks'];

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf-8');

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
      'promtail.yaml': '9080',
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
    expect(rules).toContain('expr: pg_up == 0');
    expect(rules).toContain('expr: mongodb_up == 0');
    expect(rules).toContain('expr: redis_up == 0');
  });

  it('ships Grafana and Kiali as LEAN-droppable admin UIs', () => {
    for (const file of ['grafana.yaml', 'kiali.yaml']) {
      expect(() => read(`${target}/k8s/${file}`)).not.toThrow();
    }
    // Both must be registered, or the manifests are dead files.
    const kustomization = read(`${target}/k8s/kustomization.yaml`);
    expect(kustomization).toContain('grafana.yaml');
    expect(kustomization).toContain('kiali.yaml');
    // Reached through nginx on a subpath, like pgAdmin.
    const nginx = read(`${target}/nginx/nginx.conf`);
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

  it('uses a ports-only egress rule, never an ipBlock', () => {
    // Under ambient, outbound is redirected to the node-local ztunnel over a
    // link-local address. A `to:` ipBlock that excepts 169.254.0.0/16 severs
    // the data path while still completing the TCP handshake — the scrape then
    // hangs rather than failing. Ports-only is the shape proven to work here.
    const policy = netpol
      .slice(netpol.indexOf('allow-prometheus-mesh-scrape'))
      .split('---')[0];
    expect(policy).not.toContain('ipBlock');
    expect(policy).not.toContain('169.254');
  });
});
