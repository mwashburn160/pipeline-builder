// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every internal contract's CALLERS can reach it through the mesh.
 *
 * An api-core internal contract (packages/api-core/src/contracts) names the
 * service that serves it and the `callers` its `requireInternalService` gate
 * admits. On the three Istio targets the same call must also clear the mesh,
 * and nothing tied the two together: drop a principal from `<svc>-allow` in
 * istio.yaml, or narrow a `notPrincipals` list in istio-internal-routes.yaml,
 * and the app-side gate still says "allowed" while ztunnel RESETS the
 * connection — a failure no unit test sees and compose never reproduces.
 *
 * For every (target, contract, caller) this suite evaluates the target's
 * AuthorizationPolicies the way Istio does — DENY first, then "some ALLOW
 * matches" whenever an ALLOW selects the workload — on the request the caller
 * really sends (its SPIFFE principal, the contract's method, the contract's
 * path with each `:param` filled in, the Service's targetPort):
 *
 *  - WORKLOAD layer (ztunnel, `selector` policies): the caller's own principal
 *    must be admitted. That is what a non-waypoint Service enforces, and what a
 *    waypoint-attached one falls back to on the documented rollback (remove its
 *    `istio.io/use-waypoint` label).
 *  - For a waypoint-attached Service, additionally: the WAYPOINT layer
 *    (`targetRefs` policies on that Service) must admit the caller, and the
 *    workload layer must admit `sa/pb-waypoint`, the identity the waypoint
 *    re-originates the connection as.
 *
 * Contracts are read from SOURCE (this project depends on `yaml` and the test
 * tooling only), like the sibling suites; the parse is checked for coverage.
 */

import { readdirSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from '@jest/globals';
import { K8S_TARGETS, read, REPO_ROOT, yamlDocs } from '../src/index.js';

type Doc = Record<string, any>;

const NS = 'pipeline-builder';
const principalOf = (sa: string): string => `cluster.local/ns/${NS}/sa/${sa}`;
const WAYPOINT_LABEL = 'istio.io/use-waypoint';

/**
 * Callers that are NOT a mesh workload (a bootstrap script, a lambda, a
 * CronJob outside the mesh), with the reason they are exempt. Every contract
 * caller today is a long-running Deployment with its own ServiceAccount, so
 * the list is empty — a new non-mesh caller must be added here deliberately.
 */
const NON_MESH_CALLERS: Readonly<Record<string, string>> = {};

interface Contract { id: string; service: string; method: string; path: string; callers: string[]; file: string }

/** Every `defineInternalEndpoint({ … })` in the api-core contract sources. */
function contracts(): Contract[] {
  const dir = 'packages/api-core/src/contracts';
  const out: Contract[] = [];
  for (const file of readdirSync(join(REPO_ROOT, dir)).filter((f) => f.endsWith('.ts'))) {
    const src = read(`${dir}/${file}`);
    for (const block of src.split(/defineInternalEndpoint\(\{/).slice(1)) {
      const field = (name: string): string => {
        const m = new RegExp(`^\\s+${name}: '([^']+)',$`, 'm').exec(block);
        if (!m) throw new Error(`${file}: a contract has no literal ${name}`);
        return m[1]!;
      };
      const callers = /^\s+callers: \[([^\]]*)\],$/m.exec(block);
      if (!callers) throw new Error(`${file}: contract ${field('id')} has no literal callers list`);
      out.push({
        id: field('id'),
        service: field('service'),
        method: field('method'),
        path: field('path'),
        file,
        callers: [...callers[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!),
      });
    }
  }
  return out;
}

/** Every YAML document in a target's k8s manifests. */
function k8sDocs(target: string): Doc[] {
  const dir = `${target}/k8s`;
  return readdirSync(join(REPO_ROOT, dir)).filter((f) => f.endsWith('.yaml'))
    .flatMap((f) => yamlDocs<Doc>(`${dir}/${f}`));
}

/** The AuthorizationPolicies the mesh target applies. */
function policiesOf(target: string): Doc[] {
  return ['istio.yaml', 'istio-internal-routes.yaml']
    .flatMap((f) => yamlDocs<Doc>(`${target}/k8s/${f}`))
    .filter((d) => d.kind === 'AuthorizationPolicy');
}

// -- Istio matching ----------------------------------------------------------

/** Istio string match: exact, `*`, prefix `x*`, suffix `*x`. */
function istioMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1));
  if (pattern.startsWith('*')) return value.endsWith(pattern.slice(1));
  return pattern === value;
}
const anyMatch = (patterns: string[], value: string): boolean => patterns.some((p) => istioMatch(p, value));

interface MeshRequest { principal: string; namespace: string; method: string; path: string; port: string }

const SOURCE_KEYS = new Set(['principals', 'notPrincipals', 'namespaces', 'notNamespaces']);
const OPERATION_KEYS = new Set(['ports', 'notPorts', 'methods', 'notMethods', 'paths', 'notPaths']);

function sourceMatches(src: Doc, req: MeshRequest): boolean {
  const unknown = Object.keys(src).filter((k) => !SOURCE_KEYS.has(k));
  if (unknown.length) throw new Error(`unsupported AuthorizationPolicy source field(s): ${unknown.join(', ')}`);
  if (src.principals && !anyMatch(src.principals, req.principal)) return false;
  if (src.notPrincipals && anyMatch(src.notPrincipals, req.principal)) return false;
  if (src.namespaces && !anyMatch(src.namespaces, req.namespace)) return false;
  if (src.notNamespaces && anyMatch(src.notNamespaces, req.namespace)) return false;
  return true;
}

function operationMatches(op: Doc, req: MeshRequest): boolean {
  const unknown = Object.keys(op).filter((k) => !OPERATION_KEYS.has(k));
  if (unknown.length) throw new Error(`unsupported AuthorizationPolicy operation field(s): ${unknown.join(', ')}`);
  const ports = (v: unknown[]): string[] => v.map(String);
  if (op.ports && !ports(op.ports).includes(req.port)) return false;
  if (op.notPorts && ports(op.notPorts).includes(req.port)) return false;
  if (op.methods && !anyMatch(op.methods, req.method)) return false;
  if (op.notMethods && anyMatch(op.notMethods, req.method)) return false;
  if (op.paths && !anyMatch(op.paths, req.path)) return false;
  if (op.notPaths && anyMatch(op.notPaths, req.path)) return false;
  return true;
}

function ruleMatches(rule: Doc, req: MeshRequest): boolean {
  if (rule.when) throw new Error('unsupported AuthorizationPolicy `when` condition');
  const fromOk = !rule.from || (rule.from as Doc[]).some((f) => sourceMatches(f.source ?? {}, req));
  const toOk = !rule.to || (rule.to as Doc[]).some((t) => operationMatches(t.operation ?? {}, req));
  return fromOk && toOk;
}

/** Istio's verdict for one request against the policies of one enforcement point. */
function evaluate(policies: Doc[], req: MeshRequest): { allowed: boolean; why: string } {
  for (const p of policies.filter((x) => x.spec?.action === 'DENY')) {
    if ((p.spec.rules ?? []).some((r: Doc) => ruleMatches(r, req))) return { allowed: false, why: `DENY ${p.metadata.name}` };
  }
  const allows = policies.filter((x) => (x.spec?.action ?? 'ALLOW') === 'ALLOW');
  if (allows.length === 0) return { allowed: true, why: 'no ALLOW selects it' };
  const hit = allows.find((p) => (p.spec.rules ?? []).some((r: Doc) => ruleMatches(r, req)));
  return hit
    ? { allowed: true, why: `ALLOW ${hit.metadata.name}` }
    : { allowed: false, why: `no ALLOW admits it (${allows.map((p) => p.metadata.name).join(', ')})` };
}

// -- the target's topology ---------------------------------------------------

interface Topology {
  /** Deployment name → its ServiceAccount. */
  serviceAccountOf: Map<string, string>;
  /** Deployment name → its pod template labels. */
  podLabelsOf: Map<string, Record<string, string>>;
  /** Service name → its manifest. */
  serviceOf: Map<string, Doc>;
  policies: Doc[];
}

function topology(target: string, policies = policiesOf(target)): Topology {
  const docs = k8sDocs(target);
  const serviceAccountOf = new Map<string, string>();
  const podLabelsOf = new Map<string, Record<string, string>>();
  for (const d of docs.filter((x) => x.kind === 'Deployment' || x.kind === 'StatefulSet')) {
    serviceAccountOf.set(d.metadata.name, d.spec.template.spec.serviceAccountName ?? 'default');
    podLabelsOf.set(d.metadata.name, d.spec.template.metadata?.labels ?? {});
  }
  const serviceOf = new Map(docs.filter((x) => x.kind === 'Service').map((s) => [s.metadata.name as string, s]));
  return { serviceAccountOf, podLabelsOf, serviceOf, policies };
}

/** Policies ztunnel enforces on the workload (selector, or namespace-wide). */
function workloadPolicies(topo: Topology, deployment: string): Doc[] {
  const labels = topo.podLabelsOf.get(deployment) ?? {};
  return topo.policies.filter((p) => {
    if (p.metadata.namespace !== NS || p.spec.targetRefs) return false;
    const sel: Record<string, string> = p.spec.selector?.matchLabels ?? {};
    return Object.entries(sel).every(([k, v]) => labels[k] === v);
  });
}

/** Policies the waypoint enforces for traffic addressed to the Service. */
function waypointPolicies(topo: Topology, service: string): Doc[] {
  return topo.policies.filter((p) => p.metadata.namespace === NS
    && (p.spec.targetRefs as Doc[] | undefined)?.some((r) => r.kind === 'Service' && r.name === service));
}

/** A concrete request path: each `:param` replaced by a value. */
const concretePath = (path: string): string => path.replace(/:[A-Za-z0-9_]+/g, 'p4r4m');

/** Every way the mesh refuses `caller` on `contract` in this topology ([] = reachable). */
function meshGaps(topo: Topology, contract: Contract, caller: string): string[] {
  const where = `${caller} -> ${contract.service} (${contract.id}: ${contract.method} ${contract.path})`;
  const sa = topo.serviceAccountOf.get(caller);
  if (!sa) return [`${where}: no Deployment named '${caller}' (add it to NON_MESH_CALLERS with a reason if it is not a mesh workload)`];
  const svc = topo.serviceOf.get(contract.service);
  if (!svc) return [`${where}: no Service named '${contract.service}'`];
  const port = String(svc.spec.ports?.[0]?.targetPort ?? svc.spec.ports?.[0]?.port);
  const base = { namespace: NS, method: contract.method, path: concretePath(contract.path), port };
  const gaps: string[] = [];

  const workload = workloadPolicies(topo, contract.service);
  const direct = evaluate(workload, { ...base, principal: principalOf(sa) });
  if (!direct.allowed) gaps.push(`${where}: workload layer refuses sa/${sa} — ${direct.why}`);

  const waypoint = svc.metadata.labels?.[WAYPOINT_LABEL] as string | undefined;
  if (waypoint) {
    const wp = evaluate(waypointPolicies(topo, contract.service), { ...base, principal: principalOf(sa) });
    if (!wp.allowed) gaps.push(`${where}: waypoint refuses sa/${sa} — ${wp.why}`);
    const hop = evaluate(workload, { ...base, principal: principalOf(waypoint) });
    if (!hop.allowed) gaps.push(`${where}: workload layer refuses the waypoint sa/${waypoint} — ${hop.why}`);
  }
  return gaps;
}

function allGaps(target: string, topo = topology(target)): string[] {
  return contracts().flatMap((c) => c.callers
    .filter((caller) => !(caller in NON_MESH_CALLERS))
    .flatMap((caller) => meshGaps(topo, c, caller)));
}

// -- the suite ---------------------------------------------------------------

describe('internal contract callers are admitted by the mesh', () => {
  it('reads every contract from source (guards a vacuous pass)', () => {
    const all = contracts();
    const declared = readdirSync(join(REPO_ROOT, 'packages/api-core/src/contracts')).filter((f) => f.endsWith('.ts'))
      .reduce((n, f) => n + (read(`packages/api-core/src/contracts/${f}`).match(/defineInternalEndpoint\(\{/g)?.length ?? 0), 0);
    expect(all.length).toBe(declared);
    expect(all.length).toBeGreaterThan(40);
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    for (const c of all) expect([c.id, c.callers.length > 0]).toEqual([c.id, true]);
  });

  it('every area file is registered in INTERNAL_CONTRACTS', () => {
    const index = read('packages/api-core/src/contracts/index.ts');
    const registry = /export const INTERNAL_CONTRACTS[^=]*=\s*\[([\s\S]*?)\]/.exec(index)?.[1] ?? '';
    for (const file of new Set(contracts().map((c) => c.file))) {
      const area = new RegExp(`import \\{[^}]*\\b(\\w+_INTERNAL)\\b[^}]*\\} from '\\./${file.replace('.ts', '')}\\.js'`).exec(index)?.[1];
      expect([file, area && registry.includes(area)]).toEqual([file, true]);
    }
  });

  it('NON_MESH_CALLERS names only real contract callers, each with a reason', () => {
    const callers = new Set(contracts().flatMap((c) => c.callers));
    for (const [caller, reason] of Object.entries(NON_MESH_CALLERS)) {
      expect([caller, callers.has(caller), reason.length > 10]).toEqual([caller, true, true]);
    }
  });

  it.each(K8S_TARGETS)('%s: every caller reaches every contract it is named on', (target) => {
    expect(allGaps(target)).toEqual([]);
  });

  it.each(K8S_TARGETS)('%s: every caller and serving service runs under its own ServiceAccount', (target) => {
    const topo = topology(target);
    const names = new Set(contracts().flatMap((c) => [c.service, ...c.callers.filter((x) => !(x in NON_MESH_CALLERS))]));
    for (const name of names) expect([name, topo.serviceAccountOf.get(name)]).toEqual([name, name]);
  });
});

describe('the evaluator catches what it is meant to (self-check against mutated policies)', () => {
  const target = 'deploy/local/minikube';
  /** The gaps the mutation ADDS (the real tree's own gaps are the suite above's business). */
  const newGaps = (policies: Doc[]): string[] => {
    const before = new Set(allGaps(target));
    return allGaps(target, topology(target, policies)).filter((g) => !before.has(g));
  };

  it('dropping sa/message from billing-allow is reported as message -> billing', () => {
    const policies = structuredClone(policiesOf(target));
    const allow = policies.find((p) => p.metadata.name === 'billing-allow')!;
    for (const r of allow.spec.rules) {
      for (const f of r.from) f.source.principals = f.source.principals.filter((p: string) => p !== principalOf('message'));
    }
    const gaps = newGaps(policies);
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.every((g) => g.startsWith('message -> billing'))).toBe(true);
    expect(gaps.join('\n')).toContain('billing.consumeSupportIncident');
  });

  it('dropping a caller from a waypoint DENY notPrincipals list is reported', () => {
    const policies = structuredClone(policiesOf(target));
    const deny = policies.find((p) => p.metadata.name === 'platform-internal-offers')!;
    for (const r of deny.spec.rules) {
      for (const f of r.from) f.source.notPrincipals = f.source.notPrincipals.filter((p: string) => p !== principalOf('billing'));
    }
    const gaps = newGaps(policies);
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.every((g) => g.startsWith('billing -> platform') && g.includes('DENY platform-internal-offers'))).toBe(true);
  });

  it('matches Istio paths: exact, prefix, suffix, and nothing in the middle', () => {
    expect(istioMatch('/internal/ops/*', '/internal/ops/org-account-root/p4r4m')).toBe(true);
    expect(istioMatch('*/increment', '/quotas/p4r4m/increment')).toBe(true);
    expect(istioMatch('/audit/events', '/audit/events')).toBe(true);
    expect(istioMatch('/audit/events', '/audit/events/x')).toBe(false);
    expect(istioMatch('/quotas/*/increment', '/quotas/p4r4m/increment')).toBe(false);
  });
});
