// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform's Kubernetes RBAC: the PVC auto-expand and Postgres rung Roles.
 *
 * Platform holds the user-token signing key, so its ServiceAccount is the one
 * whose blast radius matters most. Both Roles grant `patch`, and both act on a
 * name that arrives from outside platform's own code path (an Alertmanager
 * label for the claim) or could be widened by a careless edit. So each rule is
 * pinned by `resourceNames` to exactly what the code targets, and this suite
 * keeps those lists in lockstep with the manifests and the source:
 *
 *   - A rule WITHOUT resourceNames reopens the whole namespace (patch any
 *     Deployment, including platform's own image).
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
const platformDocs = (target: string) => yamlDocs<Doc>(`${target}/k8s/platform.yaml`);
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

describe('platform RBAC is pinned by resourceNames', () => {
  it.each(K8S_TARGETS)('%s: every rule of every platform Role names its objects', (target) => {
    const roles = platformDocs(target).filter((d) => d.kind === 'Role');
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
    expect(platformDocs(target).map((d) => d.kind)).not.toContain('ClusterRole');
  });

  it.each(K8S_TARGETS)('%s: postgres-rung grants exactly the workloads services/postgres-rung.ts patches', (target) => {
    const src = read('platform/src/services/postgres-rung.ts');
    const targets = [...src.matchAll(/\{\s*kind:\s*'(deployments|statefulsets)',\s*name:\s*'([^']+)'/g)].map((m) => `${m[1]}/${m[2]}`).sort();
    expect(targets).toEqual(['deployments/postgres', 'statefulsets/postgres-replica']);

    const role = roleOf(platformDocs(target), 'platform-postgres-rung')!;
    const granted = (role.rules as Doc[]).flatMap((r) => {
      expect(r.apiGroups).toEqual(['apps']);
      expect([...r.verbs].sort()).toEqual(['get', 'patch']);
      return (r.resources as string[]).flatMap((res) => (r.resourceNames as string[]).map((n) => `${res}/${n}`));
    }).sort();
    expect(granted).toEqual(targets);
    expect(bindingOf(platformDocs(target), 'platform-postgres-rung')!.subjects).toEqual([{ kind: 'ServiceAccount', name: 'platform', namespace: NS }]);
  });

  it('keeps platform-postgres-rung identical across the three targets', () => {
    const [first, ...rest] = K8S_TARGETS.map((t) => roleOf(platformDocs(t), 'platform-postgres-rung'));
    for (const r of rest) expect(r).toEqual(first);
  });

  it('pvc-autoexpand exists on eks only', () => {
    expect(roleOf(platformDocs('deploy/aws/ec2'), 'platform-pvc-autoexpand')).toBeUndefined();
    expect(roleOf(platformDocs('deploy/local/minikube'), 'platform-pvc-autoexpand')).toBeUndefined();
  });

  it('eks pvc-autoexpand grants exactly the claims the eks tree creates', () => {
    const role = roleOf(platformDocs('deploy/aws/eks'), 'platform-pvc-autoexpand')!;
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
