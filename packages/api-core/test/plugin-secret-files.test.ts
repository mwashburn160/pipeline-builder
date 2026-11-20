// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import { SECRET_FILE_KINDS, secretFileKind, secretFileNeedsContent } from '../src/types/plugin-secret-files.js';

const PRIVATE_PEM = '-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----\n';
const RSA_PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEo...\n-----END RSA PRIVATE KEY-----\n';
const CERT_PEM = '-----BEGIN CERTIFICATE-----\nMIID...\n-----END CERTIFICATE-----\n';
const PUBLIC_PEM = '-----BEGIN PUBLIC KEY-----\nMIIB...\n-----END PUBLIC KEY-----\n';
const PGP_PUBLIC = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nmQIN...\n-----END PGP PUBLIC KEY BLOCK-----\n';
const SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account', project_id: 'p', private_key_id: 'abc', private_key: PRIVATE_PEM, client_email: 'sa@p.iam',
}, null, 2);

describe('secretFileKind: name-only kinds', () => {
  it.each([
    ['.env', 'dotenv'],
    ['src/.env.production', 'dotenv'],
    ['prod.env', 'dotenv'],
    ['config/staging.env', 'dotenv'],
    ['.envrc', 'direnv'],
    ['sub/.envrc', 'direnv'],
    ['keys/id_ed25519', 'ssh_private_key'],
    ['.aws/credentials', 'aws_credentials'],
    ['home/.docker/config.json', 'docker_config'],
    ['.netrc', 'netrc'],
    ['.git-credentials', 'git_credentials'],
    ['.pypirc', 'pypirc'],
    ['certs/client.p12', 'pkcs12'],
    ['certs/client.PFX', 'pkcs12'],
    ['.kube/config', 'kubeconfig'],
    ['home/.kube/config', 'kubeconfig'],
    ['gcloud/application_default_credentials.json', 'gcloud_adc'],
  ])('%s is %s, without reading its content', (file, kind) => {
    expect(secretFileNeedsContent(file)).toBe(false);
    expect(secretFileKind(file)).toBe(kind);
  });

  it.each([
    '.env.example', '.env.sample', 'config/.env.template', '.env.dist', '.env.defaults',
    '.env.local.example', 'example.env', 'prod.env.example', 'sample.env',
    'keys/id_rsa.pub', 'docs/environment.md', 'environment.ts', 'src/env.ts', 'kube/config', '.kube/config.example',
    'dev.environment', 'README.md', 'config/', '.envrc.example',
  ])('%s is allowed', (file) => {
    expect(secretFileKind(file)).toBeNull();
  });
});

describe('secretFileKind: content-based kinds', () => {
  it.each([
    'tls/server.pem', 'tls/server.key', 'svc.json', 'creds/sa-key.json', '.npmrc', 'pkg/.npmrc', '.yarnrc.yml',
  ])('%s needs its content to decide', (file) => {
    expect(secretFileNeedsContent(file)).toBe(true);
  });

  it('a .pem holding a private key is refused; a certificate or public key is allowed', () => {
    expect(secretFileKind('tls/server.pem', PRIVATE_PEM)).toBe('private_key');
    expect(secretFileKind('tls/server.pem', CERT_PEM + RSA_PEM)).toBe('private_key');
    expect(secretFileKind('tls/ca.pem', CERT_PEM)).toBeNull();
    expect(secretFileKind('tls/pub.pem', PUBLIC_PEM)).toBeNull();
  });

  it('a .key is refused unless its content is only a public key or certificate', () => {
    expect(secretFileKind('tls/server.key', RSA_PEM)).toBe('private_key');
    expect(secretFileKind('tls/server.key', '\u0030\u0082\u0004\u00a3binary-der')).toBe('private_key');
    expect(secretFileKind('config/master.key', '3f9a1c0e8b7d6a5f4e3d2c1b0a998877\n')).toBe('private_key');
    expect(secretFileKind('empty.key', '')).toBeNull();
    expect(secretFileKind('apt/docker.key', PGP_PUBLIC)).toBeNull();
    expect(secretFileKind('tls/server.key', PUBLIC_PEM)).toBeNull();
    expect(secretFileKind('tls/ssh.key', 'ssh-ed25519 AAAAC3Nza user@host\n')).toBeNull();
  });

  it('a service-account JSON is refused; other JSON (or a description of one) is allowed', () => {
    expect(secretFileKind('creds/sa-key.json', SERVICE_ACCOUNT)).toBe('gcp_service_account');
    expect(secretFileKind('package.json', '{"name":"x","type":"module"}')).toBeNull();
    expect(secretFileKind('schema.json', '{"type":"service_account"}')).toBeNull();
    expect(secretFileKind('docs.json', '{"private_key":"see the docs","type":"user"}')).toBeNull();
  });

  it('.npmrc is refused only when it carries an auth token', () => {
    expect(secretFileKind('.npmrc', '//registry.npmjs.org/:_authToken=npm_abc123\n')).toBe('npmrc_token');
    expect(secretFileKind('.npmrc', 'registry=https://r\n_auth=dXNlcjpwYXNz\n')).toBe('npmrc_token');
    expect(secretFileKind('.npmrc', 'registry=https://registry.npmjs.org/\nsave-exact=true\n')).toBeNull();
    // Basic auth: npm reads `_password` (base64) beside `username`, per registry or global.
    expect(secretFileKind('.npmrc', '//npm.acme.dev/:username=ci\n//npm.acme.dev/:_password=c2VjcmV0\n')).toBe('npmrc_token');
    expect(secretFileKind('.npmrc', '_password=c2VjcmV0\n')).toBe('npmrc_token');
    expect(secretFileKind('.npmrc', '//npm.acme.dev/:_password=${NPM_PASSWORD}\n')).toBeNull();
    // An env-var reference is how CI injects the token: no value is in the file.
    expect(secretFileKind('.npmrc', '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n')).toBeNull();
  });

  it('.yarnrc.yml is refused only when it carries npmAuthToken', () => {
    expect(secretFileKind('.yarnrc.yml', 'npmAuthToken: npm_abc123\n')).toBe('yarnrc_token');
    expect(secretFileKind('.yarnrc.yml', 'npmScopes:\n  acme:\n    npmAuthToken: "npm_abc"\n')).toBe('yarnrc_token');
    expect(secretFileKind('.yarnrc.yml', 'nodeLinker: node-modules\n')).toBeNull();
    // npmAuthIdent is `user:password` (or its base64).
    expect(secretFileKind('.yarnrc.yml', 'npmAuthIdent: "ci:s3cret"\n')).toBe('yarnrc_token');
    expect(secretFileKind('.yarnrc.yml', 'npmAuthToken: "${NPM_TOKEN}"\n')).toBeNull();
  });

  it('a content kind without content is not decided (the caller must pass it)', () => {
    expect(secretFileKind('tls/server.pem')).toBeNull();
  });

  it('every kind has a label', () => {
    for (const kind of Object.values(SECRET_FILE_KINDS)) expect(kind.label.length).toBeGreaterThan(0);
  });
});
