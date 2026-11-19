// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The operations control plane's Kubernetes RBAC: the PVC auto-expand and
 * Postgres rung Roles, bound to the ops-center ServiceAccount.
 *
 * Both controllers used to run inside platform. They moved to ops-center
 * with the rest of the operations code, and so did their Roles — platform holds
 * the user-token signing key, and the identity that can mint a person's session
 * must not also be able to patch cluster objects. So this suite asserts BOTH
 * halves: the Roles exist on ops-center with their pins intact, and platform
 * has no RBAC left at all.
 *
 * Both Roles grant `patch`, and both act on a name that arrives from outside the
 * controller's own code path (an Alertmanager label for the claim) or could be
 * widened by a careless edit. So each rule is pinned by `resourceNames` to
 * exactly what the code targets, and this suite keeps those lists in lockstep
 * with the manifests and the source:
 *
 *   - A rule WITHOUT resourceNames reopens the whole namespace (patch any
 *     Deployment, including ops-center's own image).
 *   - A claim added to the tree but not to the list is silently never
 *     expanded (403), and the storage alert just keeps firing.
 *   - A rung TARGET renamed in services/postgres-rung.ts but not here breaks
 *     the vertical ladder with a 403 at the worst moment (under saturation).
 */

import { readdirSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';
import { K8S_TARGETS, REPO_ROOT, read, yamlDocs } from '../src/index.js';

type Doc = Record<string, any>;

const NS = 'pipeline-builder';
const SA = 'ops-center';
const opsDocs = (target: string) => yamlDocs<Doc>(`${target}/k8s/ops-center.yaml`);
const platformDocs = (target: string) => yamlDocs<Doc>(`${target}/k8s/platform.yaml`);

/**
 * The rung controller's source (moved from platform to ops-center with the
 * split). The assertion below pins the manifests to
 * whatever TARGETS the shipped controller actually names.
 */
const RUNG_SRC = 'api/ops-center/src/services/postgres-rung.ts';
const roleOf = (docs: Doc[], name: string) => docs.find((d) => d.kind === 'Role' && d.metadata.name === name);
const bindingOf = (docs: Doc[], name: string) => docs.find((d) => d.kind === 'RoleBinding' && d.metadata.name === name);

const EKS_K8S = 'deploy/aws/eks/k8s';

/** Every eks manifest that declares a PersistentVolumeClaim or a volumeClaimTemplate. */
function claimManifests(): string[] {
  return readdirSync(join(REPO_ROOT, EKS_K8S))
    .filter((f) => f.endsWith('.yaml'))
    .filter((f) => {
      const text = read(`${EKS_K8S}/${f}`);
      return /^kind: PersistentVolumeClaim$/m.test(text) || /^\s*volumeClaimTemplates:/m.test(text);
    });
}

/** Every claim the eks tree can create: standalone PVCs plus StatefulSet template claims. */
function eksClaims(): string[] {
  const env = read('deploy/aws/eks/.env.example');
  const replicaMax = Number(/^PG_READ_REPLICA_MAX=(\d+)/m.exec(env)![1]);
  const claims: string[] = [];
  for (const f of claimManifests()) {
    for (const d of yamlDocs<Doc>(`${EKS_K8S}/${f}`)) {
      if (d.kind === 'PersistentVolumeClaim') claims.push(d.metadata.name);
      if (d.kind === 'StatefulSet') {
        // postgres-replica's count is KEDA's (no static replicas); bound it by
        // the configured ceiling.
        const n = d.metadata.name === 'postgres-replica' ? replicaMax : d.spec.replicas;
        for (const t of d.spec.volumeClaimTemplates ?? []) {
          for (let i = 0; i < n; i++) claims.push(`${t.metadata.name}-${d.metadata.name}-${i}`);
        }
      }
    }
  }
  return claims.sort();
}

describe('ops-center RBAC is pinned by resourceNames', () => {
  it.each(K8S_TARGETS)('%s: every rule of every ops-center Role names its objects', (target) => {
    const roles = opsDocs(target).filter((d) => d.kind === 'Role');
    expect(roles.length).toBeGreaterThan(0);
    for (const role of roles) {
      expect(role.metadata.namespace).toBe(NS);
      for (const rule of role.rules as Doc[]) {
        expect(Array.isArray(rule.resourceNames) && rule.resourceNames.length > 0).toBe(true);
        expect(rule.verbs).not.toContain('*');
        expect(rule.verbs).not.toContain('delete');
        expect(rule.verbs).not.toContain('create');
      }
    }
    expect(opsDocs(target).map((d) => d.kind)).not.toContain('ClusterRole');
    expect(opsDocs(target).map((d) => d.kind)).not.toContain('ClusterRoleBinding');
  });

  it.each(K8S_TARGETS)('%s: binds every Role to the ops-center ServiceAccount and nothing else', (target) => {
    const docs = opsDocs(target);
    const roles = docs.filter((d) => d.kind === 'Role').map((d) => d.metadata.name).sort();
    const bindings = docs.filter((d) => d.kind === 'RoleBinding');
    expect(bindings.map((b) => b.roleRef.name).sort()).toEqual(roles);
    for (const b of bindings) {
      expect(b.metadata.namespace).toBe(NS);
      expect(b.roleRef).toEqual({ kind: 'Role', name: b.metadata.name, apiGroup: 'rbac.authorization.k8s.io' });
      expect(b.subjects).toEqual([{ kind: 'ServiceAccount', name: SA, namespace: NS }]);
    }
  });

  it.each(K8S_TARGETS)('%s: mounts the ServiceAccount token the controllers authenticate with', (target) => {
    // k8s-client.ts reads /var/run/secrets/kubernetes.io/serviceaccount/token;
    // with automount off the Role is granted and unusable, and every rung or
    // expansion attempt fails before it reaches the API server.
    const dep = opsDocs(target).find((d) => d.kind === 'Deployment')!;
    expect(dep.spec.template.spec.serviceAccountName).toBe(SA);
    expect(dep.spec.template.spec.automountServiceAccountToken).toBe(true);
  });

  it.each(K8S_TARGETS)('%s: trusts the cluster CA the API server certificate chains to', (target) => {
    // k8s-client.ts calls the API server with the global fetch, which only
    // trusts Node's default roots. Without the projected ca.crt every request
    // dies in the TLS handshake ("fetch failed", UNABLE_TO_VERIFY_LEAF_SIGNATURE)
    // — RBAC, token and NetworkPolicy all correct, and still nothing scales.
    const dep = opsDocs(target).find((d) => d.kind === 'Deployment')!;
    const c = (dep.spec.template.spec.containers as Doc[]).find((x) => x.name === 'ops-center')!;
    const env = (c.env as Doc[]).find((e) => e.name === 'NODE_EXTRA_CA_CERTS');
    expect(env?.value).toBe('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
  });

  it.each(K8S_TARGETS)('%s: platform holds NO Kubernetes RBAC and mounts no token', (target) => {
    // The identity hub holds the user-token signing key; it must not also be
    // able to patch a cluster object. The controllers that needed RBAC moved out.
    const kinds = platformDocs(target).map((d) => d.kind);
    for (const k of ['Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding']) expect([k, kinds.includes(k)]).toEqual([k, false]);
    const dep = platformDocs(target).find((d) => d.kind === 'Deployment')!;
    expect(dep.spec.template.spec.automountServiceAccountToken).toBe(false);
    // …and no other manifest in the tree binds anything to sa/platform.
    for (const f of readdirSync(join(REPO_ROOT, target, 'k8s')).filter((x) => x.endsWith('.yaml'))) {
      for (const d of yamlDocs<Doc>(`${target}/k8s/${f}`)) {
        if (d.kind !== 'RoleBinding' && d.kind !== 'ClusterRoleBinding') continue;
        const subjects = (d.subjects ?? []) as Doc[];
        expect([f, d.metadata.name, subjects.some((s) => s.kind === 'ServiceAccount' && s.name === 'platform')]).toEqual([f, d.metadata.name, false]);
      }
    }
  });

  it.each(K8S_TARGETS)('%s: lets ops-center — and not platform — reach the API server', (target) => {
    const np = yamlDocs<Doc>(`${target}/k8s/networkpolicy.yaml`).find((d) => d.kind === 'NetworkPolicy' && d.metadata.name === 'allow-kube-api-egress')!;
    const values = (np.spec.podSelector.matchExpressions as Doc[]).flatMap((e) => e.values as string[]);
    expect(values).toContain(SA);
    expect(values).not.toContain('platform');
  });

  it.each(K8S_TARGETS)('%s: postgres-rung grants exactly the workloads services/postgres-rung.ts patches', (target) => {
    const src = read(RUNG_SRC);
    const targets = [...src.matchAll(/\{\s*kind:\s*'(deployments|statefulsets)',\s*name:\s*'([^']+)'/g)].map((m) => `${m[1]}/${m[2]}`).sort();
    expect(targets).toEqual(['deployments/postgres', 'statefulsets/postgres-replica']);

    const role = roleOf(opsDocs(target), 'ops-center-postgres-rung')!;
    const granted = (role.rules as Doc[]).flatMap((r) => {
      expect(r.apiGroups).toEqual(['apps']);
      expect([...r.verbs].sort()).toEqual(['get', 'patch']);
      return (r.resources as string[]).flatMap((res) => (r.resourceNames as string[]).map((n) => `${res}/${n}`));
    }).sort();
    expect(granted).toEqual(targets);
    expect(bindingOf(opsDocs(target), 'ops-center-postgres-rung')!.subjects).toEqual([{ kind: 'ServiceAccount', name: SA, namespace: NS }]);
  });

  it('keeps ops-center-postgres-rung identical across the three targets', () => {
    const [first, ...rest] = K8S_TARGETS.map((t) => roleOf(opsDocs(t), 'ops-center-postgres-rung'));
    expect(first).toBeDefined();
    for (const r of rest) expect(r).toEqual(first);
  });

  it('pvc-autoexpand exists on eks only', () => {
    expect(roleOf(opsDocs('deploy/aws/ec2'), 'ops-center-pvc-autoexpand')).toBeUndefined();
    expect(roleOf(opsDocs('deploy/local/minikube'), 'ops-center-pvc-autoexpand')).toBeUndefined();
    expect(roleOf(opsDocs('deploy/aws/eks'), 'ops-center-pvc-autoexpand')).toBeDefined();
  });

  it('eks pvc-autoexpand grants exactly the claims the eks tree creates', () => {
    const role = roleOf(opsDocs('deploy/aws/eks'), 'ops-center-pvc-autoexpand')!;
    expect(role.rules).toHaveLength(1);
    const [rule] = role.rules;
    expect(rule.apiGroups).toEqual(['']);
    expect(rule.resources).toEqual(['persistentvolumeclaims']);
    expect([...rule.verbs].sort()).toEqual(['get', 'patch']);
    expect([...rule.resourceNames].sort()).toEqual(eksClaims());
  });

  it('finds the claim-bearing manifests it expects (guards the scan itself)', () => {
    expect(claimManifests().length).toBeGreaterThanOrEqual(10);
    expect(eksClaims()).toContain('postgres-data');
    expect(eksClaims()).toContain('data-rustfs-0');
  });
});
