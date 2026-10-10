// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The ask-model business-hours schedule: two CronJobs that scale the
 * self-hosted model to 1 at the start of the window and to 0 at the end.
 *
 * On eks this is the largest single lever on the bill — ask-model owns a
 * dedicated GPU node (~$384/month of g4dn at 24/7), and scaling the Deployment
 * to 0 is what lets Karpenter take the node away. On ec2 it frees RAM on the
 * shared instance and saves nothing, which is why the two trees default the
 * knob differently.
 *
 * Everything asserted here fails SILENTLY and EXPENSIVELY, which is the whole
 * reason it is a test:
 *
 *   - SWAPPED REPLICA COUNTS. `--replicas=0` on the up-job and `1` on the
 *     down-job is a one-character-per-side edit that reads fine, applies
 *     cleanly, and holds a GPU node overnight while making Ask unusable all
 *     day. Nothing else in the stack would notice.
 *   - AN INVERTED WINDOW (down before up). Same outcome, no error anywhere.
 *   - A PINNED `replicas` ON ask-model. With one, every apply of the tree
 *     resets the count to 1 — so a deploy at 02:00 UTC brings the GPU node up
 *     and holds it until the next down-job. The schedule looks installed and
 *     silently does not hold.
 *   - A RENAMED SCALER. ec2's LEAN mode drops ask-model by passing the name
 *     `ask-model` to pb_lean_filter, which SUFFIX-matches (`^(names)(-.*)?$`).
 *     A CronJob called `model-scaler-up` escapes that and fires daily in a
 *     cluster that deliberately has no ask-model to scale.
 *   - A MISSING SED TOKEN. The schedule is configured from .env, and `schedule`
 *     is a CronJob SPEC field, so it cannot come from a ConfigMap — it is
 *     substituted at apply time. A manifest token with no matching substitution
 *     in the apply script reaches the API server as the literal string
 *     `${ASK_SCHEDULE_UP}` and the apply fails; the reverse (a substitution for
 *     a token nothing uses) is dead configuration an operator will still tune.
 *   - DRIFT between the two standalone copies, which is the standing hazard of
 *     this repo's no-shared-base rule.
 */

import { describe, it, expect } from '@jest/globals';
import { read, yamlDocs } from '../src/index.js';

type Doc = Record<string, any>;

/** The two targets that ship the schedule, with the script that applies it. */
const TARGETS = [
  { target: 'deploy/aws/eks', applyScript: 'deploy/aws/eks/bin/setup.sh', envDefault: 'true' },
  { target: 'deploy/aws/ec2', applyScript: 'deploy/aws/ec2/bin/startup.sh', envDefault: 'false' },
] as const;

const SCHEDULE_FILE = 'k8s/ask-model-schedule.yaml';
const TOKENS = ['ASK_SCHEDULE_UP', 'ASK_SCHEDULE_DOWN', 'ASK_SCHEDULE_SUSPEND'] as const;

const docsOf = (target: string) => yamlDocs<Doc>(`${target}/${SCHEDULE_FILE}`);
const cronOf = (docs: Doc[], name: string) => docs.find((d) => d.kind === 'CronJob' && d.metadata.name === name)!;
const scaleArgs = (cj: Doc): string[] => cj.spec.jobTemplate.spec.template.spec.containers[0].args;

/** `--replicas=N` from a kubectl scale argv, or null if it is not there. */
function replicaArg(cj: Doc): number | null {
  const a = scaleArgs(cj).find((x) => x.startsWith('--replicas='));
  return a ? Number(a.slice('--replicas='.length)) : null;
}

/** Minutes-of-day for a `M H * * …` cron, or null when either field is not a plain number. */
function minuteOfDay(cron: string): number | null {
  const [m, h] = cron.trim().split(/\s+/);
  if (!/^\d+$/.test(m ?? '') || !/^\d+$/.test(h ?? '')) return null;
  return Number(h) * 60 + Number(m);
}

describe.each(TARGETS)('$target — ask-model schedule', ({ target, applyScript, envDefault }) => {
  const docs = docsOf(target);

  it('ships all five documents (guards a vacuous pass)', () => {
    expect(docs.map((d) => `${d.kind}/${d.metadata.name}`).sort()).toEqual([
      'CronJob/ask-model-down',
      'CronJob/ask-model-up',
      'Role/ask-model-scaler',
      'RoleBinding/ask-model-scaler',
      'ServiceAccount/ask-model-scaler',
    ]);
  });

  it('is applied by the target (listed in the kustomization)', () => {
    // A manifest that is not in `resources:` is a file nobody renders.
    expect(read(`${target}/k8s/kustomization.yaml`)).toContain('ask-model-schedule.yaml');
  });

  it('scales UP to exactly 1 and DOWN to exactly 0, not the reverse', () => {
    // The failure this exists for: swapping them is invisible and holds a GPU
    // node overnight while leaving Ask unusable in working hours.
    expect(replicaArg(cronOf(docs, 'ask-model-up'))).toBe(1);
    expect(replicaArg(cronOf(docs, 'ask-model-down'))).toBe(0);
  });

  it('targets the ask-model Deployment by name from both jobs', () => {
    for (const name of ['ask-model-up', 'ask-model-down']) {
      const args = scaleArgs(cronOf(docs, name));
      expect(args).toContain('deployment/ask-model');
      expect(args).toContain('pipeline-builder');
    }
  });

  it('takes its window from .env, with no hardcoded cron left behind', () => {
    const up = cronOf(docs, 'ask-model-up');
    const down = cronOf(docs, 'ask-model-down');
    expect(up.spec.schedule).toBe('${ASK_SCHEDULE_UP}');
    expect(down.spec.schedule).toBe('${ASK_SCHEDULE_DOWN}');
    // `suspend` carries the operator's on/off switch, inverted by
    // pb_ask_schedule_env — sed cannot negate, so the polarity flip has to
    // happen in the shell and this token must not be hand-written as a literal.
    expect(up.spec.suspend).toBe('${ASK_SCHEDULE_SUSPEND}');
    expect(down.spec.suspend).toBe('${ASK_SCHEDULE_SUSPEND}');
  });

  it('has every one of its tokens substituted by the apply script', () => {
    const script = read(applyScript);
    for (const token of TOKENS) {
      // Unsubstituted, the literal `${ASK_SCHEDULE_UP}` reaches the API server
      // and the apply of the whole stream fails.
      expect([token, script.includes(`{${token}}|`)]).toEqual([token, true]);
    }
    // And the resolver runs BEFORE the apply, so a bad value fails the deploy
    // rather than being rejected as one doc partway through it.
    expect(script).toContain('pb_ask_schedule_env');
    expect(script.indexOf('pb_ask_schedule_env')).toBeLessThan(script.indexOf('pb_apply_manifests "$K8S_DIR"'));
  });

  it('keeps the scaler RBAC least-privilege: one Deployment, by name', () => {
    const role = docs.find((d) => d.kind === 'Role')!;
    // Namespaced Role, never ClusterRole — a scheduler has no business
    // outside its own namespace.
    expect(role.kind).toBe('Role');
    expect(role.rules).toHaveLength(1);
    const [rule] = role.rules;
    expect(rule.apiGroups).toEqual(['apps']);
    expect(rule.resourceNames).toEqual(['ask-model']);
    expect([...rule.resources].sort()).toEqual(['deployments', 'deployments/scale']);
    // No `delete`, and nothing creating pods of its own choosing.
    expect([...rule.verbs].sort()).toEqual(['get', 'patch', 'update']);
  });

  it('grants that Role to the ServiceAccount the jobs actually run as', () => {
    const rb = docs.find((d) => d.kind === 'RoleBinding')!;
    const sa = docs.find((d) => d.kind === 'ServiceAccount')!;
    expect(rb.roleRef.name).toBe(docs.find((d) => d.kind === 'Role')!.metadata.name);
    expect(rb.subjects).toEqual([{ kind: 'ServiceAccount', name: sa.metadata.name, namespace: 'pipeline-builder' }]);
    for (const name of ['ask-model-up', 'ask-model-down']) {
      expect(cronOf(docs, name).spec.jobTemplate.spec.template.spec.serviceAccountName).toBe(sa.metadata.name);
    }
  });

  it('names every document `ask-model…`, so ec2 LEAN drops them with ask-model', () => {
    // pb_lean_filter matches `^(names)(-.*)?$` against the doc name, so the
    // extra name `ask-model` only reaches these while they keep that prefix.
    for (const d of docs) expect([d.metadata.name, /^ask-model(-.*)?$/.test(d.metadata.name)]).toEqual([d.metadata.name, true]);
  });

  it('runs the scalers unprivileged and read-only', () => {
    for (const name of ['ask-model-up', 'ask-model-down']) {
      const pod = cronOf(docs, name).spec.jobTemplate.spec.template.spec;
      expect(pod.securityContext.runAsNonRoot).toBe(true);
      expect(pod.restartPolicy).toBe('Never');
      const c = pod.containers[0];
      expect(c.securityContext.allowPrivilegeEscalation).toBe(false);
      expect(c.securityContext.readOnlyRootFilesystem).toBe(true);
      expect(c.securityContext.capabilities.drop).toEqual(['ALL']);
      // Digest-pinned like every other image in these trees.
      expect(c.image).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  it('leaves ask-model with NO pinned `replicas`, or the schedule does not hold', () => {
    const dep = yamlDocs<Doc>(`${target}/k8s/ask-model.yaml`).find((d) => d.kind === 'Deployment' && d.metadata.name === 'ask-model')!;
    expect(dep).toBeDefined();
    // With `replicas` pinned, every apply of this tree resets the count and a
    // deploy inside the off-window silently brings the model back up.
    expect(dep.spec.replicas).toBeUndefined();
  });

  it('declares the three knobs in .env.example, with a valid default window', () => {
    const env = read(`${target}/.env.example`);
    const value = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1];
    // Uncommented, so an operator sees the live window without reading a manifest.
    expect(value('ASK_SCHEDULE_ENABLED')).toBe(envDefault);
    for (const k of ['ASK_SCHEDULE_UP', 'ASK_SCHEDULE_DOWN']) {
      const v = value(k);
      expect([k, v]).not.toEqual([k, undefined]);
      // Five fields, or the API server rejects it mid-apply.
      expect([k, v!.trim().split(/\s+/)]).toEqual([k, expect.arrayContaining([expect.any(String)])]);
      expect([k, v!.trim().split(/\s+/).length]).toEqual([k, 5]);
    }
  });

  it('opens the window before it closes', () => {
    const up = minuteOfDay(read(`${target}/.env.example`).match(/^ASK_SCHEDULE_UP=(.*)$/m)![1]);
    const down = minuteOfDay(read(`${target}/.env.example`).match(/^ASK_SCHEDULE_DOWN=(.*)$/m)![1]);
    // Only meaningful for plain numeric minute/hour fields; a range or step
    // expression is the operator's business.
    if (up === null || down === null) return;
    expect(up).toBeLessThan(down);
  });
});

describe('ask-model schedule — the two standalone copies do not drift', () => {
  it('renders byte-identical DOCUMENTS in eks and ec2 (headers may differ)', () => {
    // The trees are deliberately standalone (no shared kustomize base), so a
    // drift test is the only thing keeping the specs in step. The prose headers
    // are expected to differ: the saving is real on eks and is not on ec2.
    const [eks, ec2] = [docsOf('deploy/aws/eks'), docsOf('deploy/aws/ec2')];
    expect(ec2).toEqual(eks);
  });

  it('is dropped whole by LEAN, CronJobs included', () => {
    // The bug this caught: pb_lean_filter's kind list had no CronJob, so ec2's
    // `LEAN=1 … ask-model` dropped the Deployment and the ServiceAccount but
    // KEPT both CronJobs — firing daily against a ServiceAccount that no
    // longer existed, to scale a Deployment that was never applied.
    const filter = read('deploy/bin/k8s-resources.sh');
    const kinds = filter.match(/kd ~ \/\^\(([^)]*)\)\$\//)![1].split('|');
    expect(kinds).toContain('CronJob');
    expect(kinds).toContain('ServiceAccount');
    expect(kinds).toContain('Role');
  });
});
