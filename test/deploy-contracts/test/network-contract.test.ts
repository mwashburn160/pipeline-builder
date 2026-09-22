// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guard: the k8s network layers (NetworkPolicy + Istio AuthorizationPolicy)
 * admit the traffic the stack actually needs — and nothing it must not.
 *
 * Every property here fails SILENTLY when it regresses, which is why it is a
 * test and not a comment:
 *   - Alertmanager with no public egress: every Slack page is dropped at the CNI
 *     and Alertmanager logs a timeout nobody reads.
 *   - An exporter whose mesh ALLOW policy omits sa/prometheus (or whose pod no
 *     NetworkPolicy opens to prometheus on its metrics port): ServiceDown fires
 *     for a healthy datastore, or — worse — the scrape just never happens.
 *   - An observability backend with NO ALLOW policy: under ambient that is
 *     "any mesh identity may connect", so a plugin build pod could read every
 *     tenant's Loki stream.
 *   - A public-egress rule that excepts all of 169.254.0.0/16 breaks TLS under
 *     ambient; one that excepts nothing hands out IMDS credentials.
 *
 * The manifests are parsed from each target's kustomization `resources:` — the
 * same set `kubectl kustomize` renders (the jest run has no kubectl).
 */

import { describe, it, expect } from '@jest/globals';
import { parse, parseAllDocuments } from 'yaml';
import { K8S_TARGETS, read } from '../src/index.js';


const NS = 'pipeline-builder';
const principal = (sa: string) => `cluster.local/ns/${NS}/sa/${sa}`;

type Doc = Record<string, any>;
type Labels = Record<string, string>;

function loadTarget(target: string): Doc[] {
  const kz = parse(read(`${target}/k8s/kustomization.yaml`));
  const docs: Doc[] = [];
  for (const res of kz.resources as string[]) {
    if (!res.endsWith('.yaml')) continue;
    for (const d of parseAllDocuments(read(`${target}/k8s/${res}`))) {
      const j = d.toJSON();
      if (j && typeof j === 'object') docs.push(j);
    }
  }
  return docs;
}

/** k8s LabelSelector semantics (matchLabels AND matchExpressions). */
function selects(selector: Doc | undefined, labels: Labels): boolean {
  if (!selector) return true;
  for (const [k, v] of Object.entries(selector.matchLabels ?? {})) if (labels[k] !== v) return false;
  for (const e of selector.matchExpressions ?? []) {
    const has = Object.prototype.hasOwnProperty.call(labels, e.key);
    if (e.operator === 'In' && !(has && e.values.includes(labels[e.key]))) return false;
    if (e.operator === 'NotIn' && has && e.values.includes(labels[e.key])) return false;
    if (e.operator === 'Exists' && !has) return false;
    if (e.operator === 'DoesNotExist' && has) return false;
  }
  return true;
}

interface ScrapeTarget { app: string; labels: Labels; port: number; sa: string }

function scrapeTargets(docs: Doc[]): ScrapeTarget[] {
  const out: ScrapeTarget[] = [];
  for (const d of docs) {
    if (!['Deployment', 'StatefulSet', 'DaemonSet'].includes(d.kind)) continue;
    const tpl = d.spec?.template ?? {};
    const ann = tpl.metadata?.annotations ?? {};
    if (ann['prometheus.io/scrape'] !== 'true') continue;
    out.push({
      app: tpl.metadata.labels.app,
      labels: tpl.metadata.labels,
      port: Number(ann['prometheus.io/port']),
      sa: tpl.spec?.serviceAccountName ?? 'default',
    });
  }
  return out;
}

const allowPolicies = (docs: Doc[], labels: Labels) => docs.filter((d) =>
  d.kind === 'AuthorizationPolicy'
  && (d.spec?.action ?? 'ALLOW') === 'ALLOW'
  && d.spec?.selector && selects(d.spec.selector, labels));

/** Does some ALLOW rule admit `sa` on `port`? */
function meshAdmits(policies: Doc[], sa: string, port: number): boolean {
  return policies.some((p) => (p.spec.rules ?? []).some((r: Doc) => {
    const fromOk = !r.from || r.from.some((f: Doc) => (f.source?.principals ?? []).includes(principal(sa)));
    const toOk = !r.to || r.to.some((t: Doc) => !t.operation?.ports || t.operation.ports.includes(String(port)));
    return fromOk && toOk;
  }));
}

const netpols = (docs: Doc[]) => docs.filter((d) => d.kind === 'NetworkPolicy');

/** Does some Ingress NetworkPolicy selecting `dst` admit a pod labelled `src` on `port`? */
function netpolAdmits(docs: Doc[], dst: Labels, src: Labels, port: number): boolean {
  return netpols(docs).some((np) =>
    (np.spec.policyTypes ?? ['Ingress']).includes('Ingress')
    && selects(np.spec.podSelector, dst)
    && (np.spec.ingress ?? []).some((r: Doc) => {
      const fromOk = !r.from || r.from.some((f: Doc) => f.podSelector && !f.namespaceSelector && selects(f.podSelector, src));
      const portOk = !r.ports || r.ports.some((p: Doc) => Number(p.port) === port);
      return fromOk && portOk;
    }));
}

/** Every egress rule of every NetworkPolicy selecting `labels`. */
const egressRules = (docs: Doc[], labels: Labels): Doc[] => netpols(docs)
  .filter((np) => (np.spec.policyTypes ?? []).includes('Egress') && selects(np.spec.podSelector, labels))
  .flatMap((np) => np.spec.egress ?? []);

const publicEgressPorts = (docs: Doc[], labels: Labels): number[] => egressRules(docs, labels)
  .filter((r) => (r.to ?? []).some((t: Doc) => t.ipBlock?.cidr === '0.0.0.0/0'))
  .flatMap((r) => (r.ports ?? []).map((p: Doc) => Number(p.port)));

describe.each(K8S_TARGETS)('network contract — %s', (target) => {
  const docs = loadTarget(target);
  const targets = scrapeTargets(docs);
  const prom = { app: 'prometheus' };

  it('discovers the scrape-annotated workloads (guards an empty corpus)', () => {
    expect(targets.length).toBeGreaterThan(20);
    for (const app of ['postgres', 'pgbouncer', 'mongodb', 'minio', 'grafana', 'loki', 'alertmanager']) {
      expect(targets.map((t) => t.app)).toContain(app);
    }
  });

  it('lets prometheus through every scrape-annotated pod\'s mesh ALLOW policy, on the metrics port', () => {
    const blocked = targets.filter((t) => {
      const pols = allowPolicies(docs, t.labels);
      return pols.length > 0 && !meshAdmits(pols, 'prometheus', t.port);
    }).map((t) => `${t.app}:${t.port}`);
    expect(blocked).toEqual([]);
  });

  it('lets prometheus through the NetworkPolicy layer to every scrape-annotated pod', () => {
    const blocked = targets.filter((t) => !netpolAdmits(docs, t.labels, prom, t.port)).map((t) => `${t.app}:${t.port}`);
    expect(blocked).toEqual([]);
  });

  it('gives every observability backend an ALLOW policy (no "any mesh identity" default)', () => {
    for (const app of ['loki', 'prometheus', 'thanos-query', 'thanos-store-gateway', 'thanos-compact', 'alertmanager', 'jaeger']) {
      expect([app, allowPolicies(docs, { app }).length > 0]).toEqual([app, true]);
    }
  });

  it('admits the real observability callers', () => {
    const loki = allowPolicies(docs, { app: 'loki' });
    for (const sa of ['promtail', 'platform', 'grafana']) expect([sa, meshAdmits(loki, sa, 3100)]).toEqual([sa, true]);
    for (const src of ['promtail', 'platform', 'grafana']) expect(netpolAdmits(docs, { app: 'loki' }, { app: src }, 3100)).toBe(true);

    const tq = allowPolicies(docs, { app: 'thanos-query' });
    expect(meshAdmits(tq, 'platform', 9090) && meshAdmits(tq, 'grafana', 9090)).toBe(true);
    expect(netpolAdmits(docs, { app: 'thanos-query' }, { app: 'grafana' }, 9090)).toBe(true);

    const am = allowPolicies(docs, { app: 'alertmanager' });
    expect(meshAdmits(am, 'prometheus', 9093) && meshAdmits(am, 'platform', 9093)).toBe(true);

    const jaeger = allowPolicies(docs, { app: 'jaeger' });
    expect(meshAdmits(jaeger, 'platform', 4318) && meshAdmits(jaeger, 'grafana', 16686)).toBe(true);
    expect(netpolAdmits(docs, { app: 'jaeger' }, { app: 'grafana' }, 16686)).toBe(true);
  });

  it('lets platform write the signed audit chain heads to MinIO', () => {
    expect(meshAdmits(allowPolicies(docs, { app: 'minio' }), 'platform', 9000)).toBe(true);
    expect(netpolAdmits(docs, { app: 'minio' }, { app: 'platform' }, 9000)).toBe(true);
  });

  it('never lets tenant build code reach Loki', () => {
    const loki = allowPolicies(docs, { app: 'loki' });
    for (const sa of ['plugin', 'plugin-quarantine-builder', 'default']) {
      expect([sa, meshAdmits(loki, sa, 3100)]).toEqual([sa, false]);
      expect([sa, netpolAdmits(docs, { app: 'loki' }, { app: sa }, 3100)]).toEqual([sa, false]);
    }
  });

  it('gives Alertmanager public 443 egress so Slack notifications leave the cluster', () => {
    expect(netpols(docs).map((n) => n.metadata.name)).toContain('allow-alertmanager-external-egress');
    expect(publicEgressPorts(docs, { app: 'alertmanager' })).toContain(443);
  });

  it('opens the external legs each service needs', () => {
    expect(publicEgressPorts(docs, { app: 'pipeline' })).toContain(443);
    expect(publicEgressPorts(docs, { app: 'ask' })).toContain(443);
    expect(publicEgressPorts(docs, { app: 'compliance' })).toEqual(expect.arrayContaining([443, 587, 465, 25]));
    expect(publicEgressPorts(docs, { app: 'platform' })).toEqual(expect.arrayContaining([443, 587, 465, 25]));
  });

  it('hands the credential endpoint to exactly the pods that hold an AWS grant', () => {
    const cred = target.endsWith('eks') ? '169.254.170.23/32' : '169.254.169.254/32';
    const reaches = (app: string) => egressRules(docs, { app }).some((r) =>
      (r.to ?? []).some((t: Doc) => t.ipBlock?.cidr === cred) && (r.ports ?? []).some((p: Doc) => Number(p.port) === 80));
    for (const app of ['platform', 'pipeline']) expect([app, reaches(app)]).toEqual([app, true]);
    for (const app of ['plugin', 'plugin-quarantine-builder', 'ask', 'compliance', 'alertmanager', 'billing']) {
      expect([app, reaches(app)]).toEqual([app, false]);
    }
  });

  it('uses the one public-egress shape everywhere: credential addresses excepted, NOT all of link-local', () => {
    const blocks = netpols(docs).flatMap((np) => (np.spec.egress ?? [])
      .flatMap((r: Doc) => (r.to ?? []).map((t: Doc) => ({ name: np.metadata.name, ipBlock: t.ipBlock }))))
      .filter((b: Doc) => b.ipBlock?.cidr === '0.0.0.0/0');
    expect(blocks.length).toBeGreaterThanOrEqual(8);
    for (const b of blocks) {
      const except: string[] = b.ipBlock.except ?? [];
      expect([b.name, except.includes('169.254.0.0/16')]).toEqual([b.name, false]);
      expect([b.name, except.includes('169.254.169.254/32')]).toEqual([b.name, true]);
      expect([b.name, except.includes('169.254.170.0/24')]).toEqual([b.name, true]);
    }
  });
});

describe('network contract — eks backup + NetworkPolicy enforcement', () => {
  const docs = loadTarget('deploy/aws/eks');
  const backup = { app: 'db-backup' };

  it('lets the backup CronJob reach every datastore it dumps, and S3', () => {
    expect(netpolAdmits(docs, { app: 'postgres' }, backup, 5432)).toBe(true);
    expect(netpolAdmits(docs, { app: 'mongodb' }, backup, 27017)).toBe(true);
    expect(netpolAdmits(docs, { app: 'minio' }, backup, 9000)).toBe(true);
    expect(meshAdmits(allowPolicies(docs, { app: 'minio' }), 'db-backup', 9000)).toBe(true);
    expect(publicEgressPorts(docs, backup)).toContain(443);
  });

  it('mirrors every MinIO bucket the stack creates, including plugin-quarantine', () => {
    const cron = read('deploy/aws/eks/backup/backup-cronjob.yaml');
    const minio = read('deploy/aws/eks/k8s/minio.yaml');
    const created = [
      ...(/for b in ([a-z -]+); do mc mb/.exec(minio)![1].trim().split(/\s+/)),
      ...[...minio.matchAll(/mc mb --ignore-existing --with-lock local\/([a-z-]+)/g)].map((m) => m[1]),
    ];
    expect(created).toContain('audit-heads');
    const mirrored = /MINIO_BUCKETS:-([a-z -]+)\}/.exec(cron)![1].trim().split(/\s+/);
    expect(mirrored.sort()).toEqual(created.sort());
  });

  it('turns the VPC CNI network-policy controller on — Auto Mode ignores NetworkPolicy otherwise', () => {
    const setup = read('deploy/aws/eks/bin/setup.sh');
    expect(setup).toContain('amazon-vpc-cni');
    expect(setup).toContain('enable-network-policy-controller');
    const nodeclass = parseAllDocuments(read('deploy/aws/eks/cluster/nodeclass.yaml')).map((d) => d.toJSON());
    const nc = nodeclass.find((d: Doc) => d?.kind === 'NodeClass');
    expect(nc.spec.networkPolicy).toBe('DefaultAllow');
    expect(nc.spec.networkPolicyEventLogs).toBe('Enabled');
    // Both NodePools run on that NodeClass, not the EKS-managed `default`.
    const pools = parseAllDocuments(read('deploy/aws/eks/cluster/nodepool.yaml')).map((d) => d.toJSON()).filter((d: Doc) => d?.kind === 'NodePool');
    expect(pools.length).toBe(2);
    for (const p of pools) expect(p.spec.template.spec.nodeClassRef.name).toBe(nc.metadata.name);
  });

  it('probes that a denied connection is actually denied after the apply', () => {
    const setup = read('deploy/aws/eks/bin/setup.sh');
    expect(setup).toMatch(/pb_probe_denied_connection|post-provision-smoke\.sh/);
    expect(read('deploy/bin/post-provision-smoke.sh')).toContain('pb_probe_denied_connection');
  });
});
