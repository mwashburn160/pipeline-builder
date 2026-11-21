// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';
import path from 'path';
import { jest, describe, it, expect, afterAll, afterEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import AdmZip from 'adm-zip';
import yauzl from 'yauzl';

// Mock uuid to produce deterministic values
jest.unstable_mockModule('uuid', () => ({
  v7: jest.fn(() => '01234567-89ab-cdef-0123-456789abcdef'),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  CoreConstants: {},
  // Template-validator dependencies — minimal stubs so plugin-spec.ts loads
  allowedScopeRoots: () => () => true,
  validateTemplates: () => ({ valid: true, errors: [] }),
  tokenize: () => [],
  Config: (() => {
    const get = (section: string) => {
      if (section === 'registry') return { http: true };
      if (section === 'dockerConfig') {
        return {
          tempRoot: path.join(process.cwd(), 'tmp'),
          timeoutMs: 900000,
          pushTimeoutMs: 300000,
          buildkitAddr: 'unix:///run/buildkit/buildkitd.sock',
        };
      }
      return {};
    };
    return { get, getAny: get };
  })(),
}));

const { parsePluginZip, validateBuildArgs } = await import('../src/helpers/plugin-spec.js');
const { extractionLimits } = await import('../src/helpers/zip-extract.js');
const { ValidationError } = await import('@pipeline-builder/api-core');

// Helper: build an in-memory ZIP with the given entries
function buildZip(entries: Record<string, string>): string {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(content, 'utf-8'));
  }
  const tmpDir = path.join(process.cwd(), 'tmp', 'test-zips');
  fs.mkdirSync(tmpDir, { recursive: true });
  const zipPath = path.join(tmpDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  zip.writeZip(zipPath);
  return zipPath;
}

afterAll(() => {
  const tmpDir = path.join(process.cwd(), 'tmp');
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// parsePluginZip
// ---------------------------------------------------------------------------

describe('parsePluginZip', () => {
  it('should parse a valid ZIP with plugin-spec.yaml and Dockerfile', async () => {
    const pluginSpecYaml = `
name: my-plugin
version: "1.0.0"
commands:
  - npm run build
`;
    const zipPath = buildZip({
      'plugin-spec.yaml': pluginSpecYaml,
      'Dockerfile': 'FROM node:20\nRUN echo hello',
    });

    const result = await parsePluginZip(zipPath);

    expect(result.pluginSpec.name).toBe('my-plugin');
    expect(result.pluginSpec.version).toBe('1.0.0');
    expect(result.pluginSpec.commands).toEqual(['npm run build']);
    expect(result.dockerfile).toBe('Dockerfile');
    expect(result.dockerfileContent).toContain('FROM node:20');
    expect(result.buildType).toBe('build_image');
    expect(fs.existsSync(result.extractDir)).toBe(true);
  });

  it('should throw when plugin-spec.yaml is missing', async () => {
    const zipPath = buildZip({
      'Dockerfile': 'FROM node:20',
      'README.md': '# hello',
    });

    await expect(parsePluginZip(zipPath)).rejects.toThrow('plugin-spec.yaml file missing in ZIP');
  });

  it('should throw when required fields are missing', async () => {
    const pluginSpecYaml = 'description: incomplete spec';
    const zipPath = buildZip({ 'plugin-spec.yaml': pluginSpecYaml });

    await expect(parsePluginZip(zipPath)).rejects.toThrow('name, version, and commands are required');
  });

  it('refuses a name or version outside the plugin-spec shape on EVERY upload', async () => {
    const spec = (name: string, version: string) => `name: ${name}\nversion: ${version}\ncommands:\n  - echo hi\n`;
    await expect(parsePluginZip(buildZip({ 'plugin-spec.yaml': spec('"lint\\r\\nBcc: x"', '"1.0.0"') }))).rejects.toThrow(/name must match/);
    await expect(parsePluginZip(buildZip({ 'plugin-spec.yaml': spec('Lint', '"1.0.0"') }))).rejects.toThrow(/name must match/);
    await expect(parsePluginZip(buildZip({ 'plugin-spec.yaml': spec('a'.repeat(65), '"1.0.0"') }))).rejects.toThrow(/at most 64/);
    await expect(parsePluginZip(buildZip({ 'plugin-spec.yaml': spec('lint', '"1.0.0\\nx"') }))).rejects.toThrow(/version must be semver/);
  });

  it('should throw on path traversal in dockerfile field', async () => {
    const pluginSpecYaml = `
name: evil-plugin
version: "1.0.0"
commands:
  - echo pwned
dockerfile: "../../../etc/passwd"
`;
    const zipPath = buildZip({ 'plugin-spec.yaml': pluginSpecYaml });

    await expect(parsePluginZip(zipPath)).rejects.toThrow('path traversal');
  });

  it('should throw on absolute dockerfile path', async () => {
    const pluginSpecYaml = `
name: evil-plugin
version: "1.0.0"
commands:
  - echo pwned
dockerfile: "/etc/passwd"
`;
    const zipPath = buildZip({ 'plugin-spec.yaml': pluginSpecYaml });

    await expect(parsePluginZip(zipPath)).rejects.toThrow('path traversal');
  });

  // The CLI packs the plugin directory wholesale, so a developer's .env / SSH key
  // there was uploaded, staged and sent to BuildKit as build context (and baked
  // into the image by `COPY . .`). Refused at upload, naming the file.
  it.each(['.env', 'src/.env.production', 'keys/id_ed25519', '.aws/credentials', 'home/.docker/config.json', '.netrc', '.git-credentials', '.pypirc'])(
    'refuses a ZIP carrying the credential file %s',
    async (secretPath) => {
      const zipPath = buildZip({
        'plugin-spec.yaml': 'name: leaky\nversion: "1.0.0"\ncommands:\n  - make\n',
        'Dockerfile': 'FROM node:20',
        [secretPath]: 'TOKEN=hunter2',
      });
      await expect(parsePluginZip(zipPath)).rejects.toThrow(`ZIP entry ${secretPath} looks like a`);
    },
  );

  it('allows dotenv templates and public keys', async () => {
    const zipPath = buildZip({
      'plugin-spec.yaml': 'name: tidy\nversion: "1.0.0"\ncommands:\n  - make\n',
      'Dockerfile': 'FROM node:20',
      '.env.example': 'TOKEN=',
      'config/.env.template': 'TOKEN=',
      'keys/id_rsa.pub': 'ssh-rsa AAAA',
      'docs/environment.md': '# env',
    });
    const result = await parsePluginZip(zipPath);
    expect(fs.existsSync(path.join(result.extractDir, '.env.example'))).toBe(true);
  });

  it.each([
    ['.envrc', 'export TOKEN=hunter2', 'direnv file'],
    ['config/prod.env', 'TOKEN=hunter2', 'dotenv file'],
    ['certs/client.p12', 'binary', 'PKCS#12 key bundle'],
    ['home/.kube/config', 'apiVersion: v1', 'Kubernetes kubeconfig'],
    ['gcloud/application_default_credentials.json', '{}', 'gcloud application-default credentials'],
    ['tls/server.pem', '-----BEGIN CERTIFICATE-----\nAA\n-----END CERTIFICATE-----\n-----BEGIN EC PRIVATE KEY-----\nAA\n-----END EC PRIVATE KEY-----\n', 'private key'],
    ['tls/server.key', '-----BEGIN PRIVATE KEY-----\nAA\n-----END PRIVATE KEY-----\n', 'private key'],
    ['deploy/sa.json', '{"type": "service_account", "project_id": "p", "private_key": "-----BEGIN PRIVATE KEY-----"}', 'cloud service-account key'],
    ['.npmrc', '//registry.npmjs.org/:_authToken=npm_abc123', 'npm auth token (.npmrc)'],
    ['.yarnrc.yml', 'npmAuthToken: npm_abc123', 'npm auth token (.yarnrc.yml)'],
    ['.m2/settings.xml', '<settings><servers><server><id>r</id><password>s3cret</password></server></servers></settings>', 'Maven settings.xml with a password'],
    ['.pip/pip.conf', '[global]\nindex-url = https://ci:s3cret@pypi.acme.dev/simple\n', 'pip configuration with credentials'],
    ['.gem/credentials', '---\n:rubygems_api_key: rubygems_abc\n', 'RubyGems credentials file'],
    ['.cargo/credentials.toml', '[registry]\ntoken = "cio_abc"\n', 'Cargo registry credentials'],
    ['.config/gh/hosts.yml', 'github.com:\n    oauth_token: gho_abc\n', 'GitHub CLI token (gh hosts.yml)'],
    ['scripts/install.sh', 'cat > key <<EOF\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----\nEOF\n', 'private key'],
    ['keys/deploy.ppk', 'PuTTY-User-Key-File-3: ssh-ed25519\n', 'PuTTY private key'],
    ['AuthKey_ABC.p8', 'binary', 'PKCS#8 private key'],
  ])('refuses a ZIP carrying %s (decided by name or by its content)', async (secretPath, content, label) => {
    const zipPath = buildZip({
      'plugin-spec.yaml': 'name: leaky\nversion: "1.0.0"\ncommands:\n  - make\n',
      'Dockerfile': 'FROM node:20',
      [secretPath]: content,
    });
    await expect(parsePluginZip(zipPath)).rejects.toThrow(`ZIP entry ${secretPath} looks like a ${label}`);
  });

  it('allows certificates, public keys, ordinary JSON and token-free npm config (content guards)', async () => {
    const zipPath = buildZip({
      'plugin-spec.yaml': 'name: tidy\nversion: "1.0.0"\ncommands:\n  - make\n',
      'Dockerfile': 'FROM node:20',
      'certs/ca.pem': '-----BEGIN CERTIFICATE-----\nAA\n-----END CERTIFICATE-----\n',
      'apt/docker.key': '-----BEGIN PGP PUBLIC KEY BLOCK-----\nAA\n-----END PGP PUBLIC KEY BLOCK-----\n',
      'package.json': '{"name": "x", "type": "module"}',
      '.npmrc': 'registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n',
      '.yarnrc.yml': 'nodeLinker: node-modules\n',
      'example.env': 'TOKEN=',
      'settings.xml': '<settings><servers><server><password>${env.MAVEN_PASSWORD}</password></server></servers></settings>',
      'pip.conf': '[global]\nindex-url = https://${PIP_TOKEN}@pypi.acme.dev/simple\n',
      '.cargo/credentials.toml': '[registry]\ntoken = "${CARGO_TOKEN}"\n',
      '.config/gh/hosts.yml': 'github.com:\n    user: octo\n',
      'README.md': 'Your key starts with -----BEGIN OPENSSH PRIVATE KEY-----\n',
      'keys/pub.pem': '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----\n',
    });
    const result = await parsePluginZip(zipPath);
    expect(fs.existsSync(path.join(result.extractDir, 'certs/ca.pem'))).toBe(true);
    expect(fs.existsSync(path.join(result.extractDir, '.npmrc'))).toBe(true);
  });

  // Accepted, a build_image upload with no Dockerfile only failed later in the
  // build — on a missing file every retry would miss again. Refused at upload
  // with the missing path named instead.
  it('refuses a build_image upload whose named Dockerfile is not in the ZIP', async () => {
    const pluginSpecYaml = `
name: no-docker
version: "2.0.0"
commands:
  - make build
dockerfile: missing-dockerfile
`;
    const zipPath = buildZip({ 'plugin-spec.yaml': pluginSpecYaml });

    await expect(parsePluginZip(zipPath)).rejects.toThrow(ValidationError);
    await expect(parsePluginZip(zipPath)).rejects.toThrow('"missing-dockerfile" is not in the uploaded ZIP');
  });

  it('refuses a build_image upload with no Dockerfile at the default path', async () => {
    const pluginSpecYaml = `
name: no-docker
version: "2.0.0"
commands:
  - make build
`;
    const zipPath = buildZip({ 'plugin-spec.yaml': pluginSpecYaml });

    await expect(parsePluginZip(zipPath)).rejects.toThrow('A build_image plugin needs a Dockerfile: "Dockerfile" is not in the uploaded ZIP');
  });

  it('should use default Dockerfile when spec does not specify one', async () => {
    const pluginSpecYaml = `
name: default-docker
version: "1.0.0"
commands:
  - npm start
`;
    const zipPath = buildZip({
      'plugin-spec.yaml': pluginSpecYaml,
      'Dockerfile': 'FROM alpine:3',
    });

    const result = await parsePluginZip(zipPath);
    expect(result.dockerfile).toBe('Dockerfile');
    expect(result.dockerfileContent).toBe('FROM alpine:3');
  });
});

// ---------------------------------------------------------------------------
// config.yaml validation (Zod schema)
// ---------------------------------------------------------------------------

describe('config.yaml validation', () => {
  it('should accept valid build_image config', async () => {
    const pluginSpecYaml = `
name: cfg-test
version: "1.0.0"
commands:
  - echo ok
`;
    const configYaml = `
pluginSpec: plugin-spec.yaml
dockerfile: Dockerfile
buildType: build_image
`;
    const zipPath = buildZip({
      'plugin-spec.yaml': pluginSpecYaml,
      'config.yaml': configYaml,
      'Dockerfile': 'FROM node:20',
    });

    const result = await parsePluginZip(zipPath);
    expect(result.buildType).toBe('build_image');
  });

  it('should accept valid prebuilt config', async () => {
    const pluginSpecYaml = `
name: prebuilt-test
version: "1.0.0"
commands:
  - echo ok
`;
    const configYaml = `
pluginSpec: plugin-spec.yaml
buildType: prebuilt
`;
    const zipPath = buildZip({
      'plugin-spec.yaml': pluginSpecYaml,
      'config.yaml': configYaml,
      'image.tar': 'fake-tar-content',
    });

    const result = await parsePluginZip(zipPath);
    expect(result.buildType).toBe('prebuilt');
    expect(result.dockerfile).toBe('');
    expect(result.dockerfileContent).toBeNull();
  });

  it('should reject unknown keys in config.yaml', async () => {
    const pluginSpecYaml = `
name: bad-config
version: "1.0.0"
commands:
  - echo ok
`;
    const configYaml = `
pluginSpec: plugin-spec.yaml
unknownKey: bad
`;
    const zipPath = buildZip({
      'plugin-spec.yaml': pluginSpecYaml,
      'config.yaml': configYaml,
    });

    await expect(parsePluginZip(zipPath)).rejects.toThrow('config.yaml');
  });

  it('should reject invalid buildType', async () => {
    const pluginSpecYaml = `
name: bad-type
version: "1.0.0"
commands:
  - echo ok
`;
    const configYaml = `
pluginSpec: plugin-spec.yaml
buildType: invalid_type
`;
    const zipPath = buildZip({
      'plugin-spec.yaml': pluginSpecYaml,
      'config.yaml': configYaml,
    });

    await expect(parsePluginZip(zipPath)).rejects.toThrow('config.yaml');
  });

  it('should reject prebuilt with dockerfile', async () => {
    const pluginSpecYaml = `
name: conflict
version: "1.0.0"
commands:
  - echo ok
`;
    const configYaml = `
pluginSpec: plugin-spec.yaml
buildType: prebuilt
dockerfile: Dockerfile
`;
    const zipPath = buildZip({
      'plugin-spec.yaml': pluginSpecYaml,
      'config.yaml': configYaml,
    });

    await expect(parsePluginZip(zipPath)).rejects.toThrow('dockerfile is not allowed');
  });

});

// ---------------------------------------------------------------------------
// Zip-bomb decompression caps
// ---------------------------------------------------------------------------

describe('zip-bomb decompression caps', () => {
  // extractionLimits() reads these at call time, so per-test overrides work.
  afterEach(() => {
    delete process.env.PLUGIN_MAX_EXTRACT_BYTES;
    delete process.env.PLUGIN_MAX_EXTRACT_ENTRIES;
  });

  it('aborts extraction once cumulative bytes exceed the ceiling', async () => {
    process.env.PLUGIN_MAX_EXTRACT_BYTES = '200';
    const pluginSpecYaml = `
name: bomb
version: "1.0.0"
commands:
  - echo hi
`;
    const zipPath = buildZip({
      'plugin-spec.yaml': pluginSpecYaml,
      // A single benign-looking entry whose extracted size blows the 200-byte cap.
      'big.txt': 'A'.repeat(5000),
    });

    await expect(parsePluginZip(zipPath)).rejects.toThrow('maximum extracted size');
  });

  it('honours per-call limits (the anonymous path) over the service-wide ones', async () => {
    const zipPath = buildZip({
      'plugin-spec.yaml': 'name: small\nversion: "1.0.0"\ncommands:\n  - echo hi\n',
      'big.txt': 'A'.repeat(5000),
    });
    await expect(parsePluginZip(zipPath, { limits: { maxBytes: 1000, maxEntries: 10 } })).rejects.toThrow('maximum extracted size (1000 bytes)');
    await expect(parsePluginZip(zipPath, { limits: { maxBytes: 1_000_000, maxEntries: 1 } })).rejects.toThrow('maximum entry count (1)');
  });

  it('aborts extraction once the entry count exceeds the ceiling', async () => {
    process.env.PLUGIN_MAX_EXTRACT_ENTRIES = '2';
    const zipPath = buildZip({
      'plugin-spec.yaml': 'name: many\nversion: "1.0.0"\ncommands:\n  - echo hi\n',
      'a.txt': 'a',
      'b.txt': 'b',
      'c.txt': 'c',
    });

    await expect(parsePluginZip(zipPath)).rejects.toThrow('maximum entry count');
  });

  // A bare parseInt turned a typo'd value into NaN, and `total > NaN` is always
  // false — silently DISABLING the zip-bomb cap.
  it('a non-numeric cap falls back to the derived default instead of disabling the cap', async () => {
    process.env.PLUGIN_MAX_EXTRACT_BYTES = 'unlimited-please';
    process.env.PLUGIN_MAX_UPLOAD_MB = '1';
    process.env.PLUGIN_MAX_EXTRACT_RATIO = '1';
    try {
      const zipPath = buildZip({
        'plugin-spec.yaml': 'name: bomb\nversion: "1.0.0"\ncommands:\n  - echo hi\n',
        'big.txt': 'A'.repeat(2 * 1024 * 1024), // 2 MB > the 1 MB × 1 derived ceiling
      });

      await expect(parsePluginZip(zipPath)).rejects.toThrow('maximum extracted size');
    } finally {
      delete process.env.PLUGIN_MAX_UPLOAD_MB;
      delete process.env.PLUGIN_MAX_EXTRACT_RATIO;
    }
  });

  it('extractionLimits() never yields NaN for garbage env values', () => {
    process.env.PLUGIN_MAX_EXTRACT_BYTES = 'x';
    process.env.PLUGIN_MAX_EXTRACT_ENTRIES = 'y';
    process.env.PLUGIN_MAX_UPLOAD_MB = 'z';
    process.env.PLUGIN_MAX_EXTRACT_RATIO = 'w';
    try {
      expect(extractionLimits()).toEqual({ maxBytes: 4096 * 1024 * 1024 * 50, maxEntries: 10000 });
    } finally {
      delete process.env.PLUGIN_MAX_UPLOAD_MB;
      delete process.env.PLUGIN_MAX_EXTRACT_RATIO;
    }
  });

  it('does not clean-abort a normal small ZIP under the (default) ceiling', async () => {
    const zipPath = buildZip({
      'plugin-spec.yaml': 'name: fine\nversion: "1.0.0"\ncommands:\n  - echo hi\n',
      'Dockerfile': 'FROM alpine:3',
    });

    const result = await parsePluginZip(zipPath);
    expect(result.pluginSpec.name).toBe('fine');
  });
});

// ---------------------------------------------------------------------------
// zipfile fd cleanup — descriptor-leak defense
// ---------------------------------------------------------------------------

describe('zipfile fd cleanup', () => {
  afterEach(() => {
    delete process.env.PLUGIN_MAX_EXTRACT_ENTRIES;
    jest.restoreAllMocks();
  });

  it('closes the zipfile on a REJECTED extraction (entry-count cap) — fd-leak regression', async () => {
    // A malformed/zip-bomb upload used to leave the underlying fd open on every
    // reject path (only the success path closed it), so an attacker spamming
    // bad ZIPs could exhaust the descriptor table. The zipfile must be closed
    // on the reject path too. spyOn calls through, so the real fd is still closed.
    process.env.PLUGIN_MAX_EXTRACT_ENTRIES = '2';
    const closeSpy = jest.spyOn(yauzl.ZipFile.prototype, 'close');

    const zipPath = buildZip({
      'plugin-spec.yaml': 'name: many\nversion: "1.0.0"\ncommands:\n  - echo hi\n',
      'a.txt': 'a',
      'b.txt': 'b',
      'c.txt': 'c',
    });

    await expect(parsePluginZip(zipPath)).rejects.toThrow('maximum entry count');
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('closes the zipfile exactly once on a SUCCESSFUL extraction (no double-close)', async () => {
    const closeSpy = jest.spyOn(yauzl.ZipFile.prototype, 'close');

    const zipPath = buildZip({
      'plugin-spec.yaml': 'name: ok\nversion: "1.0.0"\ncommands:\n  - echo hi\n',
      'Dockerfile': 'FROM alpine:3',
    });

    await parsePluginZip(zipPath);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Plugin spec schema validation (Zod)
// ---------------------------------------------------------------------------

describe('plugin-spec schema validation', () => {
  it('rejects an invalid computeType', async () => {
    const zipPath = buildZip({
      'plugin-spec.yaml': 'name: bad-compute\nversion: "1.0.0"\ncomputeType: HUGE\ncommands:\n  - echo hi\n',
      'Dockerfile': 'FROM alpine:3',
    });

    await expect(parsePluginZip(zipPath)).rejects.toThrow('plugin-spec.yaml');
  });

  it('rejects an invalid pluginType', async () => {
    const zipPath = buildZip({
      'plugin-spec.yaml': 'name: bad-type\nversion: "1.0.0"\npluginType: WeirdStep\ncommands:\n  - echo hi\n',
      'Dockerfile': 'FROM alpine:3',
    });

    await expect(parsePluginZip(zipPath)).rejects.toThrow('plugin-spec.yaml');
  });

  it('rejects a non-integer timeout', async () => {
    const zipPath = buildZip({
      'plugin-spec.yaml': 'name: bad-timeout\nversion: "1.0.0"\ntimeout: not-a-number\ncommands:\n  - echo hi\n',
      'Dockerfile': 'FROM alpine:3',
    });

    await expect(parsePluginZip(zipPath)).rejects.toThrow('plugin-spec.yaml');
  });

  it('rejects an unknown top-level key (strict schema)', async () => {
    const zipPath = buildZip({
      'plugin-spec.yaml': 'name: extra\nversion: "1.0.0"\ncommands:\n  - echo hi\nbogusKey: nope\n',
      'Dockerfile': 'FROM alpine:3',
    });

    await expect(parsePluginZip(zipPath)).rejects.toThrow('plugin-spec.yaml');
  });

  it('accepts a fully-populated valid spec (enums, secrets, smokeTest)', async () => {
    const pluginSpecYaml = `
name: full
version: "1.0.0"
pluginType: CodeBuildStep
computeType: MEDIUM
timeout: 30
failureBehavior: warn
smokeTest: "tool --version"
secrets:
  - name: TOKEN
    required: true
commands:
  - echo build
`;
    const zipPath = buildZip({ 'plugin-spec.yaml': pluginSpecYaml, 'Dockerfile': 'FROM alpine:3' });

    const result = await parsePluginZip(zipPath);
    expect(result.pluginSpec.computeType).toBe('MEDIUM');
    expect(result.pluginSpec.failureBehavior).toBe('warn');
  });
});

// ---------------------------------------------------------------------------
// validateBuildArgs
// ---------------------------------------------------------------------------

describe('validateBuildArgs', () => {
  it('should accept a valid Record<string, string>', () => {
    expect(() => validateBuildArgs({ NODE_ENV: 'production', VERSION: '1.0.0' })).not.toThrow();
  });

  it('should accept undefined', () => {
    expect(() => validateBuildArgs(undefined)).not.toThrow();
  });

  it('should accept null', () => {
    expect(() => validateBuildArgs(null)).not.toThrow();
  });

  it('should reject arrays', () => {
    expect(() => validateBuildArgs(['a', 'b'])).toThrow('buildArgs must be a plain object');
  });

  it('should reject non-string values', () => {
    expect(() => validateBuildArgs({ key: 123 })).toThrow('keys and values must be strings');
  });

  it('should reject more than 20 entries', () => {
    const tooMany: Record<string, string> = {};
    for (let i = 0; i < 21; i++) tooMany[`key${i}`] = `value${i}`;
    expect(() => validateBuildArgs(tooMany)).toThrow('cannot have more than 20 entries');
  });

  it('should reject keys longer than 1000 characters', () => {
    expect(() => validateBuildArgs({ ['k'.repeat(1001)]: 'value' })).toThrow('key exceeds 1000 characters');
  });

  it('should reject values longer than 4096 characters', () => {
    expect(() => validateBuildArgs({ key: 'v'.repeat(4097) })).toThrow('exceeds 4096 characters');
  });
});

// The managed build image.
describe('parsePluginZip — BuildImage', () => {
  const spec = `
name: pipeline-bootstrap
version: "1.0.0"
pluginType: BuildImage
toolchain:
  pipelineManager: "4.4.19"
  awsCdk: "2.1100.0"
  cdkAssets: "3.2.0"
  node: "24.11.0"
sourceDigest: "${'a'.repeat(64)}"
`;

  it('accepts a prebuilt BuildImage with no commands', async () => {
    const result = await parsePluginZip(buildZip({
      'plugin-spec.yaml': spec,
      'config.yaml': 'pluginSpec: plugin-spec.yaml\nbuildType: prebuilt\n',
      'image.tar': 'fake-tar-content',
    }));
    expect(result.buildType).toBe('prebuilt');
    expect(result.pluginSpec.pluginType).toBe('BuildImage');
  });

  it('refuses a BuildImage the platform would build from source', async () => {
    await expect(parsePluginZip(buildZip({
      'plugin-spec.yaml': spec,
      'config.yaml': 'pluginSpec: plugin-spec.yaml\ndockerfile: Dockerfile\nbuildType: build_image\n',
      'Dockerfile': 'FROM scratch\n',
    }))).rejects.toThrow(/must be uploaded prebuilt/);
  });

  it('refuses a BuildImage carrying commands, or under a non-managed name', async () => {
    const prebuilt = { 'config.yaml': 'pluginSpec: plugin-spec.yaml\nbuildType: prebuilt\n', 'image.tar': 'x' };
    await expect(parsePluginZip(buildZip({ ...prebuilt, 'plugin-spec.yaml': `${spec}commands:\n  - echo hi\n` })))
      .rejects.toThrow(/commands: is not allowed on a BuildImage plugin/);
    await expect(parsePluginZip(buildZip({ ...prebuilt, 'plugin-spec.yaml': spec.replace('name: pipeline-bootstrap', 'name: my-image') })))
      .rejects.toThrow(/reserved for the managed toolchain plugins/);
  });
});
