// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The deploy half of nightly plugin CVE remediation.
 *
 * Remediation rebuilds and patches a flagged version from its KEPT build
 * source, so the platform now stores every version's build context for the
 * version's whole life, in its own RustFS bucket. Four things about that bucket
 * are each silent when wrong:
 *
 *  - an EXPIRY rule (copied from the `plugins` staging bucket next to it) would
 *    delete every source after a week, and remediation would quietly fall back
 *    to overlay-only for everything;
 *  - VERSIONING would make a purge leave the deleted sources behind as
 *    noncurrent versions — a tenant's code kept after they purged it;
 *  - without SSE the sources sit in the clear, and with SSE but no
 *    RUSTFS_SSE_S3_MASTER_KEY on the server every write is refused (verified
 *    live: "SSE-S3 requires RUSTFS_SSE_S3_MASTER_KEY ... when KMS is not
 *    configured"), which first shows as every plugin build failing;
 *  - the plugin service's key must reach exactly its three buckets, and no
 *    other service may hold it.
 *
 * Plus the operator knobs (PLUGIN_REMEDIATION_*), which must be declared with
 * their contract defaults on every target, and the alerts the plan promises.
 *
 * Names and defaults are read from the api-core contract SOURCE
 * (`types/plugin-remediation.ts`), not restated, so a renamed knob fails here.
 */

import { spawnSync } from 'child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';
import { ALL_TARGETS, K8S_TARGETS, REPO_ROOT, read, yamlDocs } from '../src/index.js';

type Doc = Record<string, any>;

const BUCKET = 'plugin-sources';
const PLUGIN_BUCKETS = ['plugins', 'plugin-quarantine', BUCKET];
const COMPOSE = 'deploy/local/docker/docker-compose.yml';
const CONTRACT = 'packages/api-core/src/types/plugin-remediation.ts';

/** `PLUGIN_REMEDIATION_ENV` from the contract source: name -> default, as text. */
function envContract(): Record<string, string> {
  const src = read(CONTRACT);
  const block = /export const PLUGIN_REMEDIATION_ENV = \{([\s\S]*?)\} as const;/.exec(src);
  expect(block).not.toBeNull();
  const out: Record<string, string> = {};
  for (const m of block![1].matchAll(/name: '([A-Z0-9_]+)', default: ('([^']*)'|[0-9]+|true|false)/g)) {
    out[m[1]] = m[3] ?? m[2];
  }
  return out;
}

/** `PLUGIN_REMEDIATION_METRICS` values from the contract source. */
function metricContract(): string[] {
  const block = /export const PLUGIN_REMEDIATION_METRICS = \{([\s\S]*?)\} as const;/.exec(read(CONTRACT));
  expect(block).not.toBeNull();
  return [...block![1].matchAll(/: '([a-z0-9_]+)'/g)].map((m) => m[1]);
}

/** The rustfs-init script on a target, with compose's `$$` escapes undone. */
function initScript(target: string): string {
  if (target === 'deploy/local/docker') {
    const compose = read(COMPOSE);
    const svc = compose.slice(compose.indexOf('\n  rustfs-init:\n    image:'));
    const body = svc.slice(svc.indexOf('      - |\n'), svc.indexOf('\n  # ', svc.indexOf('      - |\n')));
    return body.replace(/\$\$/g, '$');
  }
  const job = yamlDocs<Doc>(`${target}/k8s/rustfs.yaml`).find((d) => d.kind === 'Job' && d.metadata?.name === 'rustfs-init');
  expect(job).toBeDefined();
  return job!.spec.template.spec.containers[0].args[0] as string;
}

/** Bucket names a policy JSON written by the init script grants, keyed by policy name. */
function policies(script: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  // Literal policies: `echo '{...}' > /tmp/x.json` then `policy create local <name> /tmp/x.json`.
  for (const m of script.matchAll(/echo '(\{"Version"[^']+\})' > (\/tmp\/\w+\.json)\n\s*run_ok "[^"]*" rc admin policy create local ([\w-]+) \2/g)) {
    const doc = JSON.parse(m[1]);
    const buckets = new Set<string>();
    for (const st of doc.Statement) for (const r of st.Resource) buckets.add(String(r).replace('arn:aws:s3:::', '').replace(/\/\*$/, ''));
    out[m[3]] = [...buckets];
  }
  // make_user <bucket> <policy> ...: one bucket each.
  for (const m of script.matchAll(/^\s*make_user ([\w-]+)\s+([\w-]+)\s/gm)) out[m[2]] = [m[1]];
  return out;
}

describe.each(ALL_TARGETS)('plugin-sources bucket — %s', (target) => {
  const script = initScript(target);

  it('is created by the same rustfs-init bucket loop as the plugin buckets', () => {
    const loop = /for b in ([a-z -]+); do rc bucket create --ignore-existing/.exec(script);
    expect(loop).not.toBeNull();
    expect(loop![1].trim().split(/\s+/)).toEqual(expect.arrayContaining(PLUGIN_BUCKETS));
  });

  it('has NO expiry rule, and the init asserts it rather than assuming it', () => {
    expect(script).not.toMatch(new RegExp(`lifecycle rule add local/${BUCKET} --expiry-days`));
    expect(script).toContain(`rc bucket lifecycle rule list local/${BUCKET} --format json`);
    expect(script).toContain('select(.expiration != null)] | length == 0');
  });

  it('is never versioned, and the init refuses a bucket that is', () => {
    expect(script).not.toContain(`version enable local/${BUCKET}`);
    expect(script).toContain(`rc bucket version info local/${BUCKET} --format json`);
    expect(script).toContain("jq -e '.enabled != true'");
  });

  it('keeps exactly one 1-day noncurrent-expiry backstop (rule add is not idempotent)', () => {
    // Through the converging helper (rustfs-lifecycle-contract.test.ts): an
    // unguarded add stacks a duplicate rule on every provision (verified live).
    expect(script.match(new RegExp(`^\\s*ensure_rule ${BUCKET} noncurrent 1$`, 'gm'))).toHaveLength(1);
  });

  it('turns SSE-S3 on, checks it took, and proves an encrypted write works', () => {
    expect(script).toContain(`rc bucket encryption set local/${BUCKET} --mode sse-s3`);
    expect(script).toContain(`rc bucket encryption info local/${BUCKET} --format json`);
    expect(script).toContain('jq -e \'.mode == "SSE-S3"\'');
    expect(script).toMatch(new RegExp(`rc put "\\$SSEPROBE" local/${BUCKET}/_sse-probe`));
    expect(script).toContain(`rc object remove local/${BUCKET}/_sse-probe`);
  });

  it('gives the RustFS server the SSE master key', () => {
    if (target === 'deploy/local/docker') {
      const compose = read(COMPOSE);
      const rustfs = compose.slice(compose.indexOf('\n  rustfs:\n'), compose.indexOf('\n  rustfs-init:\n    image:'));
      expect(rustfs).toContain('RUSTFS_SSE_S3_MASTER_KEY: ${RUSTFS_SSE_S3_MASTER_KEY}');
      return;
    }
    const server = yamlDocs<Doc>(`${target}/k8s/rustfs.yaml`).find((d) => ['Deployment', 'StatefulSet'].includes(d.kind) && d.metadata?.name === 'rustfs');
    expect(server).toBeDefined();
    const env = server!.spec.template.spec.containers[0].env as Doc[];
    const key = env.find((e) => e.name === 'RUSTFS_SSE_S3_MASTER_KEY');
    expect(key?.valueFrom?.secretKeyRef).toEqual({ name: 'rustfs-secret', key: 'sse-s3-master-key' });
  });

  it('is mirrored by the backup with the other object-store buckets', () => {
    const common = read('deploy/bin/common.sh');
    expect(/^PB_OBJECTSTORE_BUCKETS="([^"]+)"/m.exec(common)![1].split(' ')).toContain(BUCKET);
  });
});

describe.each(ALL_TARGETS)('plugin service RustFS key scoping — %s', (target) => {
  const script = initScript(target);
  const pols = policies(script);

  it('parses the init policies (guards a vacuous pass)', () => {
    expect(Object.keys(pols).length).toBeGreaterThanOrEqual(6);
  });

  it('attaches exactly the three plugin-bucket policies to the plugin user, in ONE call', () => {
    // `rc admin policy attach` REPLACES the user's policy set, so a second call
    // would silently drop the first grant.
    const attaches = [...script.matchAll(/rc admin policy attach local ([\w,-]+) --user "\$PLUGIN_S3_ACCESS_KEY_ID"/g)].map((m) => m[1]);
    expect(attaches).toHaveLength(1);
    const names = attaches[0].split(',');
    expect(names.sort()).toEqual(['plugin-quarantine-rw', 'plugin-sources-rw', 'plugins-rw']);
    const reach = new Set(names.flatMap((n) => pols[n] ?? []));
    expect([...reach].sort()).toEqual([...PLUGIN_BUCKETS].sort());
  });

  it('creates the plugin user from PLUGIN_S3_ACCESS_KEY_ID / PLUGIN_S3_SECRET_ACCESS_KEY', () => {
    expect(script).toMatch(/make_user plugins\s+plugins-rw\s+"\$PLUGIN_S3_ACCESS_KEY_ID" "\$PLUGIN_S3_SECRET_ACCESS_KEY"/);
    expect(script).not.toMatch(/\$PLUGIN_S3_ACCESS_KEY[^_]|\$PLUGIN_S3_SECRET_KEY/);
  });

  it('maps the scoped key into the plugin container as S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY', () => {
    if (target === 'deploy/local/docker') {
      const compose = read(COMPOSE);
      const plugin = compose.slice(compose.indexOf('\n  plugin:\n'), compose.indexOf('\n  buildkitd:\n'));
      expect(plugin).toContain('S3_ACCESS_KEY_ID: ${PLUGIN_S3_ACCESS_KEY_ID}');
      expect(plugin).toContain('S3_SECRET_ACCESS_KEY: ${PLUGIN_S3_SECRET_ACCESS_KEY}');
      return;
    }
    const dep = yamlDocs<Doc>(`${target}/k8s/plugin.yaml`).find((d) => d.kind === 'Deployment' && d.metadata?.name === 'plugin');
    const env = dep!.spec.template.spec.containers.find((c: Doc) => c.name === 'plugin').env as Doc[];
    expect(env.find((e) => e.name === 'S3_ACCESS_KEY_ID')?.valueFrom?.secretKeyRef).toEqual({ name: 'rustfs-secret', key: 'plugin-access-key' });
    expect(env.find((e) => e.name === 'S3_SECRET_ACCESS_KEY')?.valueFrom?.secretKeyRef).toEqual({ name: 'rustfs-secret', key: 'plugin-secret-key' });
  });
});

describe('the plugin key reaches no other service', () => {
  it('docker: only the plugin service and rustfs-init read PLUGIN_S3_*', () => {
    const compose = read(COMPOSE);
    const services = compose.slice(compose.indexOf('\nservices:\n'));
    const users = new Set<string>();
    let current = '';
    for (const line of services.split('\n')) {
      const svc = /^  ([a-z0-9-]+):$/.exec(line);
      if (svc) current = svc[1];
      if (/\$\{PLUGIN_S3_/.test(line)) users.add(current);
    }
    expect([...users].sort()).toEqual(['plugin', 'rustfs-init']);
  });

  it('kubernetes: rustfs-secret is built from the renamed keys plus the SSE master key', () => {
    const script = read('deploy/bin/k8s-resources.sh');
    expect(script).toContain('--from-literal=plugin-access-key="$PLUGIN_S3_ACCESS_KEY_ID"');
    expect(script).toContain('--from-literal=plugin-secret-key="$PLUGIN_S3_SECRET_ACCESS_KEY"');
    expect(script).toContain('--from-literal=sse-s3-master-key="$RUSTFS_SSE_S3_MASTER_KEY"');
  });

  it.each(K8S_TARGETS)('%s: no other workload reads plugin-access-key / plugin-secret-key', (target) => {
    const readers = new Set<string>();
    for (const file of ['plugin.yaml', 'rustfs.yaml', 'message.yaml', 'registry.yaml', 'loki.yaml', 'platform.yaml', 'pipeline.yaml', 'image-registry.yaml']) {
      let text: string;
      try { text = read(`${target}/k8s/${file}`); } catch { continue; }
      if (/key: plugin-(access|secret)-key/.test(text)) readers.add(file);
    }
    expect([...readers].sort()).toEqual(['plugin.yaml', 'rustfs.yaml']);
  });
});

describe('RUSTFS_SSE_S3_MASTER_KEY generation', () => {
  it('generates a real 32-byte base64 key and leaves no CHANGE_ME behind', () => {
    // Run the real generator over a copy of a target's .env.example: the key
    // must be exactly what RustFS accepts (base64 of 32 bytes, so the =+/ that
    // the other generators strip must survive here).
    const dir = mkdtempSync(join(tmpdir(), 'pb-sse-'));
    try {
      const env = join(dir, '.env');
      copyFileSync(join(REPO_ROOT, 'deploy/local/docker/.env.example'), env);
      const r = spawnSync('bash', ['-c', `source "${join(REPO_ROOT, 'deploy/bin/gen-env-secrets.sh')}" && pb_gen_env_secrets "$1"`, '_', env], { encoding: 'utf-8' });
      expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
      const text = readFileSync(env, 'utf-8');
      const key = /^RUSTFS_SSE_S3_MASTER_KEY=(.*)$/m.exec(text)![1];
      expect(Buffer.from(key, 'base64')).toHaveLength(32);
      expect(Buffer.from(key, 'base64').toString('base64')).toBe(key);
      const plugin = /^PLUGIN_S3_SECRET_ACCESS_KEY=(.*)$/m.exec(text)![1];
      expect(plugin).not.toBe('CHANGE_ME');
      expect(plugin.length).toBeGreaterThanOrEqual(24);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('guards the key against a drifted placeholder', () => {
    const script = read('deploy/bin/gen-env-secrets.sh');
    const guarded = /grep -qE '\^\(([A-Z0-9_|]+)\)=CHANGE_ME'/.exec(script)![1].split('|');
    expect(guarded).toEqual(expect.arrayContaining(['RUSTFS_SSE_S3_MASTER_KEY', 'PLUGIN_S3_SECRET_ACCESS_KEY']));
  });
});

describe('remediation operator knobs', () => {
  const knobs = envContract();

  it('reads every knob from the contract (guards a vacuous pass)', () => {
    expect(knobs).toEqual({
      PLUGIN_REMEDIATION_ENABLED: 'true',
      PLUGIN_REMEDIATION_SEVERITIES: 'critical,high',
      PLUGIN_REMEDIATION_CONCURRENCY: '2',
      PLUGIN_REMEDIATION_BASE_CONCURRENCY: '4',
      PLUGIN_REMEDIATION_MAX_PER_ORG_PER_DAY: '20',
      PLUGIN_SOURCES_BUCKET: 'plugin-sources',
    });
  });

  it.each(ALL_TARGETS)('%s: declares every knob in .env.example with its contract default', (target) => {
    const env = read(`${target}/.env.example`);
    for (const [name, def] of Object.entries(knobs)) {
      const lines = [...env.matchAll(new RegExp(`^${name}=(.*)$`, 'gm'))].map((m) => m[1]);
      expect({ name, lines }).toEqual({ name, lines: [def] });
    }
    // The deploy-only credential pair, a CHANGE_ME the generator fills.
    expect(env).toMatch(/^PLUGIN_S3_ACCESS_KEY_ID=plugin-svc$/m);
    expect(env).toMatch(/^PLUGIN_S3_SECRET_ACCESS_KEY=CHANGE_ME$/m);
    expect(env).toMatch(/^RUSTFS_SSE_S3_MASTER_KEY=CHANGE_ME$/m);
    expect(env).not.toMatch(/^PLUGIN_S3_(ACCESS|SECRET)_KEY=/m);
  });

  it('docker: passes every knob through to the plugin service with the same default', () => {
    const compose = read(COMPOSE);
    const plugin = compose.slice(compose.indexOf('\n  plugin:\n'), compose.indexOf('\n  buildkitd:\n'));
    for (const [name, def] of Object.entries(knobs)) {
      expect(plugin).toContain(`      ${name}: \${${name}:-${def}}\n`);
    }
  });

  it('docker: passes PLUGIN_REMEDIATION_ENABLED to the pipeline service too (its rollout worker obeys it)', () => {
    const compose = read(COMPOSE);
    const pipeline = compose.slice(compose.indexOf('\n  pipeline:\n'), compose.indexOf('\n  message:\n'));
    expect(pipeline).toContain('      PLUGIN_REMEDIATION_ENABLED: ${PLUGIN_REMEDIATION_ENABLED:-true}\n');
  });

  it.each(K8S_TARGETS)('%s: the pipeline pod reads app-env too, so the operator switch reaches its rollout worker', (target) => {
    const dep = yamlDocs<Doc>(`${target}/k8s/pipeline.yaml`).find((d) => d.kind === 'Deployment' && d.metadata?.name === 'pipeline');
    const c = dep!.spec.template.spec.containers.find((x: Doc) => x.name === 'pipeline');
    expect(c.envFrom).toEqual(expect.arrayContaining([{ configMapRef: { name: 'app-env' } }]));
    expect((c.env as Doc[] ?? []).map((e) => e.name)).not.toContain('PLUGIN_REMEDIATION_ENABLED');
  });

  it.each(K8S_TARGETS)('%s: the plugin pod reads app-env, which carries the knobs (none is dropped or a secret)', (target) => {
    const dep = yamlDocs<Doc>(`${target}/k8s/plugin.yaml`).find((d) => d.kind === 'Deployment' && d.metadata?.name === 'plugin');
    const c = dep!.spec.template.spec.containers.find((x: Doc) => x.name === 'plugin');
    expect(c.envFrom).toEqual(expect.arrayContaining([{ configMapRef: { name: 'app-env' } }]));
    // An explicit env entry would shadow the .env value — and pin it per target.
    const explicit = (c.env as Doc[]).map((e) => e.name);
    for (const name of Object.keys(knobs)) expect({ name, explicit: explicit.includes(name) }).toEqual({ name, explicit: false });
    const split = read('deploy/bin/k8s-resources.sh');
    const prefixes = /\|\| key ~ \/\^\(([A-Z0-9_|]+)\)\//.exec(split)![1].split('|');
    for (const name of Object.keys(knobs)) expect(prefixes.some((p) => name.startsWith(p))).toBe(false);
  });

  it('documents every knob and the credential pair in docs/environment-variables.md', () => {
    const doc = read('docs/environment-variables.md');
    for (const [name, def] of Object.entries(knobs)) {
      expect(doc).toContain(`| \`${name}\` | \`${def}\` |`);
    }
    expect(doc).toContain('`PLUGIN_S3_ACCESS_KEY_ID` / `PLUGIN_S3_SECRET_ACCESS_KEY`');
    expect(doc).toContain('| `RUSTFS_SSE_S3_MASTER_KEY` |');
    // The two behaviours an operator most needs to get right.
    expect(doc).toMatch(/PLUGIN_REMEDIATION_ENABLED[^\n]*Only the literal `false`/);
    expect(doc).toMatch(/PLUGIN_REMEDIATION_SEVERITIES[^\n]*KEV-listed findings are always targeted/);
  });
});

describe.each(ALL_TARGETS)('remediation alerts — %s', (target) => {
  const rules = read(`${target}/config/prometheus/alert-rules.yml`);
  const alert = (name: string): string => {
    const i = rules.indexOf(`      - alert: ${name}\n`);
    expect({ name, defined: i >= 0 }).toEqual({ name, defined: true });
    const next = rules.indexOf('\n      - alert: ', i + 1);
    return rules.slice(i, next < 0 ? undefined : next);
  };

  it('alerts on remediation errors, from the contract metric', () => {
    const [remediations] = metricContract();
    expect(alert('PluginRemediationErrors')).toContain(`${remediations}{outcome="error"}`);
  });

  it('alerts on failed purge deletes, per kind', () => {
    expect(metricContract()).toContain('plugin_source_delete_failures_total');
    expect(alert('PluginSourceDeleteFailing')).toContain('sum by (kind) (increase(plugin_source_delete_failures_total');
  });

  it('alerts on missing sources and on a stale fixture canary', () => {
    expect(alert('PluginSourcesMissing')).toContain('plugin_source_missing_total');
    expect(alert('PluginRemediationCanaryStale')).toContain('plugin_remediation_canary_last_success_timestamp_seconds');
  });

  it('has promtool cases for all four (firing and quiet)', () => {
    const suite = target === 'deploy/local/docker'
      ? read('deploy/local/docker/config/prometheus/alert-rules.test.yml')
      : read('deploy/local/minikube/config/prometheus/alert-rules.test.yml');
    for (const name of ['PluginRemediationErrors', 'PluginSourceDeleteFailing', 'PluginSourcesMissing', 'PluginRemediationCanaryStale']) {
      const cases = suite.split(`alertname: ${name}\n`).slice(1);
      expect({ name, firing: cases.some((c) => /^\s*exp_alerts:\n\s*- exp_labels:/.test(c)) }).toEqual({ name, firing: true });
      expect({ name, quiet: cases.some((c) => /^\s*exp_alerts: \[\]/.test(c)) }).toEqual({ name, quiet: true });
    }
  });
});

describe.each(K8S_TARGETS)('Stage 3 hops at the CNI — %s', (target) => {
  const netpols = yamlDocs<Doc>(`${target}/k8s/networkpolicy.yaml`).filter((d) => d.kind === 'NetworkPolicy');
  const admits = (dst: string, src: string): boolean => netpols.some((p) => {
    const sel = p.spec.podSelector ?? {};
    const selects = sel.matchLabels?.app === dst
      || (sel.matchExpressions ?? []).some((e: Doc) => e.key === 'app' && e.operator === 'In' && e.values.includes(dst));
    if (!selects || !(p.spec.policyTypes ?? []).includes('Ingress')) return false;
    return (p.spec.ingress ?? []).some((r: Doc) => (r.from ?? []).some((f: Doc) => f.podSelector?.matchLabels?.app === src)
      && (r.ports ?? []).some((pt: Doc) => pt.port === 3000));
  });

  it('lets plugin reach pipeline (start / cancel a rollout) and pipeline reach plugin (report)', () => {
    expect(admits('pipeline', 'plugin')).toBe(true);
    expect(admits('plugin', 'pipeline')).toBe(true);
  });
});
