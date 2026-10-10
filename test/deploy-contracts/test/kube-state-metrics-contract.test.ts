// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * kube-state-metrics: the only thing that can see a CronJob's outcome.
 *
 * A CronJob's result lives in the API server, not in any pod's /metrics, so
 * without this exporter `db-backup` failing and `ask-model-up` never
 * provisioning a GPU node are both invisible — the second one especially,
 * because its image is distroless kubectl with no shell to curl Alertmanager
 * from. Everything below guards a way that coverage goes quietly missing:
 *
 *   - A TRIMMED `--resources` LIST. kube-state-metrics only exports families
 *     for resources it was told to watch. Drop `jobs` and CronJobRunFailed has
 *     no series to match: the alert never fires and the dashboard is blank,
 *     with nothing anywhere saying why. This is the single most important
 *     assertion in the file.
 *   - RBAC AND `--resources` DRIFTING APART. A resource in the list but not in
 *     the Role logs `failed to list` on every resync and the family is absent —
 *     the same silent hole, reached from the other direction.
 *   - A ClusterRole CREEPING BACK. Upstream ships one, cluster-wide, over ~20
 *     kinds. Here the watch is namespace-scoped so a namespaced Role is
 *     enough, and a cluster-wide read of every object kind is one of the
 *     broadest grants there is.
 *   - SECRETS OR CONFIGMAPS BEING GRANTED. kube-state-metrics does not export
 *     their values, but it does export their names and metadata — and Grafana
 *     here applies no org scoping, so that would publish the shape of every
 *     tenant's configuration to anyone who reaches a dashboard.
 */

import { describe, it, expect } from '@jest/globals';
import { parseAllDocuments } from 'yaml';
import { read } from '../src/index.js';

type Doc = Record<string, any>;

const TARGETS = ['deploy/aws/eks', 'deploy/aws/ec2'] as const;
const NS = 'pipeline-builder';

const docsOf = (target: string): Doc[] =>
  parseAllDocuments(read(`${target}/k8s/kube-state-metrics.yaml`)).map((d) => d.toJSON() as Doc).filter(Boolean);

/** The `--resources=a,b,c` argument, split. */
function declaredResources(docs: Doc[]): string[] {
  const dep = docs.find((d) => d.kind === 'Deployment')!;
  const arg = (dep.spec.template.spec.containers[0].args as string[]).find((a) => a.startsWith('--resources='))!;
  return arg.slice('--resources='.length).split(',').map((r) => r.trim()).filter(Boolean);
}

/** Every resource the Role actually permits listing. */
function permittedResources(docs: Doc[]): string[] {
  const role = docs.find((d) => d.kind === 'Role')!;
  return (role.rules as Doc[]).flatMap((r) => r.resources as string[]);
}

describe.each(TARGETS)('%s — kube-state-metrics', (target) => {
  const docs = docsOf(target);

  it('ships the five documents it needs (guards a vacuous pass)', () => {
    expect(docs.map((d) => d.kind).sort()).toEqual(['Deployment', 'Role', 'RoleBinding', 'Service', 'ServiceAccount']);
  });

  it('is applied by the target (listed in the kustomization)', () => {
    expect(read(`${target}/k8s/kustomization.yaml`)).toContain('kube-state-metrics.yaml');
  });

  it('reads ONE namespace with a namespaced Role, never a ClusterRole', () => {
    // The namespace flag is what makes the namespaced Role sufficient; without
    // it kube-state-metrics watches cluster-wide and every list fails.
    const dep = docs.find((d) => d.kind === 'Deployment')!;
    expect(dep.spec.template.spec.containers[0].args).toContain(`--namespaces=${NS}`);
    expect(docs.map((d) => d.kind)).not.toContain('ClusterRole');
    expect(docs.map((d) => d.kind)).not.toContain('ClusterRoleBinding');
    expect(docs.find((d) => d.kind === 'Role')!.metadata.namespace).toBe(NS);
  });

  it('keeps `--resources` and the Role in exact lockstep', () => {
    // Either direction is a silent hole: a resource watched without permission
    // logs `failed to list` forever, and one permitted but unwatched is a grant
    // with no purpose.
    expect([...declaredResources(docs)].sort()).toEqual([...permittedResources(docs)].sort());
  });

  it('is granted list/watch only — it must never write', () => {
    for (const rule of docs.find((d) => d.kind === 'Role')!.rules as Doc[]) {
      expect([...(rule.verbs as string[])].sort()).toEqual(['list', 'watch']);
    }
  });

  it('is never granted secrets or configmaps', () => {
    const permitted = permittedResources(docs);
    expect(permitted).not.toContain('secrets');
    expect(permitted).not.toContain('configmaps');
    // And it must not be asking for them either — kube-state-metrics would
    // only log an error, but the intent would already be wrong.
    expect(declaredResources(docs)).not.toContain('secrets');
    expect(declaredResources(docs)).not.toContain('configmaps');
  });

  it('asks for no cluster-scoped resource, which the Role could not grant', () => {
    // nodes/persistentvolumes/namespaces/storageclasses are cluster-scoped: a
    // namespaced Role cannot cover them, so listing one here would produce a
    // permission error on every resync.
    for (const r of ['nodes', 'persistentvolumes', 'namespaces', 'storageclasses', 'clusterroles', 'volumeattachments']) {
      expect([r, declaredResources(docs).includes(r)]).toEqual([r, false]);
    }
  });

  it('carries the token it needs — unlike the other observability pods', () => {
    const pod = docs.find((d) => d.kind === 'Deployment')!.spec.template.spec;
    // pushgateway sets this false; here the entire job is reading the API.
    expect(pod.automountServiceAccountToken).toBe(true);
    expect(pod.serviceAccountName).toBe('kube-state-metrics');
  });

  it('is scraped on the object-state port, not its own telemetry port', () => {
    const tpl = docs.find((d) => d.kind === 'Deployment')!.spec.template;
    expect(tpl.metadata.annotations['prometheus.io/scrape']).toBe('true');
    // 8081 is the exporter's own process metrics; the cluster-object families
    // the alerts read are on 8080.
    expect(tpl.metadata.annotations['prometheus.io/port']).toBe('8080');
  });

  it('runs unprivileged, read-only, on a digest-pinned image', () => {
    const dep = docs.find((d) => d.kind === 'Deployment')!;
    const pod = dep.spec.template.spec;
    expect(pod.securityContext.runAsNonRoot).toBe(true);
    const c = pod.containers[0];
    expect(c.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(c.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(c.securityContext.capabilities.drop).toEqual(['ALL']);
    expect(c.image).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it('is reachable by prometheus and nothing else, at both layers', () => {
    const netpols = parseAllDocuments(read(`${target}/k8s/networkpolicy.yaml`)).map((d) => d.toJSON() as Doc).filter(Boolean);
    const ingress = netpols.find((d) => d.metadata?.name === 'allow-kube-state-metrics-ingress')!;
    expect(ingress.spec.podSelector.matchLabels.app).toBe('kube-state-metrics');
    expect(ingress.spec.ingress[0].from).toEqual([{ podSelector: { matchLabels: { app: 'prometheus' } } }]);

    // Under ambient an ALLOW policy is also required — its ABSENCE means "any
    // mesh identity may connect", which for a full object listing of the
    // namespace is the wrong default.
    const mesh = parseAllDocuments(read(`${target}/k8s/istio.yaml`)).map((d) => d.toJSON() as Doc).filter(Boolean);
    const allow = mesh.find((d) => d.metadata?.name === 'kube-state-metrics-allow')!;
    expect(allow.spec.action).toBe('ALLOW');
    expect(allow.spec.rules[0].from[0].source.principals).toEqual([`cluster.local/ns/${NS}/sa/prometheus`]);
    expect(allow.spec.rules[0].to[0].operation.ports).toEqual(['8080']);
  });

  it('is granted the API-server egress its watch depends on', () => {
    const netpols = parseAllDocuments(read(`${target}/k8s/networkpolicy.yaml`)).map((d) => d.toJSON() as Doc).filter(Boolean);
    const egress = netpols.find((d) => d.metadata?.name === 'allow-kube-api-egress')!;
    const values = egress.spec.podSelector.matchExpressions[0].values as string[];
    // Without this the pod starts, lists nothing, and every family is absent.
    expect(values).toContain('kube-state-metrics');
  });
});

describe('kube-state-metrics — the two standalone copies do not drift', () => {
  it('renders identical documents in eks and ec2', () => {
    // Nothing about this exporter differs per target, so unlike the ask-model
    // schedule the whole file is expected to match, prose included.
    expect(read('deploy/aws/ec2/k8s/kube-state-metrics.yaml')).toBe(read('deploy/aws/eks/k8s/kube-state-metrics.yaml'));
  });
});

describe('the CronJob alerts can actually fire', () => {
  /**
   * The failure this prevents: an alert on `kube_cronjob_*` while
   * `--resources` no longer lists `cronjobs`. Prometheus accepts the rule,
   * promtool accepts the rule, the expression simply never matches a series —
   * and a silent alert is worse than no alert, because it reads as coverage.
   */
  const rules = read('deploy/aws/eks/config/prometheus/alert-rules.yml');

  it('includes both rules, exactly once', () => {
    for (const name of ['CronJobRunFailed', 'CronJobNotScheduled']) {
      expect([name, (rules.match(new RegExp(`- alert: ${name}$`, 'gm')) ?? []).length]).toEqual([name, 1]);
    }
  });

  it('reads only metric families kube-state-metrics is configured to export', () => {
    const declared = declaredResources(docsOf('deploy/aws/eks'));
    // Every `kube_<thing>_...` the rules reference, mapped back to the
    // `--resources` entry that produces it (`kube_cronjob_*` <- `cronjobs`).
    const used = new Set([...rules.matchAll(/\bkube_([a-z]+)_[a-z_]+/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(0); // guards a vacuous pass
    const missing = [...used].filter((singular) => !declared.includes(`${singular}s`));
    expect({
      missing,
      fix: 'These alert rules read a kube-state-metrics family whose resource is not in '
        + '--resources, so the series never exists and the alert can never fire. Add the '
        + 'resource to BOTH --resources and the Role, or drop the rule.',
    }).toEqual({ missing: [], fix: expect.any(String) });
  });

  it('never pages for a deliberately suspended CronJob', () => {
    // `ASK_SCHEDULE_ENABLED=false` applies both ask-model scalers suspended.
    // A rule that fired on that would be paging for a supported configuration,
    // which is how an alert gets permanently muted.
    const block = rules.slice(rules.indexOf('- alert: CronJobNotScheduled'));
    expect(block.slice(0, block.indexOf('- alert: ', 10))).toContain('kube_cronjob_spec_suspend');
  });
});
