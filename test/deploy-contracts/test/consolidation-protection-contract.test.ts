// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * EKS Auto Mode (Karpenter) repacks under-used nodes. A database that runs as
 * one replica on one EBS volume can't survive that: its PodDisruptionBudget is
 * `maxUnavailable: 1` (a `minAvailable: 1` budget would block every drain), so
 * the budget lets consolidation evict the only copy, and the move is an outage.
 * That happened to postgres ("Evicted pod: Underutilized").
 *
 * On eks every single-replica database therefore carries
 * `karpenter.sh/do-not-disrupt`. The ec2 and minikube targets are single-node
 * minikube with no Karpenter, so the marker would do nothing there and must not
 * be copied in.
 */

import { readdirSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';
import { REPO_ROOT, K8S_TARGETS, yamlDocs } from '../src/index.js';

type Workload = {
  kind?: string;
  metadata?: { name?: string };
  spec?: {
    replicas?: number;
    template?: { metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> } };
  };
};

const MARKER = 'karpenter.sh/do-not-disrupt';

/** Every Deployment and StatefulSet in one target's k8s tree. */
function workloads(target: string): Array<Workload & { file: string }> {
  const dir = `${target}/k8s`;
  return readdirSync(join(REPO_ROOT, dir))
    .filter((f) => f.endsWith('.yaml'))
    .flatMap((f) => yamlDocs<Workload>(`${dir}/${f}`).map((d) => ({ ...d, file: f })))
    .filter((d) => d.kind === 'Deployment' || d.kind === 'StatefulSet');
}

describe('consolidation protection', () => {
  it('eks: every single-replica database is marked do-not-disrupt', () => {
    const dbs = workloads('deploy/aws/eks').filter(
      (w) => w.spec?.replicas === 1
        && w.spec.template?.metadata?.labels?.['app.kubernetes.io/component'] === 'database',
    );
    // postgres and mongodb today; a guard that matches nothing guards nothing.
    expect(dbs.map((w) => w.metadata?.name).sort()).toEqual(expect.arrayContaining(['mongodb', 'postgres']));
    for (const w of dbs) {
      expect({ name: w.metadata?.name, marker: w.spec?.template?.metadata?.annotations?.[MARKER] })
        .toEqual({ name: w.metadata?.name, marker: 'true' });
    }
  });

  it.each(K8S_TARGETS.filter((t) => t !== 'deploy/aws/eks'))('%s: carries no Karpenter marker', (target) => {
    const marked = workloads(target)
      .filter((w) => w.spec?.template?.metadata?.annotations?.[MARKER] !== undefined)
      .map((w) => `${w.file}:${w.metadata?.name}`);
    expect(marked).toEqual([]);
  });

  it('eks: the platform NodePool waits out a scaling burst before consolidating', () => {
    const pool = yamlDocs<{ kind?: string; metadata?: { name?: string }; spec?: { disruption?: { consolidateAfter?: string } } }>(
      'deploy/aws/eks/cluster/nodepool.yaml',
    ).find((d) => d.kind === 'NodePool' && d.metadata?.name === 'pipeline-builder');
    const after = pool?.spec?.disruption?.consolidateAfter ?? '';
    const m = after.match(/^(\d+)([smh])$/);
    expect(m).not.toBeNull();
    const seconds = Number(m![1]) * { s: 1, m: 60, h: 3600 }[m![2] as 's' | 'm' | 'h'];
    expect(seconds).toBeGreaterThanOrEqual(600);
  });
});
