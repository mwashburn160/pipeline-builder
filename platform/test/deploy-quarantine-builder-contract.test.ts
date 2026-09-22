// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guard: the anonymous-submission QUARANTINE builder has no credential
 * path (docs/plans/plugin-ecosystem.md §4.2 "Isolated build pool", W5).
 *
 * The quarantine buildkitd runs Dockerfile RUN steps from zips uploaded by
 * people who have not logged in. Everything that keeps it harmless is a
 * deploy-file property that fails SILENTLY when it regresses — an `envFrom:
 * app-secrets` or a mounted service key would not break a single build, it
 * would just hand an anonymous build a credential. So each property is asserted
 * here, in every target:
 *   - k8s: its own ServiceAccount (no IRSA/Pod Identity annotation), token
 *     automount off on the SA and the pod, no env / envFrom, no Secret or
 *     hostPath volumes (only its emptyDir state + read-only buildkitd.toml),
 *     enableServiceLinks off, not privileged (the EKS enable-userns init is the
 *     one privileged container and runs busybox before any submission code);
 *     excluded from the namespace-wide internal-egress policy and given its own
 *     narrow egress; ingress from the plugin pod only; mesh-admitted only from
 *     sa/plugin.
 *   - compose: no environment, no volumes but its cache + read-only config,
 *     attached ONLY to quarantine-network, which holds no datastore.
 *   - the plugin service is pointed at it (never at the tenant buildkitd).
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse, parseAllDocuments } from 'yaml';

// Jest runs with cwd = `platform/`; the deploy tree is at the repo root.
const REPO_ROOT = join(process.cwd(), '..');
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf-8');

const K8S_TARGETS = ['deploy/local/minikube', 'deploy/aws/ec2', 'deploy/aws/eks'];
const ALL_TARGETS = ['deploy/local/docker', ...K8S_TARGETS];
const NAME = 'plugin-quarantine-builder';

type Doc = Record<string, any>;
const docsOf = (rel: string): Doc[] => parseAllDocuments(read(rel)).map((d) => d.toJSON()).filter(Boolean);
const find = (docs: Doc[], kind: string, name: string): Doc | undefined =>
  docs.find((d) => d.kind === kind && d.metadata?.name === name);

/** Names that must never reach the sandbox, in any form. */
const CREDENTIAL_PATTERN = /SECRET|TOKEN|PASSWORD|_KEY|AWS_|CODEBUILD_|DB_|REDIS|MONGO|S3_/;

describe.each(K8S_TARGETS)('quarantine builder has no credential path — %s', (target) => {
  const docs = docsOf(`${target}/k8s/${NAME}.yaml`);
  const deploy = find(docs, 'Deployment', NAME)!;
  const pod = deploy?.spec?.template?.spec ?? {};
  const containers: Doc[] = pod.containers ?? [];
  const inits: Doc[] = pod.initContainers ?? [];

  it('is in the kustomization', () => {
    expect(parse(read(`${target}/k8s/kustomization.yaml`)).resources).toContain(`${NAME}.yaml`);
  });

  it('runs under its own ServiceAccount with no token and no cloud identity', () => {
    const sa = find(docs, 'ServiceAccount', NAME);
    expect(sa).toBeDefined();
    expect(sa!.automountServiceAccountToken).toBe(false);
    // IRSA is an annotation; Pod Identity is an association keyed on the SA name
    // (created by setup scripts) — neither may name this SA.
    expect(Object.keys(sa!.metadata?.annotations ?? {}).filter((k) => k.includes('eks.amazonaws.com'))).toEqual([]);
    expect(pod.serviceAccountName).toBe(NAME);
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.enableServiceLinks).toBe(false);
    expect(pod.hostNetwork).toBeFalsy();
    expect(pod.hostPID).toBeFalsy();
    expect(pod.hostIPC).toBeFalsy();
  });

  it('has no env, no envFrom and no credential-looking variable in any container', () => {
    for (const c of [...containers, ...inits]) {
      expect(c.envFrom).toBeUndefined();
      expect(c.env ?? []).toEqual([]);
    }
    expect(JSON.stringify(deploy)).not.toMatch(/secretKeyRef|configMapKeyRef|app-secrets|app-env/);
  });

  it('mounts nothing but its own emptyDir state and its read-only buildkitd.toml', () => {
    const volumes: Doc[] = pod.volumes ?? [];
    for (const v of volumes) {
      expect(v.secret).toBeUndefined();
      expect(v.hostPath).toBeUndefined();
      expect(v.persistentVolumeClaim).toBeUndefined();
      expect(v.projected).toBeUndefined();
      expect(!!v.emptyDir || v.configMap?.name === `${NAME}-config`).toBe(true);
    }
    const config = containers[0].volumeMounts.find((m: Doc) => m.name === 'buildkitd-config');
    expect(config.readOnly).toBe(true);
  });

  it('runs rootless buildkitd unprivileged; only the EKS userns init is privileged, and it runs busybox', () => {
    expect(containers).toHaveLength(1);
    expect(containers[0].image).toMatch(/^moby\/buildkit@sha256:[0-9a-f]{64}\s*$|^moby\/buildkit@sha256:[0-9a-f]{64}$/);
    expect(containers[0].securityContext.privileged).toBeFalsy();
    expect(containers[0].securityContext.runAsUser).toBe(1000);
    expect(containers[0].securityContext.capabilities.drop).toEqual(['ALL']);
    for (const i of inits) {
      expect(i.name).toBe('enable-userns');
      expect(i.image).toMatch(/^busybox@sha256:/);
    }
    if (target !== 'deploy/aws/eks') expect(inits).toEqual([]);
  });

  it('carries no credential-looking config in its buildkitd.toml', () => {
    const toml = find(docs, 'ConfigMap', `${NAME}-config`)!.data['buildkitd.toml'] as string;
    expect(toml).not.toMatch(/auth|token|password|secret|ca\s*=|keypair/i);
  });

  it('is excluded from the namespace-wide internal egress and gets only its own narrow egress', () => {
    const np = docsOf(`${target}/k8s/networkpolicy.yaml`);
    const internal = find(np, 'NetworkPolicy', 'allow-internal-egress')!;
    expect(internal.spec.podSelector).toEqual({
      matchExpressions: [{ key: 'app', operator: 'NotIn', values: [NAME] }],
    });
    const egress = find(np, 'NetworkPolicy', `allow-${NAME}-egress`)!;
    const inCluster = egress.spec.egress[0].to.map((t: Doc) => t.podSelector);
    expect(inCluster[0].matchExpressions[0].values).toEqual(['registry', 'image-registry']);
    const pub = egress.spec.egress[1].to[0].ipBlock;
    // The shared public-egress shape (networkpolicy.yaml EGRESS SHAPE): the VPC,
    // LANs and CGNAT, plus IMDS and the container-credential agents exactly.
    expect(pub.except).toEqual(expect.arrayContaining(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.169.254/32', '169.254.170.0/24']));
    // No other policy names it (an extra allow would be additive).
    const others = np.filter((d) => d.metadata?.name !== `allow-${NAME}-egress` && d.metadata?.name !== `allow-${NAME}-ingress`
      && JSON.stringify(d.spec?.podSelector ?? {}).includes(NAME) && d.metadata?.name !== 'allow-internal-egress');
    expect(others.map((d) => d.metadata.name)).toEqual([]);
    const ingress = find(np, 'NetworkPolicy', `allow-${NAME}-ingress`)!;
    expect(ingress.spec.ingress).toEqual([{ from: [{ podSelector: { matchLabels: { app: 'plugin' } } }], ports: [{ port: 1234, protocol: 'TCP' }] }]);
  });

  it('admits only sa/plugin through the mesh, and is denied every waypoint route but /token', () => {
    const allow = find(docsOf(`${target}/k8s/istio.yaml`), 'AuthorizationPolicy', `${NAME}-allow`)!;
    expect(allow.spec.rules).toEqual([{
      from: [{ source: { principals: ['cluster.local/ns/pipeline-builder/sa/plugin'] } }],
      to: [{ operation: { ports: ['1234'] } }],
    }]);
    const routes = docsOf(`${target}/k8s/istio-internal-routes.yaml`);
    expect(find(routes, 'AuthorizationPolicy', 'image-registry-quarantine-builder-token-only')!.spec.rules[0].to[0].operation.notPaths).toEqual(['/token']);
    const deny = find(routes, 'AuthorizationPolicy', 'quarantine-builder-deny-waypoint-services')!;
    expect(deny.spec.targetRefs.map((r: Doc) => r.name).sort()).toEqual(['compliance', 'message', 'platform', 'quota', 'reporting']);
  });

  it('is what the plugin service builds submissions on (never the tenant buildkitd)', () => {
    const env = read(`${target}/.env.example`);
    expect(env).toContain(`\nPLUGIN_QUARANTINE_BUILDKIT_ADDR=tcp://${NAME}:1234\n`);
    expect(find(docs, 'Service', NAME)!.spec.ports[0].port).toBe(1234);
  });
});

describe('quarantine builder on EKS runs on its own tainted NodePool', () => {
  const pool = docsOf('deploy/aws/eks/cluster/nodepool.yaml').find((d) => d.metadata?.name === 'plugin-quarantine')!;
  const pod = find(docsOf(`deploy/aws/eks/k8s/${NAME}.yaml`), 'Deployment', NAME)!.spec.template.spec;

  it('taints the pool and bounds its capacity', () => {
    expect(pool.spec.template.spec.taints).toEqual([{ key: 'pipeline-builder/quarantine', value: 'true', effect: 'NoSchedule' }]);
    expect(pool.spec.limits).toBeDefined();
  });

  it('selects and tolerates exactly that pool', () => {
    expect(pod.nodeSelector).toEqual({ 'karpenter.sh/nodepool': 'plugin-quarantine' });
    expect(pod.tolerations).toEqual([{ key: 'pipeline-builder/quarantine', operator: 'Equal', value: 'true', effect: 'NoSchedule' }]);
  });
});

describe('quarantine builder has no credential path — deploy/local/docker', () => {
  const compose = parse(read('deploy/local/docker/docker-compose.yml')) as Doc;
  const svc = compose.services['buildkitd-quarantine'];

  it('has no environment and no env_file', () => {
    expect(svc.environment).toBeUndefined();
    expect(svc.env_file).toBeUndefined();
    expect(svc.privileged).toBeFalsy();
    expect(svc.user).toBe('1000:1000');
  });

  it('mounts only its own cache and read-only config', () => {
    expect(svc.volumes).toEqual([
      'buildkit-quarantine-cache:/home/user/.local/share/buildkit:rw',
      './config/buildkitd-quarantine/buildkitd.toml:/home/user/.config/buildkit/buildkitd.toml:ro',
    ]);
  });

  it('sits ONLY on quarantine-network, which no datastore or credential-holding service joins', () => {
    expect(svc.networks).toEqual(['quarantine-network']);
    const members = Object.entries(compose.services as Record<string, Doc>)
      .filter(([, s]) => (s.networks ?? []).includes('quarantine-network'))
      .map(([name]) => name)
      .sort();
    expect(members).toEqual(['buildkitd-quarantine', 'image-registry', 'plugin', 'registry']);
  });

  it('is what the plugin service builds submissions on', () => {
    expect(compose.services.plugin.environment.PLUGIN_QUARANTINE_BUILDKIT_ADDR)
      .toBe('${PLUGIN_QUARANTINE_BUILDKIT_ADDR:-tcp://buildkitd-quarantine:1234}');
    expect(read('deploy/local/docker/.env.example')).toContain('\nPLUGIN_QUARANTINE_BUILDKIT_ADDR=tcp://buildkitd-quarantine:1234\n');
  });

  it('carries no credential-looking config in its buildkitd.toml', () => {
    expect(read('deploy/local/docker/config/buildkitd-quarantine/buildkitd.toml')).not.toMatch(/^\s*(auth|token|password|secret|ca|keypair)\b/im);
  });
});

describe.each(ALL_TARGETS)('submission env contract — %s', (target) => {
  const env = read(`${target}/.env.example`);

  it.each(['SUBMISSION_POW_SECRET', 'SUBMISSION_EMAIL_HASH_SECRET'])('ships %s as a CHANGE_ME placeholder gen-env-secrets fills', (key) => {
    expect(env).toContain(`\n${key}=CHANGE_ME\n`);
    expect(read('deploy/bin/gen-env-secrets.sh')).toContain(`s|^${key}=CHANGE_ME$|${key}=`);
  });

  it('keeps anonymous submissions OFF by default', () => {
    expect(env).toContain('\nANONYMOUS_SUBMISSIONS_ENABLED=false\n');
  });

  it('declares the quarantine bucket and caps', () => {
    for (const line of ['PLUGIN_QUARANTINE_BUCKET=plugin-quarantine', 'SUBMISSION_POW_DIFFICULTY=20',
      'SUBMISSION_BUILD_TIMEOUT_SECONDS=900', 'SUBMISSION_MAX_ZIP_BYTES=52428800']) {
      expect(env).toContain(`\n${line}\n`);
    }
  });

  it('never names a credential in the quarantine builder definition', () => {
    const def = target === 'deploy/local/docker'
      ? JSON.stringify((parse(read('deploy/local/docker/docker-compose.yml')) as Doc).services['buildkitd-quarantine'])
      : JSON.stringify(find(docsOf(`${target}/k8s/${NAME}.yaml`), 'Deployment', NAME));
    expect(def).not.toMatch(CREDENTIAL_PATTERN);
  });
});
