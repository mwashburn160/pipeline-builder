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
