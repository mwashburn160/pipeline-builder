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

import { existsSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';
import { ALL_TARGETS, K8S_TARGETS, REPO_ROOT, read } from '../src/index.js';

// Jest runs with cwd = `platform/`; the deploy tree is at the repo root.


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
  it('leaves NO shared service-token secret anywhere', () => {
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
  });

  it('gives EVERY service its own signing-key Secret, and only its own', () => {
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

  it('keeps every target\'s njs jwt.js free of signing secrets', () => {
    // Each target ships its own copy; the byte-identity of the four is guarded
    // in bringup-contract.test.ts, so a fix cannot land in one environment only.
    for (const target of ALL_TARGETS) {
      expect([target, existsSync(join(REPO_ROOT, target, 'nginx/jwt.js'))]).toEqual([target, true]);
      const jwt = read(`${target}/nginx/jwt.js`);
      expect(jwt).not.toContain('process.env.JWT_SECRET');
      expect(jwt).not.toContain('createHmac');
    }
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

/**
 * A documented KMS secret-encryption mode must come with the IAM grant it needs.
 *
 * THIS IS THE BUG THIS GUARD EXISTS FOR. Both KMS modes were fully built,
 * documented in docs/environment-variables.md, and reachable from the step-up
 * gated `/admin/orgs/:orgId/kms-config` API — but the only KMS grants either AWS
 * target ever wrote were `kms:Sign` + `kms:GetPublicKey` for token and plugin
 * signing. ec2's template even said so ("kms:Sign + kms:GetPublicKey and nothing
 * more, deliberately"). Recovering a wrapped master is `kms:Decrypt`, so an
 * operator who followed the docs got a runtime failure on a permission nobody
 * had granted, and nothing in the repo contradicted the docs.
 *
 * Asserted per target against its own mechanism — eks grants through
 * `bin/setup.sh`, ec2 through a conditional IAM::Policy in `template.yaml` — so
 * this cannot be satisfied by one target carrying the other's grant.
 */
describe('secret-encryption KMS modes carry their kms:Decrypt grant', () => {
  it('eks grants it for both the single-master and per-org modes', () => {
    const setup = read('deploy/aws/eks/bin/setup.sh');
    // Single-master: one known key, so the grant is ARN-scoped.
    expect(setup).toContain('SECRET_ENCRYPTION_KMS_KEY_ID');
    expect(setup).toMatch(/SecretEncryptionUnwrap[\s\S]{0,200}kms:Decrypt/);
    // Per-org keys are created later through the admin API and have no ARN at
    // provision time, so that grant is scoped by resource tag instead of by
    // `Resource: "*"` alone. Both halves must be present.
    expect(setup).toMatch(/PerOrgSecretEncryptionUnwrap[\s\S]{0,300}kms:Decrypt/);
    expect(setup).toContain('aws:ResourceTag/pipeline-builder:secret-encryption');
    // Both services that encrypt org-scoped secrets need the single-master grant.
    expect(setup).toMatch(/for _sa in platform plugin/);
  });

  it('ec2 attaches it conditionally, and keeps signing scoped to the stack key', () => {
    const tpl = read('deploy/aws/ec2/template.yaml');
    expect(tpl).toContain('InstanceRoleSecretEncryptionKmsPolicy');
    expect(tpl).toContain('Condition: SecretEncryptionKmsEnabled');
    expect(tpl).toMatch(/SecretEncryptionUnwrap[\s\S]{0,200}kms:Decrypt/);
    expect(tpl).toContain('aws:ResourceTag/pipeline-builder:secret-encryption');
    // The token-signing policy must NOT have picked up Decrypt along the way.
    const signing = tpl.slice(tpl.indexOf('InstanceRoleTokenSigningKmsPolicy'), tpl.indexOf('InstanceRoleSecretEncryptionKmsPolicy'));
    expect(signing).not.toContain('kms:Decrypt');
    // And the stack must actually pass the two parameters, or the condition is
    // always false and the policy silently never attaches.
    const setup = read('deploy/aws/ec2/bin/setup.sh');
    expect(setup).toContain('SecretEncryptionKmsKeyId=');
    expect(setup).toContain('SecretEncryptionPerOrgKms=');
  });

  it('documents every KMS secret-encryption var the code reads', () => {
    // These are built by hand in .env, so an undocumented one is an override an
    // operator cannot discover — the same failure mode as the bundle-id lists.
    const docs = read('docs/environment-variables.md');
    for (const key of [
      'SECRET_ENCRYPTION_KMS_KEY_ID',
      'SECRET_ENCRYPTION_KMS_CIPHERTEXT',
      'SECRET_ENCRYPTION_KMS_CIPHERTEXT_PREVIOUS',
      'SECRET_ENCRYPTION_KMS_KEY_ID_PREVIOUS',
      'SECRET_ENCRYPTION_PER_ORG_KMS',
    ]) {
      expect([key, docs.includes(key)]).toEqual([key, true]);
      for (const target of ['deploy/aws/eks', 'deploy/aws/ec2']) {
        expect([target, key, read(`${target}/.env.example`).includes(key)]).toEqual([target, key, true]);
      }
    }
  });
});

/**
 * A documented AWS-backed feature must carry the IAM grant it needs.
 *
 * Generalised from the KMS case above, because the same gap existed twice. The
 * AWS Marketplace billing provider is listed as supported in
 * docs/billing-providers.md, offered in both AWS `.env.example` files, and fully
 * implemented — and `billing` had NO Pod Identity association at all, so an
 * operator who selected it got a credential-resolution failure rather than an
 * AccessDenied they could diagnose. ec2's instance role had 12 actions and none
 * of them Marketplace.
 */
describe('the AWS Marketplace billing provider carries its IAM grant', () => {
  it('eks grants the three Marketplace calls to the billing SA', () => {
    const setup = read('deploy/aws/eks/bin/setup.sh');
    expect(setup).toMatch(/grant_pod_identity billing marketplace/);
    for (const action of ['ResolveCustomer', 'GetEntitlements', 'BatchMeterUsage']) {
      expect([action, setup.includes(`aws-marketplace:${action}`)]).toEqual([action, true]);
    }
    // Only when the provider is selected — a stub/stripe install must leave the
    // billing SA with no AWS access at all.
    expect(setup).toMatch(/BILLING_PROVIDER[^\n]*aws-marketplace/);
  });

  it('ec2 attaches it conditionally on the provider', () => {
    const tpl = read('deploy/aws/ec2/template.yaml');
    expect(tpl).toContain('InstanceRoleMarketplacePolicy');
    expect(tpl).toContain('Condition: BillingIsAwsMarketplace');
    for (const action of ['ResolveCustomer', 'GetEntitlements', 'BatchMeterUsage']) {
      expect([action, tpl.includes(`aws-marketplace:${action}`)]).toEqual([action, true]);
    }
    // The condition is dead unless the stack is actually passed the parameter.
    expect(read('deploy/aws/ec2/bin/setup.sh')).toContain('BillingProvider=');
  });

  it('covers every Marketplace SDK command the provider actually issues', () => {
    // The grant is a hand-written list; a fourth call added to the provider must
    // not silently ship without its action. Derived from the source, not repeated.
    const provider = read('api/billing/src/providers/aws-marketplace-provider.ts');
    const issued = [...provider.matchAll(/\bnew (\w+)Command\b/g)].map((m) => m[1]);
    expect(issued.length).toBeGreaterThan(2);
    const grants = read('deploy/aws/eks/bin/setup.sh') + read('deploy/aws/ec2/template.yaml');
    const ungranted = [...new Set(issued)].filter((c) => !grants.includes(`aws-marketplace:${c}`));
    expect({
      ungranted,
      fix: 'This Marketplace API is called but not granted. Add `aws-marketplace:<Command>` to '
        + 'the eks grant_pod_identity call AND ec2 InstanceRoleMarketplacePolicy.',
    }).toEqual({ ungranted: [], fix: expect.any(String) });
  });
});

/**
 * `ASK_SERVICE_HOST` / `ASK_SERVICE_PORT` are honoured, not just documented.
 *
 * They were documented knobs that NOTHING read. The `<NAME>_SERVICE_HOST/PORT`
 * convention is consumer-side discovery honoured by the api-core service clients,
 * and nothing in the fleet calls Ask — the browser reaches it through nginx, which
 * had the address hard-coded. nginx is therefore Ask's only caller, and that is
 * where the pair is now rendered.
 */
describe('the ask service address is configurable, not hard-coded', () => {
  const NGINX_TARGETS = ['deploy/aws/eks', 'deploy/aws/ec2', 'deploy/local/minikube'];

  it.each(NGINX_TARGETS)('%s proxies ask through the generated upstream', (target) => {
    const conf = read(`${target}/nginx/nginx.conf`);
    expect(conf).toContain('include /etc/nginx/ask-upstream.conf;');
    expect(conf).toContain('proxy_pass http://pb_ask;');
    // The literal it replaced must be gone, or the knob is bypassed.
    expect(conf).not.toMatch(/proxy_pass http:\/\/ask[.:]/);
  });

  it('generates that file from the two env vars, with the documented defaults', () => {
    const sh = read('deploy/bin/k8s-resources.sh');
    expect(sh).toContain('ask-upstream.conf');
    expect(sh).toContain('ASK_SERVICE_HOST');
    expect(sh).toContain('ASK_SERVICE_PORT');
    expect(sh).toContain('upstream pb_ask { server ');
    // Both values are rendered into nginx config, so both are validated — a host
    // carrying a `;` or a space would inject directives.
    expect(sh).toMatch(/ASK_SERVICE_PORT='\$_ask_port' is not a port number/);
    expect(sh).toMatch(/ASK_SERVICE_HOST='\$_ask_host' is not a bare hostname/);
  });

  it.each(NGINX_TARGETS)('%s declares both keys so pb_sync_env_keys adds them', (target) => {
    const env = read(`${target}/.env.example`);
    for (const key of ['ASK_SERVICE_HOST', 'ASK_SERVICE_PORT']) {
      expect([key, env.includes(key)]).toEqual([key, true]);
    }
  });
});
