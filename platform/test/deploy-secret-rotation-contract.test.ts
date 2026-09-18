// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guard for the secret-rotation deploy contract
 * (docs/runbooks/secret-rotation.md).
 *
 * Every rotatable secret has an overlap value the runbook tells operators to
 * set. Each one only works if the plumbing exists in EVERY target: the key in
 * `.env.example` (so `pb_sync_env_keys` adds it to existing installs), the
 * Secret key the manifests `secretKeyRef` (a missing key makes the pod fail to
 * start, not degrade), and the env var reaching the process. All of that is
 * silent when absent — the rotation simply logs everyone out instead — hence
 * these assertions.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// Jest runs with cwd = `platform/`; the deploy tree is at the repo root.
const REPO_ROOT = join(process.cwd(), '..');
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf-8');

const ALL_TARGETS = ['deploy/local/docker', 'deploy/local/minikube', 'deploy/aws/ec2', 'deploy/aws/eks'];
const K8S_TARGETS = ['deploy/local/minikube', 'deploy/aws/ec2', 'deploy/aws/eks'];

/**
 * The overlap keys operators set; each is consumed by the code named in the
 * runbook. `TOKEN_SIGNING_KEY_PREVIOUS_FILE` is the ES256 user-token key's
 * overlap — a retiring key that stays PUBLISHED in the JWKS while it is set.
 * `REFRESH_TOKEN_SECRET_PREVIOUS` is gone: refresh tokens are signed with that
 * same key, so they rotate with it.
 */
const PREVIOUS_KEYS = [
  'TOKEN_SIGNING_KEY_PREVIOUS_FILE',
  'SECRET_ENCRYPTION_KEY_PREVIOUS',
  'ALERT_WEBHOOK_INSTANCE_TOKEN_PREVIOUS',
];

describe.each(ALL_TARGETS)('secret-rotation env contract — %s', (target) => {
  const env = read(`${target}/.env.example`);

  it.each(PREVIOUS_KEYS)('declares %s, empty by default', (key) => {
    // Declared-and-empty (not commented out): pb_sync_env_keys only appends
    // uncommented assignments, so a commented key never reaches an existing
    // .env and the operator's rotation silently has no overlap window.
    expect(env).toContain(`\n${key}=\n`);
  });

  it('alerts while any previous value stays set', () => {
    const rules = read(`${target}/config/prometheus/alert-rules.yml`);
    expect(rules).toContain('alert: SecretRotationPreviousLingering');
    const rule = rules.slice(rules.indexOf('alert: SecretRotationPreviousLingering'));
    // Aggregating away pod/instance is load-bearing: with them, a rolling
    // restart during the rotation starts a brand-new series and the `for`
    // timer restarts, so the alert would never fire on a busy deploy.
    expect(rule).toContain('max by (service, secret) (secret_rotation_previous_set) == 1');
    expect(rule).toContain('for: 24h');
  });
});

describe.each(K8S_TARGETS)('secret-rotation k8s wiring — %s', (target) => {
  it('leaves NO shared service-token secret anywhere (#14 cutover)', () => {
    // Every service signs with its own key now; a lingering JWT_SECRET in the
    // env or a Secret would be a credential nothing reads and nobody rotates.
    const env = read(`${target}/.env.example`);
    expect(env).not.toContain('\nJWT_SECRET=');
    expect(env).not.toContain('\nJWT_ALGORITHM=');
    expect(env).toContain('\nSERVICE_SIGNING_KEY_FILE=');
    expect(env).toContain('\nSERVICE_KEY_BUNDLE_FILE=');
    expect(read('deploy/bin/k8s-resources.sh')).not.toContain('pb_secret jwt-secret');
  });

  it('hands nginx NO signing secret at all — njs stopped verifying at the #5 cutover', () => {
    // User tokens are ES256 and verifying one needs an async JWKS fetch a
    // synchronous `js_set` handler cannot make, so jwt.js decodes claims for the
    // access log and the x-org-id/x-user-id headers and verifies nothing. Leaving
    // a secret wired in would imply a check that no longer happens.
    const nginx = read(`${target}/k8s/nginx.yaml`);
    expect(nginx).not.toContain('key: JWT_SECRET');
    expect(read(`${target}/nginx/nginx.conf`)).not.toContain('env JWT_SECRET');
  });

  it('mounts the user-token signing key into PLATFORM ONLY', () => {
    // It is the one credential in the fleet that can mint a token for a person.
    const platform = read(`${target}/k8s/platform.yaml`);
    expect(platform).toContain('secretName: token-signing-key');
    expect(platform).toContain('mountPath: /etc/pipeline-builder/keys');
    for (const svc of ['nginx', 'plugin', 'pipeline', 'quota', 'reporting', 'billing', 'message', 'compliance', 'image-registry']) {
      expect(read(`${target}/k8s/${svc}.yaml`)).not.toContain('token-signing-key');
    }
  });

  it('passes the relay rotation token into platform\'s ALERT_WEBHOOK_INSTANCES', () => {
    const platform = read(`${target}/k8s/platform.yaml`);
    expect(platform).toContain('key: ALERT_WEBHOOK_INSTANCE_TOKEN_PREVIOUS');
    expect(platform).toContain('"previousToken":"$(ALERT_WEBHOOK_INSTANCE_TOKEN_PREVIOUS)"');
  });
});

describe('secret-rotation shell plumbing', () => {
  const genEnv = read('deploy/bin/gen-env-secrets.sh');
  const k8sResources = read('deploy/bin/k8s-resources.sh');

  it('ships the rotate / finish helpers the runbook calls', () => {
    expect(genEnv).toContain('pb_rotate_env_secret()');
    expect(genEnv).toContain('pb_finish_env_rotation()');
    // Refusing to "rotate" an unset secret keeps a typo from blanking a live key.
    expect(genEnv).toContain('refusing to rotate an unset secret');
  });

  it('creates the alertmanager-relay Secret with its *_PREVIOUS key', () => {
    // The manifests secretKeyRef this unconditionally — a missing key makes the
    // pod fail to start with CreateContainerConfigError.
    expect(k8sResources).toContain('--from-literal=ALERT_WEBHOOK_INSTANCE_TOKEN_PREVIOUS=');
    expect(read('deploy/local/minikube/bin/setup.sh')).toContain('--from-literal=ALERT_WEBHOOK_INSTANCE_TOKEN_PREVIOUS=');
  });

  it('gives EVERY service its own signing-key Secret, and only its own (#14)', () => {
    // The whole point of per-service keys: one private key per pod. A service
    // that could read another's Secret could sign as it, which is exactly what
    // the shared JWT_SECRET allowed.
    expect(k8sResources).toContain('pb_create_service_key_secrets()');
    const generator = read('deploy/bin/service-signing-keys.sh');
    expect(generator).toContain('--rotate');
    expect(generator).toContain('refusing to rotate');
    for (const target of K8S_TARGETS) {
      for (const svc of ['platform', 'plugin', 'pipeline', 'quota', 'reporting', 'billing', 'message', 'compliance', 'image-registry', 'ask']) {
        const manifest = read(`${target}/k8s/${svc}.yaml`);
        expect(manifest).toContain(`secretName: service-key-${svc}`);
        expect(manifest).toContain('secretName: service-key-bundle');
        // …and NO other service's key.
        for (const other of ['platform', 'plugin', 'quota', 'billing']) {
          if (other !== svc) expect(manifest).not.toContain(`secretName: service-key-${other}`);
        }
      }
    }
  });

  it('carries the retiring signing key into the token-signing-key Secret', () => {
    // The signing key's overlap is a FILE, so the Secret gains a second entry
    // rather than a *_PREVIOUS literal. Absent, `--rotate` produces a key
    // nothing publishes and every pre-rotation session dies at the cutover.
    expect(k8sResources).toContain('pb_create_token_signing_secret()');
    expect(k8sResources).toContain('--from-file=token-signing-previous.key=');
    expect(read('deploy/local/minikube/bin/setup.sh')).toContain('--from-file=token-signing-previous.key=');
    // …and the generator that produces it.
    const keys = read('deploy/bin/token-signing-keys.sh');
    expect(keys).toContain('--rotate');
    expect(keys).toContain('refusing to rotate: no current key');
  });

  it('routes *_PREVIOUS values into app-secrets, never the app-env ConfigMap', () => {
    // A rotation overlap value is the same class of credential as the key it
    // supersedes; the name-based split must treat it as one.
    expect(k8sResources).toContain('_PREVIOUS)$/');
  });

  it('keeps every njs copy free of signing secrets, and identical', () => {
    // All four copies of jwt.js must agree — they are byte-identical by design.
    const [first, ...rest] = ALL_TARGETS.map((t) => read(`${t}/nginx/jwt.js`));
    for (const copy of rest) expect(copy).toBe(first);
    expect(first).not.toContain('process.env.JWT_SECRET');
    expect(first).not.toContain('createHmac');
  });

  it('routes every target\'s JWKS path to platform, unauthenticated', () => {
    // Every verifier in the fleet — and the CLI and the events Lambda from
    // outside it — reads this one path. A target that does not proxy it cannot
    // verify any token.
    for (const target of ALL_TARGETS) {
      const conf = read(`${target}/nginx/nginx.conf`);
      expect(conf).toContain('location = /.well-known/jwks.json');
      expect(conf).toContain('location = /api/.well-known/jwks.json');
    }
  });
});
