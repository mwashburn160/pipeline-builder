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

  /**
   * The object store is deliberately ABSENT from this list.
   *
   * RustFS serves no Prometheus endpoint. Verified against the pinned image
   * (`rustfs/rustfs:1.0.0`): `/minio/v2/metrics/cluster`, `/minio/v2/metrics/node`,
   * `/metrics` and `/rustfs/metrics` all answer 403 with S3 `AccessDenied` XML — the
   * generic S3 handler refusing a path it does not special-case — on both :9000 and
   * :9001, and neither `RUSTFS_PROMETHEUS_AUTH_TYPE=public` nor MinIO's
   * `MINIO_PROMETHEUS_AUTH_TYPE=public` changes that. The health paths it DOES inherit
   * from MinIO (`/minio/health/live`, `/minio/health/ready`) still answer 200, which is
   * what the probes use.
   *
   * The reason is architectural rather than a missing flag: RustFS exports observability
   * by OTLP PUSH (`RUSTFS_OBS_ENDPOINT`, `RUSTFS_OBS_METRIC_ENDPOINT`,
   * `RUSTFS_OBS_METRICS_EXPORT_ENABLED`, `RUSTFS_OBS_METER_INTERVAL` — the image ships
   * defaults for them), so annotation-based pull cannot reach it at any path.
   *
   * ANNOTATING IT ANYWAY WOULD BREAK ALERTING. `ServiceDown` is
   * `up{job="kubernetes-pods"} == 0` at severity critical, so a pod annotated
   * `prometheus.io/scrape: "true"` whose endpoint 403s pages forever. That is not
   * hypothetical: the MinIO manifest this replaced carried a comment recording exactly
   * that incident ("every scrape was a 403 and ServiceDown fired for a healthy MinIO"),
   * which MinIO could fix with a flag and RustFS cannot.
   *
   * Nothing consumed the old scrape — no alert rule, scrape job or dashboard in any
   * target references `minio_*` or `rustfs_*`. Re-adding object-store metrics means an
   * OTLP collector receiving `RUSTFS_OBS_METRIC_ENDPOINT` and re-exposing to Prometheus;
   * that is a new component, not a change to this list.
   *
   * The manifests say the same thing at the point of the decision — see the header of
   * each target's `k8s/rustfs.yaml`. This list was the only place still expecting the
   * annotation the migration had deliberately dropped.
   */
  it('discovers the scrape-annotated workloads (guards an empty corpus)', () => {
    expect(targets.length).toBeGreaterThan(20);
    for (const app of ['postgres', 'pgbouncer', 'mongodb', 'grafana', 'loki', 'alertmanager']) {
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

  it('lets platform write the signed audit chain heads to the object store', () => {
    expect(meshAdmits(allowPolicies(docs, { app: 'rustfs' }), 'platform', 9000)).toBe(true);
    expect(netpolAdmits(docs, { app: 'rustfs' }, { app: 'platform' }, 9000)).toBe(true);
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

  /**
   * eks excepts the cluster's REAL VPC CIDR, not just the RFC1918 constants.
   *
   * The constants alone assume the VPC sits in private space. It need not: eksctl's
   * default is 192.168.0.0/16, a BYO VPC can be anything, and AWS permits
   * publicly-routable VPC CIDRs — where the constants except nothing that matters and
   * platform's user-supplied-URL fetches (per-org alert webhooks, OIDC discovery, SAML
   * metadata) can reach in-VPC services. `${VPC_CIDR}` is substituted at apply time
   * from `aws ec2 describe-vpcs`; see the PB_VPC_CIDR block in bin/setup.sh.
   *
   * Two ways this regresses silently, so both are asserted: a new egress rule copied
   * from an older one arrives without the token, and the token stops being substituted
   * (renamed in setup.sh's sed list) — which ships `${VPC_CIDR}` to the API server as a
   * literal and is rejected as an invalid CIDR, but only at apply time.
   */
  if (target === 'deploy/aws/eks') {
    it('excepts the discovered VPC CIDR from every public-egress rule', () => {
      const missing = netpols(docs).flatMap((np) => (np.spec.egress ?? [])
        .flatMap((r: Doc) => (r.to ?? [])
          .filter((t: Doc) => t.ipBlock?.cidr === '0.0.0.0/0' && !(t.ipBlock.except ?? []).includes('${VPC_CIDR}'))
          .map(() => np.metadata.name)));
      expect({
        missing,
        fix: 'Add `- ${VPC_CIDR}` to this rule\'s `except` list — see EGRESS SHAPE in '
          + 'networkpolicy.yaml. Without it the rule excepts only the RFC1918 constants, '
          + 'which is a hole whenever the VPC is not inside them.',
      }).toEqual({ missing: [], fix: expect.any(String) });
    });

    it('substitutes that token at apply time', () => {
      // The sed list in the pb_apply_manifests call is the only thing that replaces it.
      expect(read('deploy/aws/eks/bin/setup.sh')).toContain('s|[\\$]{VPC_CIDR}|${PB_VPC_CIDR}|g');
    });
  }

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

  /**
   * Every probed workload whose ALLOW policy would otherwise reject its own kubelet
   * probe carries the `notPrincipals: ["*"]` carve-out described under "KUBELET PROBE
   * CARVE-OUTS" in each target's `k8s/istio.yaml`.
   *
   * WITHOUT ONE THE POD NEVER GOES READY. ALLOW is default-deny once a policy selects
   * the workload, so a probe that reaches ztunnel with no mesh identity matches no rule
   * and is reset; kubelet reads that as a connect timeout and the pod walks
   * Unhealthy -> Killing -> BackOff. It is invisible at review time — the policy looks
   * complete, because every rule in it is about real in-mesh callers.
   *
   * Scoped to the probe PORT, not the workload: a carve-out on some other port leaves
   * the probe rejected, which is the drift this would otherwise miss.
   *
   * A new service lands with a probe and an ALLOW policy and no carve-out, and this
   * fails. The inverse — a carve-out on a port nothing probes — is checked too, because
   * these rules admit any non-mesh client on the port they name, so one that has
   * outlived its probe is pure exposure.
   */
  describe('kubelet probes are admitted by the policy that selects their workload', () => {
    /** Probe ports per app, from httpGet/tcpSocket (exec probes never touch the network). */
    const probed = new Map<string, { labels: Labels; ports: Set<string> }>();
    for (const d of docs) {
      if (!['Deployment', 'StatefulSet', 'DaemonSet'].includes(d.kind)) continue;
      const tpl = d.spec?.template;
      const app = tpl?.metadata?.labels?.app;
      if (!app) continue;
      for (const c of tpl.spec?.containers ?? []) {
        for (const k of ['livenessProbe', 'readinessProbe', 'startupProbe']) {
          const port = c[k]?.httpGet?.port ?? c[k]?.tcpSocket?.port;
          if (port === undefined) continue;
          const e = probed.get(app) ?? { labels: tpl.metadata.labels, ports: new Set<string>() };
          e.ports.add(String(port));
          probed.set(app, e);
        }
      }
    }

    /** Ports some ALLOW policy selecting `labels` admits from a source with no identity. */
    const anonPorts = (labels: Labels): Set<string> => new Set(
      allowPolicies(docs, labels).flatMap((p) => (p.spec.rules ?? [])
        .filter((r: Doc) => (r.from ?? []).some((fr: Doc) => fr.source?.notPrincipals))
        .flatMap((r: Doc) => (r.to ?? []).flatMap((t: Doc) => t.operation?.ports ?? []))
        .map(String)));

    it('finds the probed workloads and their policies (guards an empty corpus)', () => {
      // A selector or probe-shape rename that matched nothing would make the two
      // assertions below vacuously true.
      expect(probed.size).toBeGreaterThan(20);
      for (const app of ['platform', 'jaeger', 'registry', 'loki', 'grafana', 'kiali']) {
        expect([app, probed.has(app)]).toEqual([app, true]);
        expect([app, allowPolicies(docs, probed.get(app)!.labels).length > 0]).toEqual([app, true]);
      }
    });

    it('admits every probe port of every workload an ALLOW policy selects', () => {
      const rejected: string[] = [];
      for (const [app, { labels, ports }] of probed) {
        if (!allowPolicies(docs, labels).length) continue; // unselected: ambient admits it
        const anon = anonPorts(labels);
        for (const p of ports) if (!anon.has(p)) rejected.push(`${app}:${p}`);
      }
      expect({
        rejected,
        fix: 'Add a `notPrincipals: ["*"]` rule on this port to the policy selecting the '
          + 'workload — see "KUBELET PROBE CARVE-OUTS" in the target\'s k8s/istio.yaml. '
          + 'Without it the pod never passes its probe and CrashLoops with a connect timeout.',
      }).toEqual({ rejected: [], fix: expect.any(String) });
    });

    it('carries no carve-out for a port nothing probes', () => {
      // Each of these admits ANY non-mesh client on the port it names, so one left
      // behind after a probe moved is exposure with nothing asking for it.
      const stale: string[] = [];
      for (const [app, { labels, ports }] of probed) {
        for (const p of anonPorts(labels)) {
          // prometheus:9090 is the KEDA metrics-adapter carve-out, not a probe.
          if (app === 'prometheus' && p === '9090') continue;
          if (!ports.has(p)) stale.push(`${app}:${p}`);
        }
      }
      expect(stale).toEqual([]);
    });
  });
});

describe('network contract — eks backup + NetworkPolicy enforcement', () => {
  const docs = loadTarget('deploy/aws/eks');
  const backup = { app: 'db-backup' };

  it('lets the backup CronJob reach every datastore it dumps, and S3', () => {
    expect(netpolAdmits(docs, { app: 'postgres' }, backup, 5432)).toBe(true);
    expect(netpolAdmits(docs, { app: 'mongodb' }, backup, 27017)).toBe(true);
    expect(netpolAdmits(docs, { app: 'rustfs' }, backup, 9000)).toBe(true);
    expect(meshAdmits(allowPolicies(docs, { app: 'rustfs' }), 'db-backup', 9000)).toBe(true);
    expect(publicEgressPorts(docs, backup)).toContain(443);
  });

  it('mirrors every object-store bucket the stack creates, including plugin-quarantine', () => {
    const cron = read('deploy/aws/eks/backup/backup-cronjob.yaml');
    const objectStore = read('deploy/aws/eks/k8s/rustfs.yaml');
    const created = [
      ...(/for b in ([a-z -]+); do rc bucket create/.exec(objectStore)![1].trim().split(/\s+/)),
      ...[...objectStore.matchAll(/rc bucket create --ignore-existing --with-lock local\/([a-z-]+)/g)].map((m) => m[1]),
    ];
    expect(created).toContain('audit-heads');
    const mirrored = /OBJECTSTORE_BUCKETS:-([a-z -]+)\}/.exec(cron)![1].trim().split(/\s+/);
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
