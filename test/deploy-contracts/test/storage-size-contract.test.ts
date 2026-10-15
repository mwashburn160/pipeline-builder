// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Persistent volume sizes: one number per target, and no silent drift.
 *
 * Every durable volume on a target declares the SAME size — 1Gi on the local
 * target, 20Gi on the two AWS targets. The point is not capacity planning. It
 * is that a one-off number is unreadable: when postgres asked for 1Gi next to
 * a 20Gi prometheus, nothing recorded whether that was a deliberate sizing
 * decision or a value nobody had revisited, and the answer turned out to be
 * the latter on three separate volumes. A single per-target figure means any
 * deviation is visible, and this file makes it fail the build instead.
 *
 * What each assertion is actually defending:
 *
 *   - A LOCAL SIZE LEAKING INTO AWS, or the reverse. These trees are
 *     standalone by design (no shared kustomize base), so the same volume is
 *     declared three times and a copy-paste between them is the normal way
 *     this breaks. On the AWS targets the figure is enforced by a real CSI, so
 *     a 1Gi postgres there is a database that stops writing.
 *   - A PV AND ITS PVC DISAGREEING. The local and ec2 targets bind manually:
 *     a PVC requesting more than its PV offers stays Pending forever and the
 *     workload never starts, with the PVC's own description being the only
 *     place that says so.
 *   - THE EXCEPTIONS GOING UNDOCUMENTED. ask-model is deliberately NOT 1Gi
 *     locally: it holds a pulled ollama model, ~1-5GB for the quantized
 *     qwen2.5-coder:1.5b this target runs, so the uniform figure would be a
 *     volume the model does not fit in. That is a real exception and it is
 *     listed below with its reason; what this guards is a FOURTH value
 *     appearing with no reason recorded anywhere.
 *   - AN EMPTY SWEEP PASSING. If the walker stops finding volumes — a key
 *     renamed, a file moved — every assertion above becomes vacuously true.
 *     The counts below fail instead.
 *
 * Out of scope on purpose: emptyDir `sizeLimit` and container
 * `ephemeral-storage` limits. Those are kubelet-enforced POD scratch caps
 * (plugin builds need 20Gi of it), not durable volumes, and flattening them to
 * the uniform figure would break image builds.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from '@jest/globals';
import { parseAllDocuments } from 'yaml';
import { read, REPO_ROOT, K8S_TARGETS } from '../src/index.js';

/** The one size every durable volume on a target declares. */
const EXPECTED: Record<string, string> = {
  'deploy/local/minikube': '1Gi',
  'deploy/aws/ec2': '20Gi',
  'deploy/aws/eks': '20Gi',
};

/**
 * Volumes that deliberately diverge, with the reason. A new entry here is a
 * decision; a new value NOT here is a bug.
 */
const EXCEPTIONS: Record<string, { size: string; why: string }> = {
  'deploy/local/minikube:ask-model':
    { size: '8Gi', why: 'holds the pulled ollama model (~1-5GB); the uniform 1Gi would not fit it' },
};

type Found = { file: string; kind: string; where: 'capacity' | 'requests'; size: string };

/** Every `capacity.storage` / `requests.storage` in a target, with its source. */
function volumesOf(target: string): Found[] {
  const dir = join(REPO_ROOT, target, 'k8s');
  const found: Found[] = [];

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()) {
    for (const doc of parseAllDocuments(read(`${target}/k8s/${file}`))) {
      const root = doc.toJSON() as Record<string, any> | null;
      if (!root) continue;

      // Recurse: a volumeClaimTemplate's request sits several levels inside a
      // StatefulSet, and flow-style YAML (`requests: { storage: 1Gi }`) reads
      // identically once parsed — which is exactly how two volumes were missed
      // by a line-oriented scan of these same files.
      const walk = (node: unknown, path: string[]): void => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach((v, i) => walk(v, [...path, String(i)]));
          return;
        }
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          const parent = path[path.length - 1];
          if (key === 'storage' && (parent === 'capacity' || parent === 'requests')) {
            found.push({
              file: file.replace(/\.yaml$/, ''),
              kind: String(root.kind),
              where: parent === 'capacity' ? 'capacity' : 'requests',
              size: String(value),
            });
          }
          walk(value, [...path, key]);
        }
      };
      walk(root, []);
    }
  }
  return found;
}

const expectedFor = (target: string, file: string): string =>
  EXCEPTIONS[`${target}:${file}`]?.size ?? EXPECTED[target];

describe.each(K8S_TARGETS)('%s — persistent volume sizes', (target) => {
  const volumes = volumesOf(target);

  it('finds the volumes at all (guards a vacuous pass)', () => {
    // Every target backs at least postgres, mongodb and prometheus; if the
    // sweep returns less than that it has stopped looking, not stopped finding.
    expect(volumes.length).toBeGreaterThanOrEqual(3);
    for (const name of ['postgres', 'mongodb', 'prometheus']) {
      expect(volumes.map((v) => v.file)).toContain(name);
    }
  });

  it('declares one size for every durable volume', () => {
    const wrong = volumes
      .filter((v) => v.size !== expectedFor(target, v.file))
      .map((v) => `${v.file} (${v.kind}.${v.where}) = ${v.size}, expected ${expectedFor(target, v.file)}`);
    expect(wrong).toEqual([]);
  });

  it('keeps every PV capacity equal to the PVC that binds it', () => {
    // Manual binding (local + ec2) leaves a PVC Pending forever if it asks for
    // more than its PV offers, and the pod simply never schedules.
    const byFile = new Map<string, Set<string>>();
    for (const v of volumes) {
      if (!byFile.has(v.file)) byFile.set(v.file, new Set());
      byFile.get(v.file)!.add(v.size);
    }
    const mismatched = [...byFile.entries()]
      .filter(([, sizes]) => sizes.size > 1)
      .map(([file, sizes]) => `${file}: ${[...sizes].join(' vs ')}`);
    expect(mismatched).toEqual([]);
  });

  it('records a reason for every size that is not the target figure', () => {
    const unexplained = volumes
      .filter((v) => v.size !== EXPECTED[target])
      .filter((v) => (EXCEPTIONS[`${target}:${v.file}`]?.why ?? '').length < 20)
      .map((v) => `${v.file} declares ${v.size} with no recorded reason`);
    expect(unexplained).toEqual([]);
  });
});

describe('cross-target', () => {
  it('gives the two AWS targets the same figure', () => {
    // They are separate trees on purpose, so nothing but this keeps them equal.
    expect(EXPECTED['deploy/aws/eks']).toBe(EXPECTED['deploy/aws/ec2']);
  });

  it('never lets an AWS size appear on the local target, or the reverse', () => {
    const local = volumesOf('deploy/local/minikube').map((v) => v.size);
    const aws = volumesOf('deploy/aws/eks').map((v) => v.size);
    expect(local).not.toContain(EXPECTED['deploy/aws/eks']);
    expect(aws).not.toContain(EXPECTED['deploy/local/minikube']);
  });

  it('covers the same volumes on both AWS targets, or says why not', () => {
    // ec2 runs redis as an emptyDir while eks runs a redis-sentinel
    // StatefulSet with a PVC, and eks runs rustfs as a 4-pod StatefulSet
    // against ec2's single hostPath Deployment. Both are topology differences,
    // not size drift — but if either target silently LOSES a database volume
    // the diff below is where it shows up. grype-db is the same kind of
    // difference: eks shares ONE grype DB across its plugin replicas on an EFS
    // claim (written by a CronJob), where single-node ec2 keeps a per-pod
    // emptyDir.
    const filesOf = (t: string) => new Set(volumesOf(t).map((v) => v.file));
    const eks = filesOf('deploy/aws/eks');
    const ec2 = filesOf('deploy/aws/ec2');
    const EKS_ONLY = ['grype-db', 'redis-sentinel', 'rustfs'];
    expect([...eks].filter((f) => !ec2.has(f)).sort()).toEqual([...EKS_ONLY].sort());
    expect([...ec2].filter((f) => !eks.has(f))).toEqual([]);
  });
});

/**
 * The ec2 instance's own disk, against what the stack commits to it.
 *
 * ec2 has no CSI: every PV is a hostPath under /opt/pipeline/pipeline-data,
 * which is the DataVolume's mount, and minikube runs with --driver=docker
 * against a Docker data-root on that same volume — so the node's disk (and
 * every emptyDir inside the cluster with it) is a file there too. The volume
 * therefore carries the whole stack, and `DataVolumeSize` must stay at a
 * minimum of 2x that commitment.
 *
 * The reason this is a test and not a comment: `MinValue` was 50 while the
 * claims below it summed to 140, so CloudFormation would accept a volume that
 * could not hold the data even once. Raising a PV size without raising the
 * floor silently recreates that, and nothing else in the repo relates the two
 * numbers.
 */
describe('deploy/aws/ec2 — DataVolume sizing', () => {
  const template = read('deploy/aws/ec2/template.yaml');

  /** A CloudFormation Number parameter's named constraint. */
  const param = (name: string, field: 'Default' | 'MinValue' | 'MaxValue'): number => {
    const block = template.slice(template.indexOf(`  ${name}:`));
    const match = new RegExp(`^\\s+${field}:\\s*(\\d+)`, 'm').exec(block);
    expect(match).not.toBeNull();
    return Number(match![1]);
  };

  /** GiB of declared PV claims — counted once per volume, not once per PV+PVC pair. */
  const claimedGiB = (): number => {
    const byFile = new Map<string, number>();
    for (const v of volumesOf('deploy/aws/ec2')) {
      const match = /^(\d+)Gi$/.exec(v.size);
      expect(match).not.toBeNull();
      byFile.set(v.file, Number(match![1]));
    }
    return [...byFile.values()].reduce((a, b) => a + b, 0);
  };

  /** The minikube node disk from startup.sh — a file on this same volume. */
  const nodeDiskGiB = (): number => {
    const startup = read('deploy/aws/ec2/bin/startup.sh');
    const match = /DISK_SIZE="\$\{DISK_SIZE:-(\d+)g\}"/.exec(startup);
    expect(match).not.toBeNull();
    return Number(match![1]);
  };

  it('counts the commitment the way the template says it does', () => {
    // Guards the arithmetic in the template's own Description going stale.
    expect(claimedGiB()).toBe(140);
    expect(nodeDiskGiB()).toBe(80);
  });

  it('keeps MinValue at or above 2x the committed storage', () => {
    expect(param('DataVolumeSize', 'MinValue')).toBeGreaterThanOrEqual(2 * (claimedGiB() + nodeDiskGiB()));
  });

  it('ships a default no smaller than that floor', () => {
    const p = (f: 'Default' | 'MinValue' | 'MaxValue') => param('DataVolumeSize', f);
    expect(p('Default')).toBeGreaterThanOrEqual(p('MinValue'));
    expect(p('MaxValue')).toBeGreaterThanOrEqual(p('Default'));
  });

  it('never lets a documented recommendation fall below the floor', () => {
    // The deployment guide's recommendation table is what people actually
    // paste into `aws cloudformation deploy`; it recommended 200 and 250 GB
    // against a 440 floor, which CloudFormation would have rejected outright.
    const floor = param('DataVolumeSize', 'MinValue');
    const doc = read('docs/aws-deployment.md');
    const table = doc.slice(doc.indexOf('| Plugin strategy |'));
    const rows = table.slice(0, table.indexOf('\n\n')).split('\n').slice(2);
    const sizes = rows
      .map((r) => /\|\s*(\d+)\s*GB\s*\|/.exec(r))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThanOrEqual(3);
    expect(sizes.filter((s) => s < floor)).toEqual([]);
  });
});
