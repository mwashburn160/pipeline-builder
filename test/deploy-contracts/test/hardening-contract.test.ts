// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guards for deploy/release hardening that fails silently when it
 * regresses: a release image that trusts a developer's mkcert CA, a mutable
 * base-image tag, a data volume that vanishes with its stack, a boot secret in
 * UserData, a single-replica pooler every DB connection depends on.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';
import { parse, parseAllDocuments } from 'yaml';
import { REPO_ROOT, read } from '../src/index.js';

type Doc = Record<string, any>;
const docsOf = (rel: string): Doc[] => parseAllDocuments(read(rel)).map((d) => d.toJSON()).filter(Boolean);

const SERVICE_DIRS = ['platform', 'frontend', 'api/ask', 'api/billing', 'api/compliance', 'api/image-registry',
  'api/message', 'api/pipeline', 'api/plugin', 'api/quota', 'api/reporting'];

describe('release images', () => {
  it.each(SERVICE_DIRS)('%s: trusts no developer CA and ships none', (dir) => {
    const df = read(`${dir}/Dockerfile`);
    expect(df).not.toMatch(/self-signed|mkcert|update-ca-certificates|usr\/local\/share\/ca-certificates/);
    expect(existsSync(join(REPO_ROOT, dir, 'self-signed.crt'))).toBe(false);
  });

  it.each([...SERVICE_DIRS, 'deploy/codebuild/bootstrap'])('%s: builds FROM a digest-pinned base', (dir) => {
    const df = read(`${dir}/Dockerfile`);
    const arg = /^ARG NODE_IMAGE=(\S+)$/m.exec(df);
    expect(arg?.[1]).toMatch(/^node:[0-9.]+-(alpine|slim)@sha256:[0-9a-f]{64}$/);
    for (const from of df.match(/^FROM\s+(\S+)/gm) ?? []) {
      expect(from).toMatch(/^FROM \$\{NODE_IMAGE\}/);
    }
  });
});

describe('local HTTPS without a CA baked into images', () => {
  const compose = parse(read('deploy/local/docker/docker-compose.yml'), { merge: true });

  it('mounts the dev CA and points Node at it in every server container', () => {
    for (const [name, svc] of Object.entries<Doc>(compose.services)) {
      const vols: string[] = svc.volumes ?? [];
      if (!vols.some((v) => String(v).includes('service-key-bundle'))) continue;
      expect([name, vols.some((v) => String(v).includes('dev-ca.crt'))]).toEqual([name, true]);
      expect([name, svc.environment?.NODE_EXTRA_CA_CERTS]).toEqual([name, '/etc/pipeline-builder/dev-ca.crt']);
    }
    expect(compose.services.frontend.environment.NODE_EXTRA_CA_CERTS).toBe('/etc/pipeline-builder/dev-ca.crt');
  });

  it('verifies TLS on minikube instead of switching it off', () => {
    const fe = read('deploy/local/minikube/k8s/frontend.yaml');
    expect(fe).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED');
    expect(fe).toContain('NODE_EXTRA_CA_CERTS');
    const tls = read('deploy/bin/nginx-tls.sh');
    expect(tls).toContain('dev-ca.crt');
    expect(tls).toContain('DNS:nginx');
  });
});

describe('ec2 stack durability + boot secrets', () => {
  const template = read('deploy/aws/ec2/template.yaml');
  const userData = template.slice(template.indexOf('      UserData:'), template.indexOf('      Tags:', template.indexOf('      UserData:')));

  it('snapshots the data volume on delete AND replacement, and daily via DLM', () => {
    const vol = template.slice(template.indexOf('  DataVolume:\n'), template.indexOf('  DataVolumeSnapshotRole:'));
    expect(vol).toContain('DeletionPolicy: Snapshot');
    expect(vol).toContain('UpdateReplacePolicy: Snapshot');
    expect(template).toContain('Type: AWS::DLM::LifecyclePolicy');
    expect(template).toMatch(/RetainRule:\s+Count: !Ref DataVolumeSnapshotRetention/);
  });

  it('never interpolates a NoEcho parameter into UserData', () => {
    expect(userData.length).toBeGreaterThan(1000);
    expect(userData).not.toContain('${GhcrToken}');
    expect(userData).not.toContain('${AdminPassword}');
    expect(userData).toContain('secretsmanager get-secret-value');
    expect(template).toContain('Type: AWS::SecretsManager::Secret');
  });
});

describe('data-path HA on the AWS targets', () => {
  it.each(['deploy/aws/eks', 'deploy/aws/ec2'])('%s: pgbouncer runs 2 replicas under a PDB, sized under max_connections', (t) => {
    const docs = docsOf(`${t}/k8s/pgbouncer.yaml`);
    expect(docs.find((d) => d.kind === 'Deployment')!.spec.replicas).toBe(2);
    expect(docs.find((d) => d.kind === 'PodDisruptionBudget')?.spec.minAvailable).toBe(1);
    const ini: string = docs.find((d) => d.kind === 'ConfigMap')!.data['pgbouncer.ini'];
    const dbLines = ini.split('\n').filter((l) => /^\s*pipeline_builder\S*\s+=/.test(l));
    const perReplica = dbLines.reduce((a, l) => a + Number(/max_db_connections=(\d+)/.exec(l)?.[1] ?? NaN), 0);
    const pg = docsOf(`${t}/k8s/postgres.yaml`).find((d) => d.kind === 'StatefulSet' || d.kind === 'Deployment')!;
    const args: string[] = pg.spec.template.spec.containers.find((c: Doc) => c.name === 'postgres').args;
    const maxConn = Number(/max_connections=(\d+)/.exec(args.join(' '))![1]);
    // Every database line is capped, and both replicas fit with headroom.
    expect(dbLines.length).toBe(5);
    expect(Number.isNaN(perReplica)).toBe(false); // an uncapped database line makes this NaN
    expect(2 * perReplica + 20).toBeLessThanOrEqual(maxConn);
  });

  it('eks: registry runs 2 replicas sharing one upload-session secret', () => {
    const docs = docsOf('deploy/aws/eks/k8s/registry.yaml');
    const dep = docs.find((d) => d.kind === 'Deployment')!;
    expect(dep.spec.replicas).toBe(2);
    expect(dep.spec.strategy.type).toBe('RollingUpdate');
    const env: Doc[] = dep.spec.template.spec.containers[0].env;
    expect(env.find((e) => e.name === 'REGISTRY_HTTP_SECRET')?.valueFrom?.secretKeyRef?.key).toBe('http-secret');
    expect(docs.find((d) => d.kind === 'PodDisruptionBudget')).toBeDefined();
  });

  it('eks: nginx and pgbouncer spread across nodes', () => {
    for (const f of ['nginx.yaml', 'pgbouncer.yaml', 'registry.yaml']) {
      const dep = docsOf(`deploy/aws/eks/k8s/${f}`).find((d) => d.kind === 'Deployment')!;
      const keys = (dep.spec.template.spec.topologySpreadConstraints ?? []).map((c: Doc) => c.topologyKey);
      expect([f, keys]).toEqual([f, expect.arrayContaining(['kubernetes.io/hostname'])]);
    }
  });

  it('keeps the registry secret out of app-secrets', () => {
    expect(read('deploy/bin/k8s-resources.sh')).toContain('REGISTRY_HTTP_');
  });
});

describe('toolchain pins', () => {
  it('installs exactly ISTIO_VERSION rather than accepting any newer istioctl', () => {
    const fn = read('deploy/bin/common.sh');
    const body = fn.slice(fn.indexOf('ensure_istioctl() {'), fn.indexOf('ensure_kubectl() {'));
    expect(body).toContain('[ "$_have" = "$_want" ]');
    expect(body).not.toContain('-ge 24');
  });

  it('pins the cluster add-ons once, in the shared k8s bring-up', () => {
    const res = read('deploy/bin/k8s-resources.sh');
    expect(res).toContain('KEDA_VERSION="${KEDA_VERSION:-2.20.2}"');
    expect(res).toContain('ISTIO_VERSION="${ISTIO_VERSION:-1.30.3}"');
    expect(res).toContain('GATEWAY_API_VERSION="${GATEWAY_API_VERSION:-v1.3.0}"');
  });

  it.each(['deploy/aws/eks/bin/setup.sh', 'deploy/aws/ec2/bin/startup.sh', 'deploy/local/minikube/bin/setup.sh'])('%s installs the add-ons through the shared helpers, never its own pin', (f) => {
    const setup = read(f);
    expect(setup).toContain('pb_install_keda');
    expect(setup).toContain('pb_install_istio_ambient');
    expect(setup).not.toMatch(/kedacore\/keda\/releases|ISTIO_VERSION=|GATEWAY_API_VERSION=/);
  });
});

describe('release supply chain', () => {
  const release = read('.github/workflows/release.yml');
  const test = read('.github/workflows/test.yml');

  it('installs from the lockfile, never re-resolving it', () => {
    expect(release).not.toContain('--no-frozen-lockfile');
    expect(release).toContain('pnpm install --frozen-lockfile');
  });

  it('pins every action to a commit SHA', () => {
    for (const wf of [release, test,
      read('.github/workflows/security-audit.yml'), read('.github/workflows/plugin-urls.yml'), read('.github/workflows/plugin-catalog.yml')]) {
      for (const [, ref] of wf.matchAll(/uses:\s*(\S+)/g)) expect(ref).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('no longer wipes the repo\'s Actions caches on every job', () => {
    expect(release).not.toContain('deleteActionsCacheById');
  });

  it('scans each published image and verifies signatures against main only', () => {
    expect(release).toContain('grype sbom:sbom.spdx.json');
    expect(release).toContain('--fail-on critical');
    const verify = read('deploy/bin/verify-image-signatures.sh');
    expect(verify).toContain('refs/heads/main');
    expect(verify).toContain('--certificate-identity "$IDENTITY"');
    expect(verify).not.toContain('--certificate-identity-regexp');
  });

  it('pins digests only after verifying their signatures', () => {
    const sync = read('deploy/bin/sync-image-tags.sh');
    const verifyAt = sync.indexOf('verify-image-signatures.sh" "$OWNER"');
    const sedAt = sync.indexOf('sed_i "s|');
    expect(verifyAt).toBeGreaterThan(0);
    expect(sedAt).toBeGreaterThan(verifyAt);
    expect(sync).toContain('@${digest}');
  });

  it('gates PRs on the build target and runs the deploy/Docker checks', () => {
    expect(test).toMatch(/nx affected -t build/);
    expect(test).toContain('github.event.before');
    expect(test).toContain('deploy contracts');
    // ONE deploy job runs every deploy check; no parallel per-check workflows.
    for (const step of ['cd test/deploy-contracts', 'kubectl kustomize', 'docker compose', 'deploy/bin/validate-configs.sh',
      'gen-env-examples.mjs --check', 'gen-readme-index.mjs --check', 'gen-promtail-masking.mjs --check', 'shellcheck -x -S error']) {
      expect([step, test.includes(step)]).toEqual([step, true]);
    }
    for (const gone of ['deploy-configs.yml', 'deploy-shellcheck.yml']) expect(existsSync(join(REPO_ROOT, '.github/workflows', gone))).toBe(false);
    expect(test).toContain('docker buildx build');
  });
});
