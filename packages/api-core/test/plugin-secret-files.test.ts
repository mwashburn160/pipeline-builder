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
    'dev.environment', 'README.md', 'config/', '.envrc.example', 'settings.xml', 'pip.conf', '.cargo/credentials.toml', '.config/gh/hosts.yml',
  ])('%s is allowed (by name: a content kind with no content passed is undecided)', (file) => {
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

  it('Maven settings.xml is refused only for a literal <password> / <passphrase>', () => {
    const server = (inner: string) => `<settings>\n  <servers>\n    <server>\n      <id>repo</id>\n      <username>ci</username>\n${inner}\n    </server>\n  </servers>\n</settings>\n`;
    expect(secretFileNeedsContent('.m2/settings.xml')).toBe(true);
    expect(secretFileKind('.m2/settings.xml', server('      <password>s3cret</password>'))).toBe('maven_settings');
    expect(secretFileKind('settings.xml', server('      <password>{COQLCE6DU6GtcS5P=}</password>'))).toBe('maven_settings');
    expect(secretFileKind('settings.xml', server('      <passphrase>\n        hunter2\n      </passphrase>'))).toBe('maven_settings');
    // Maven's env interpolation (how CI injects it), an empty element, or no server password at all.
    expect(secretFileKind('settings.xml', server('      <password>${env.MAVEN_PASSWORD}</password>'))).toBeNull();
    expect(secretFileKind('settings.xml', server('      <password>${MAVEN_PASSWORD}</password>'))).toBeNull();
    expect(secretFileKind('settings.xml', server('      <password></password>'))).toBeNull();
    expect(secretFileKind('settings.xml', '<settings><mirrors><mirror><url>https://m</url></mirror></mirrors></settings>')).toBeNull();
    // Another tool's settings.xml (IDE, Android) with no password element.
    expect(secretFileKind('app/res/settings.xml', '<resources><string name="title">Settings</string></resources>')).toBeNull();
  });

  it('pip.conf / pip.ini is refused for credentials in an index URL or a password', () => {
    for (const file of ['pip.conf', '.pip/pip.conf', 'etc/pip.conf', 'pip.ini']) expect(secretFileNeedsContent(file)).toBe(true);
    expect(secretFileKind('pip.conf', '[global]\nindex-url = https://ci:s3cret@pypi.acme.dev/simple\n')).toBe('pip_conf');
    expect(secretFileKind('.pip/pip.conf', '[global]\nextra-index-url =\n    https://pypi.org/simple\n    https://glpat-abc123@gitlab.acme.dev/api/v4/projects/1/packages/pypi/simple\n')).toBe('pip_conf');
    expect(secretFileKind('pip.ini', '[global]\nindex-url = https://pypi.acme.dev/simple\nusername = ci\npassword = s3cret\n')).toBe('pip_conf');
    expect(secretFileKind('pip.conf', '[global]\nindex-url = https://pypi.acme.dev/simple\ntimeout = 60\n')).toBeNull();
    expect(secretFileKind('pip.conf', '[global]\nindex-url = https://ci:${PIP_PASSWORD}@pypi.acme.dev/simple\n')).toBeNull();
    expect(secretFileKind('pip.conf', '[global]\nindex-url = https://${PIP_TOKEN}@pypi.acme.dev/simple\n')).toBeNull();
    expect(secretFileKind('pip.conf', '[global]\npassword = ${PIP_PASSWORD}\n')).toBeNull();
  });

  it('RubyGems credentials are refused by name', () => {
    expect(secretFileNeedsContent('.gem/credentials')).toBe(false);
    expect(secretFileKind('.gem/credentials')).toBe('gem_credentials');
    expect(secretFileKind('home/.gem/credentials')).toBe('gem_credentials');
    expect(secretFileKind('gem/credentials')).toBeNull();
    expect(secretFileKind('lib/credentials.rb')).toBeNull();
  });

  it('Cargo credentials are refused when they carry a token', () => {
    expect(secretFileKind('.cargo/credentials.toml', '[registry]\ntoken = "cio_abc123"\n')).toBe('cargo_credentials');
    expect(secretFileKind('home/.cargo/credentials', '[registries.acme]\ntoken = "abc"\n')).toBe('cargo_credentials');
    expect(secretFileKind('.cargo/credentials.toml', '[registry]\nsecret-key = "k3.secret.abc"\n')).toBe('cargo_credentials');
    expect(secretFileKind('.cargo/credentials.toml', '[registry]\ntoken = "${CARGO_TOKEN}"\n')).toBeNull();
    expect(secretFileKind('.cargo/credentials.toml', '# no tokens here\n')).toBeNull();
    // Cargo's config.toml is not a credentials file.
    expect(secretFileNeedsContent('.cargo/config.toml')).toBe(true); // any file: the private-key content check
    expect(secretFileKind('.cargo/config.toml', '[build]\njobs = 4\ntoken = "not-a-credentials-file"\n')).toBeNull();
  });

  it('a GitHub CLI hosts.yml is refused when it carries an oauth_token', () => {
    expect(secretFileKind('.config/gh/hosts.yml', 'github.com:\n    user: octo\n    oauth_token: gho_abc123\n    git_protocol: https\n')).toBe('gh_hosts');
    expect(secretFileKind('home/.config/gh/hosts.yml', 'github.com:\n  oauth_token: "gho_abc"\n')).toBe('gh_hosts');
    expect(secretFileKind('.config/gh/hosts.yml', 'github.com:\n    user: octo\n    git_protocol: https\n')).toBeNull();
    expect(secretFileKind('.config/gh/hosts.yml', 'github.com:\n    oauth_token: ${GH_TOKEN}\n')).toBeNull();
    expect(secretFileKind('ansible/hosts.yml', 'all:\n  oauth_token: x\n')).toBeNull();
  });

  describe('private keys by content, under any name', () => {
    const BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nVJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvu\n';
    const block = (label: string) => `-----BEGIN ${label}-----\n${BODY}-----END ${label}-----\n`;
    const PPK = 'PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: me\nPublic-Lines: 2\nAAAAC3NzaC1lZDI1NTE5AAAAIOd\nPrivate-Lines: 1\nAAAAIFJ0dGVzdA==\nPrivate-MAC: abcd\n';

    it.each([
      ['deploy/key', block('RSA PRIVATE KEY')],
      ['config/signing.txt', block('PRIVATE KEY')],
      ['keys/ec', block('EC PRIVATE KEY')],
      ['ssh/deploy_key', block('OPENSSH PRIVATE KEY')],
      ['tls/enc', block('ENCRYPTED PRIVATE KEY')],
      ['gpg/secret.asc', `-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: x\n\n${BODY}=abcd\n-----END PGP PRIVATE KEY BLOCK-----\n`],
      ['scripts/setup.sh', `#!/bin/sh\ncat > /root/.ssh/id <<EOF\n${block('OPENSSH PRIVATE KEY')}EOF\n`],
      // Embedded in code with escaped newlines (a service-account key pasted into a JS file).
      ['src/auth.js', `const key = "${block('PRIVATE KEY').replace(/\n/g, '\\n')}";\n`],
      ['keys/me', PPK],
    ])('%s is refused for what it holds', (file, content) => {
      expect(secretFileNeedsContent(file)).toBe(true);
      expect(secretFileKind(file, content)).not.toBeNull();
    });

    it('labels the any-name kinds (and keeps the specific kind where one applies)', () => {
      expect(secretFileKind('deploy/key', block('RSA PRIVATE KEY'))).toBe('private_key_content');
      expect(secretFileKind('keys/me', PPK)).toBe('private_key_content');
      expect(secretFileKind('tls/server.pem', block('RSA PRIVATE KEY'))).toBe('private_key');
    });

    it('PuTTY .ppk and PKCS#8 .p8 files are refused by name', () => {
      expect(secretFileNeedsContent('keys/me.ppk')).toBe(false);
      expect(secretFileKind('keys/me.ppk')).toBe('putty_private_key');
      expect(secretFileKind('apple/AuthKey_ABC123.p8')).toBe('pkcs8_private_key');
    });

    it.each([
      ['public key PEM', 'keys/pub', block('PUBLIC KEY')],
      ['RSA public key PEM', 'keys/rsa.pub', block('RSA PUBLIC KEY')],
      ['certificate', 'certs/ca.crt', block('CERTIFICATE')],
      ['PGP public key', 'apt/repo.asc', `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n${BODY}-----END PGP PUBLIC KEY BLOCK-----\n`],
      ['OpenSSH public key', 'keys/id_ed25519.pub', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOd me@host\n'],
      ['a README showing the header', 'README.md', 'Paste your key, which starts with `-----BEGIN OPENSSH PRIVATE KEY-----`, into the secret.\n'],
      ['a placeholder block', 'docs/keys.md', '```\n-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n```\n'],
      ['a script that greps for keys', 'scan.sh', 'grep -l -- "-----BEGIN .* PRIVATE KEY-----" -r .\n'],
      ['mismatched BEGIN / END', 'odd.txt', `-----BEGIN RSA PRIVATE KEY-----\n${BODY}-----END CERTIFICATE-----\n`],
      ['PuTTY header without key lines', 'notes.txt', 'PuTTY-User-Key-File-3: is the first line of a .ppk\n'],
    ])('%s is allowed', (_what, file, content) => {
      expect(secretFileKind(file, content)).toBeNull();
    });

    it('a tar (a prebuilt image.tar) is not scanned: its layers may carry fixture keys from OS packages', () => {
      expect(secretFileNeedsContent('image.tar')).toBe(false);
      expect(secretFileKind('image.tar', block('RSA PRIVATE KEY'))).toBeNull();
    });
  });

  it('a content kind without content is not decided (the caller must pass it)', () => {
    expect(secretFileKind('tls/server.pem')).toBeNull();
  });

  it('every kind has a label', () => {
    for (const kind of Object.values(SECRET_FILE_KINDS)) expect(kind.label.length).toBeGreaterThan(0);
  });
});
