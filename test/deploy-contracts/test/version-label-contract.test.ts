// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every workload declares its image version and its rollout track.
 *
 * Two labels doing two different jobs, and the split is the point:
 *
 *   `version` changes every release. It is what Istio reads for canonical
 *     revision (via `service.istio.io/canonical-revision`, falling back to
 *     this label, else the literal string "latest"), so it is what makes
 *     `destination_version` in mesh telemetry mean anything. It must never
 *     appear in a selector, because it moves.
 *   `track` never changes. It is the selector-stable half: a Service pinned to
 *     `track: stable` keeps sending traffic to stable when a weighted route is
 *     deleted or misconfigured, instead of falling back to round-robin across
 *     an unvalidated build. It is also what lets an alert be scoped to
 *     `track="stable"`, which is what stops a canary's own error budget
 *     paging the on-call under the stable service's name.
 *
 * Before these, the `kubernetes-pods` scrape mapped the pod's `app` label to
 * `service` and nothing else, so two different builds of one service were the
 * same series and nothing could tell them apart.
 *
 * What each assertion defends:
 *
 *   - THE LABEL DRIFTING FROM THE IMAGE. The version now lives in two places,
 *     the image reference and the label, which is a drift waiting to happen —
 *     and a stale version label is worse than none, because it reads as fact.
 *     So the expected value is DERIVED from the image on every run rather than
 *     written down here: bump an image and this test names both values.
 *   - IT LEAKING INTO A SELECTOR. `spec.selector.matchLabels` is IMMUTABLE on
 *     Deployment, StatefulSet and DaemonSet. A `version` there cannot be
 *     changed afterwards, so the next image bump fails to apply with "field is
 *     immutable" and the only fix is deleting the workload. Selector matching
 *     is a subset test, so `app` alone still selects the pods.
 *   - A NON-STRING VALUE. Label values must be strings, but `18` and `3.6` are
 *     YAML numbers and an unquoted one is rejected at apply time. Postgres is
 *     tagged `18`, so this is live rather than theoretical.
 *   - THE RELABEL GOING MISSING. Without the `kubernetes-pods` relabel rules
 *     the labels sit on the pod and reach no series — present, queryable
 *     nowhere, which looks identical to working until someone groups by them.
 *   - A WORKLOAD KIND BEING FORGOTTEN. The first pass covered Deployments and
 *     StatefulSets and silently missed the DaemonSet and all six CronJobs,
 *     which is why this walks every kind that owns a pod template.
 *   - THE FOUR TARGETS DISAGREEING ON A VERSION. The trees are standalone by
 *     design, so the same service is declared four times and a bump applied to
 *     one is the normal way they diverge.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from '@jest/globals';
import { parseAllDocuments, parseDocument } from 'yaml';
import { read, REPO_ROOT, K8S_TARGETS } from '../src/index.js';

/** Kubernetes label-value grammar: <=63 chars, alphanumeric ends, `-_.` inside. */
const LABEL_VALUE = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;

/** Every kind that owns a pod template, so none is silently skipped. */
const POD_OWNERS = ['Deployment', 'StatefulSet', 'DaemonSet', 'DaemonSet', 'CronJob', 'Job'] as const;

/**
 * Workloads whose `version` is a TOKEN in the manifest, substituted before the
 * apply, because the manifest cannot name their image at authoring time.
 *
 * Only db-backup: its image is operator-supplied (`${BACKUP_IMAGE}`), so the
 * version is derived from that ref and validated by `pb_backup_schedule_env`.
 * These are exempt from the literal-value and image-match checks — and in
 * exchange the wiring suite below asserts the token is actually substituted and
 * validated, so the exemption cannot hide an unsubstituted label.
 */
const TOKENIZED: Record<string, string> = {
  'db-backup': '${BACKUP_IMAGE_VERSION}',
};

type Workload = {
  target: string;
  file: string;
  kind: string;
  name: string;
  container: string;
  image: string;
  /** Raw text after the image ref — digest-pinned refs keep the tag in a comment. */
  trailing: string;
  version: unknown;
  track: unknown;
  selectorHasVersion: boolean;
  selectorHasTrack: boolean;
};

/** The version the image itself claims: its tag, or the tag a digest-only pin left in a comment. */
function versionFromImage(image: string, trailing: string): string | null {
  const head = image.split('@')[0];
  const last = head.split('/').pop() ?? '';
  if (last.includes(':') && !last.includes('${')) return last.slice(last.indexOf(':') + 1);
  return (
    /#\s*\S*?:([A-Za-z0-9][-A-Za-z0-9_.]*)\s*$/.exec(trailing)?.[1] ??
    /#\s*(v?[0-9][-A-Za-z0-9_.]*)\s*$/.exec(trailing)?.[1] ??
    null
  );
}

function workloadsOf(target: string): Workload[] {
  const dir = join(REPO_ROOT, target, 'k8s');
  const found: Workload[] = [];

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()) {
    const raw = read(`${target}/k8s/${file}`);
    for (const doc of parseAllDocuments(raw)) {
      const o = doc.toJSON() as Record<string, any> | null;
      if (!o || !POD_OWNERS.includes(o.kind)) continue;

      const name = String(o.metadata?.name);
      // A CronJob's pod template is one level deeper, inside its jobTemplate.
      const tmpl = o.kind === 'CronJob' ? o.spec?.jobTemplate?.spec?.template : o.spec?.template;
      const containers = (tmpl?.spec?.containers ?? []) as Record<string, any>[];
      if (!containers.length) continue;
      // The workload's OWN container, not an exporter sidecar: match on name,
      // and fall back to the first (redis-sentinel's is called `sentinel`).
      const primary = containers.find((c) => c.name === name) ?? containers[0];

      const image = String(primary.image);
      const escaped = image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const trailing = new RegExp(`image:\\s*${escaped}(.*)`).exec(raw)?.[1] ?? '';

      found.push({
        target,
        file: file.replace(/\.yaml$/, ''),
        kind: String(o.kind),
        name,
        container: String(primary.name),
        image,
        trailing,
        version: tmpl?.metadata?.labels?.version,
        track: tmpl?.metadata?.labels?.track,
        selectorHasVersion: o.spec?.selector?.matchLabels?.version !== undefined,
        selectorHasTrack: o.spec?.selector?.matchLabels?.track !== undefined,
      });
    }
  }
  return found;
}

describe.each(K8S_TARGETS)('%s — version and track labels', (target) => {
  const workloads = workloadsOf(target);
  // Every workload is labelled; the only variation is whether `version` is a
  // literal or a token, which the two filters below express.
  const labelled = workloads;
  const literal = workloads.filter((w) => !(w.name in TOKENIZED));

  it('finds workloads of every pod-owning kind (guards a vacuous pass)', () => {
    expect(workloads.length).toBeGreaterThanOrEqual(32);
    // The first pass missed the DaemonSet and the CronJobs entirely; naming
    // the kinds here is what makes that omission fail rather than pass.
    const kinds = new Set(workloads.map((w) => w.kind));
    expect(kinds.has('Deployment')).toBe(true);
    expect(kinds.has('DaemonSet')).toBe(true);
    for (const name of ['platform', 'postgres', 'nginx', 'promtail']) {
      expect(workloads.map((w) => w.name)).toContain(name);
    }
  });

  it('gives every workload track: stable', () => {
    const missing = labelled.filter((w) => w.track !== 'stable').map((w) => `${w.kind}/${w.name} track=${w.track}`);
    expect(missing).toEqual([]);
  });

  it('gives every workload a version, with no exceptions', () => {
    const missing = labelled.filter((w) => w.version === undefined).map((w) => `${w.kind}/${w.name}`);
    expect(missing).toEqual([]);
  });

  it('uses the expected token wherever the version is not a literal', () => {
    // A token that is not the one the deploy substitutes would reach the
    // cluster verbatim and be rejected as a label value.
    const wrong = workloads
      .filter((w) => typeof w.version === 'string' && (w.version as string).includes('${'))
      .filter((w) => w.version !== TOKENIZED[w.name])
      .map((w) => `${w.name}: ${w.version}`);
    expect(wrong).toEqual([]);
  });

  it('keeps both labels legal string values', () => {
    const bad = literal
      .flatMap((w) => [
        ['version', w.version] as const,
        ['track', w.track] as const,
      ].filter(([, v]) => v !== undefined).map(([k, v]) => ({ w, k, v })))
      .filter(({ v }) => typeof v !== 'string' || !LABEL_VALUE.test(v as string))
      .map(({ w, k, v }) => `${w.name}.${k}: ${typeof v} ${JSON.stringify(v)}`);
    expect(bad).toEqual([]);
  });

  it('matches the version its own image declares', () => {
    const drifted = literal
      .filter((w) => w.version !== undefined)
      .map((w) => ({ w, expected: versionFromImage(w.image, w.trailing) }))
      .filter(({ w, expected }) => expected !== null && w.version !== expected)
      .map(({ w, expected }) => `${w.name} (container ${w.container}): label=${w.version} image says ${expected}`);
    expect(drifted).toEqual([]);
  });

  it('can derive a version wherever one is claimed (so the check above is not skipped)', () => {
    const underivable = literal
      .filter((w) => w.version !== undefined && versionFromImage(w.image, w.trailing) === null)
      .map((w) => `${w.name} <- ${w.image}`);
    expect(underivable).toEqual([]);
  });

  it('never puts either label in an immutable spec.selector', () => {
    const leaked = workloads
      .filter((w) => w.selectorHasVersion || w.selectorHasTrack)
      .map((w) => `${w.kind}/${w.name}`);
    expect(leaked).toEqual([]);
  });

  it('surfaces both as metric labels in the kubernetes-pods scrape', () => {
    const prom = read(`${target}/config/prometheus/prometheus.yml`);
    const start = prom.indexOf("job_name: 'kubernetes-pods'");
    expect(start).toBeGreaterThan(-1);
    const next = prom.indexOf('job_name:', start + 10);
    const job = prom.slice(start, next > 0 ? next : undefined);
    for (const key of ['version', 'track']) {
      expect(job).toContain(`__meta_kubernetes_pod_label_${key}`);
      expect(job).toContain(`target_label: ${key}`);
    }
  });
});

describe('deploy/local/docker — compose service labels', () => {
  // Nothing in the docker target READS these: its Prometheus uses
  // static_configs with no docker service discovery, and there is no mesh. They
  // are here for parity, so a service's version is stated the same way on all
  // four targets rather than only on the three that run Kubernetes.
  const raw = read('deploy/local/docker/docker-compose.yml');
  const services = (parseDocument(raw).toJSON() as Record<string, any>).services as Record<string, any>;

  it('has services to check (guards a vacuous pass)', () => {
    expect(Object.keys(services).length).toBeGreaterThanOrEqual(30);
    for (const n of ['platform', 'postgres', 'nginx']) expect(services[n]).toBeDefined();
  });

  it('labels every service with a version and track: stable', () => {
    const bad = Object.entries(services)
      .filter(([, s]) => s.labels?.track !== 'stable' || typeof s.labels?.version !== 'string')
      .map(([n, s]) => `${n}: ${JSON.stringify(s.labels)}`);
    expect(bad).toEqual([]);
  });

  it('matches the version each service image declares', () => {
    const drifted = Object.entries(services)
      .map(([n, s]) => {
        const image = String(s.image);
        const escaped = image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const trailing = new RegExp(`image:\\s*'?${escaped}'?(.*)`).exec(raw)?.[1] ?? '';
        return { n, expected: versionFromImage(image, trailing), got: s.labels?.version };
      })
      .filter(({ expected, got }) => expected !== null && got !== expected)
      .map(({ n, expected, got }) => `${n}: label=${got} image says ${expected}`);
    expect(drifted).toEqual([]);
  });
});

describe('${BACKUP_IMAGE_VERSION} — the one tokenized version label', () => {
  // db-backup's image is operator-supplied, so its version label is a token.
  // That exempts it from the image-match check above, and this suite is the
  // price of the exemption: if the token is not derived, not validated, or not
  // substituted, the label reaches the cluster as the literal string
  // `${BACKUP_IMAGE_VERSION}` and the apply is REJECTED — one bad document
  // deep into a stream of hundreds, which is the worst place to find out.
  const helpers = read('deploy/bin/k8s-resources.sh');

  it('derives the version from BACKUP_IMAGE rather than taking a second variable', () => {
    expect(helpers).toContain('PB_BACKUP_IMAGE_VERSION');
    // stripped of any digest pin before the tag is taken
    expect(helpers).toContain('${BACKUP_IMAGE%@sha256:*}');
    expect(helpers).toContain('export PB_BACKUP_IMAGE_VERSION');
  });

  it('validates it as a label value BEFORE the apply', () => {
    // A registry host can carry a port (`registry:5000/backup`), which is not
    // a tag; and a tag is not automatically a legal label value.
    const fn = helpers.slice(helpers.indexOf('pb_backup_schedule_env()'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('*[!A-Za-z0-9._-]*'); // character set
    expect(body).toContain('-gt 63'); // length ceiling
    expect(body).toMatch(/return 1/); // and it refuses, not warns
  });

  it('is substituted by both AWS targets that ship the CronJob', () => {
    for (const caller of ['deploy/aws/eks/bin/setup.sh', 'deploy/aws/ec2/bin/startup.sh']) {
      const s = read(caller);
      expect(s).toContain('{BACKUP_IMAGE_VERSION}');
      expect(s).toContain('${PB_BACKUP_IMAGE_VERSION}');
      // the helper that computes it must run before the apply that needs it
      expect(s.indexOf('pb_backup_schedule_env')).toBeLessThan(s.indexOf('{BACKUP_IMAGE_VERSION}'));
    }
  });

  it('leaves no OTHER unsubstituted token in a label position', () => {
    // Any token in a label that no caller substitutes is a guaranteed apply
    // rejection, so sweep for them rather than trusting the list above.
    const unsubstituted: string[] = [];
    for (const target of K8S_TARGETS) {
      const known = read(`${target}/k8s/kustomization.yaml`); // target exists
      expect(known.length).toBeGreaterThan(0);
      for (const w of workloadsOf(target)) {
        for (const [k, v] of [['version', w.version], ['track', w.track]] as const) {
          if (typeof v !== 'string' || !v.includes('${')) continue;
          if (v === TOKENIZED[w.name] && k === 'version') continue;
          unsubstituted.push(`${target}/${w.name}.${k} = ${v}`);
        }
      }
    }
    expect(unsubstituted).toEqual([]);
  });
});

describe('deploy/bin/sync-image-tags.sh — moves the label with the tag', () => {
  // This is the ONE tool that moves an owned image's tag, and the version now
  // lives in two places. If it rewrites only the ref, the label is left stale
  // and the per-target drift assertion above goes red at the NEXT release —
  // far from the change that caused it. Asserting it here fails immediately if
  // the label rewrite is removed.
  const script = read('deploy/bin/sync-image-tags.sh');

  it('rewrites version labels, not just image refs', () => {
    expect(script).toContain('sync_version_label');
    // both file shapes: the k8s manifests (swept by image) and compose's shared file
    expect(script).toContain('sync_version_label k8s');
    expect(script).toContain('sync_version_label compose');
  });

  it('rewrites labels by IMAGE, not by file name', () => {
    // CI caught this: `grype-db.yaml` is a CronJob that runs the PLUGIN image,
    // so a sweep of `<svc>.yaml` alone re-pinned its ref and left its label at
    // the previous release. Image refs are rewritten in every deploy file;
    // labels have to be too.
    expect(script).toContain('ghcr.io/${OWNER}/${_svc}:');
    expect(script).toContain('deploy/$tree/k8s"/*.yaml');
    // and it must refuse a service whose image is nowhere in a tree, rather
    // than reporting a clean sync that moved nothing
    expect(script).toContain('no workload in deploy/$tree/k8s carries that image');
  });

  it('covers all three k8s trees and the compose file', () => {
    for (const tree of ['local/minikube', 'aws/ec2', 'aws/eks']) {
      expect(script).toContain(tree);
    }
    expect(script).toContain('docker-compose.yml');
  });

  it('aborts the run when a label is not updated', () => {
    // A sync that silently matched nothing is the exact failure mode this
    // guards: it would leave a stale version and report success. The k8s sweep
    // allows a per-FILE miss (most files hold no workload for a given image)
    // but refuses a per-TREE miss; compose is still exactly-once.
    expect(script).toMatch(/sync_version_label compose[^\n]*\|\| exit 1/);
    expect(script).toContain('exit (n == 1 ? 0 : 1)'); // compose: exactly one
    expect(script).toContain('exit (hits > 0 ? 0 : 2)'); // k8s: 2 = nothing here
    expect(script).toMatch(/_touched[^\n]*-eq 0/); // per-tree miss is fatal
  });
});

describe('release workflow — runs the sync, in the right order', () => {
  // The script only helps if the release actually runs it, and the ORDER is the
  // part that is easy to get wrong:
  //   sync  ->  verify  ->  commit
  // Verify must sit BETWEEN them. Committing before verifying would pin the
  // deploy tree to a digest nobody can pull and make it look deliberate;
  // verifying before syncing would only re-check the versions the tree already
  // had, which is what this job did before and is why deploy/ stayed a release
  // behind until someone ran the script by hand.
  const wf = read('.github/workflows/release.yml');
  const job = wf.slice(wf.indexOf('  verify_release:'), wf.indexOf('  record_build:'));

  it('has the verify_release job to inspect (guards a vacuous pass)', () => {
    expect(job.length).toBeGreaterThan(200);
    expect(job).toContain('name: verify release');
  });

  it('runs sync-image-tags.sh', () => {
    expect(job).toContain('deploy/bin/sync-image-tags.sh');
  });

  it('syncs BEFORE verifying, and commits AFTER', () => {
    const sync = job.indexOf('sync-image-tags.sh');
    const verify = job.indexOf('verify-image-tags.sh');
    const commit = job.indexOf('git commit');
    expect(sync).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(-1);
    expect(sync).toBeLessThan(verify);
    expect(verify).toBeLessThan(commit);
  });

  it('can push what it commits', () => {
    // `contents: read` would fail the push at the very end of a release, after
    // the images are already public — the most expensive place to discover it.
    expect(job).toContain('contents: write');
    expect(job).toContain('git push');
  });

  it('sets up buildx, which the digest lookup needs', () => {
    // sync-image-tags.sh resolves each manifest-list digest with
    // `docker buildx imagetools inspect`; without buildx every service fails
    // to resolve and the whole sync aborts.
    expect(job).toContain('setup-buildx-action');
  });

  it('skips the commit on an empty diff instead of failing or masking it', () => {
    // `git commit` exits non-zero with nothing to commit, which is the normal
    // outcome of a release where nothing image-affected changed. It must be
    // skipped explicitly — not `|| true`, which would also swallow a real
    // failure.
    expect(job).toContain('git diff --quiet -- deploy');
    expect(job).not.toContain('git commit -m "chore: synced deploy image tags and version labels to the released versions" || true');
  });

  it('commits only the tree the sync writes', () => {
    // `git add -A` would sweep in whatever an earlier step left behind.
    expect(job).toContain('git add -- deploy');
    expect(job).not.toMatch(/git add -A(?!\s+--\s+deploy)/);
  });
});

describe('cross-target — one version per service', () => {
  /** service name -> target -> version, across all four targets. */
  const table = new Map<string, Map<string, string>>();
  for (const target of K8S_TARGETS) {
    for (const w of workloadsOf(target)) {
      if (typeof w.version !== 'string') continue;
      if (!table.has(w.name)) table.set(w.name, new Map());
      table.get(w.name)!.set(target, w.version);
    }
  }
  {
    const raw = read('deploy/local/docker/docker-compose.yml');
    const services = (parseDocument(raw).toJSON() as Record<string, any>).services as Record<string, any>;
    for (const [n, s] of Object.entries(services)) {
      if (typeof s.labels?.version !== 'string') continue;
      if (!table.has(n)) table.set(n, new Map());
      table.get(n)!.set('deploy/local/docker', s.labels.version);
    }
  }

  it('sees services on more than one target (guards a vacuous pass)', () => {
    expect([...table.values()].filter((m) => m.size > 1).length).toBeGreaterThanOrEqual(20);
  });

  it('never runs two versions of the same service across targets', () => {
    // A service is allowed to be ABSENT from a target — the trees differ in
    // topology (ec2 runs redis as one pod, eks as a sentinel StatefulSet; the
    // exporters are sidecars under Kubernetes and standalone under compose).
    // What is not allowed is two targets claiming different versions.
    const diverged = [...table.entries()]
      .map(([svc, byTarget]) => ({ svc, vals: [...new Set(byTarget.values())], byTarget }))
      .filter(({ vals }) => vals.length > 1)
      .map(({ svc, byTarget }) =>
        `${svc}: ${[...byTarget.entries()].map(([t, v]) => `${t}=${v}`).join(' ')}`);
    expect(diverged).toEqual([]);
  });
});
