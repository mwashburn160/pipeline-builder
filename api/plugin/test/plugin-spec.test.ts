// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { parsePluginZip, validateBuildArgs } from '../src/helpers/plugin-spec';

// Mock uuid to produce deterministic values
jest.mock('uuid', () => ({
  v7: jest.fn(() => '01234567-89ab-cdef-0123-456789abcdef'),
}));

jest.mock('@pipeline-builder/pipeline-core', () => ({
  __esModule: true,
  CoreConstants: {
    PLUGIN_IMAGE_PREFIX: 'p-',
  },
  // Template-validator dependencies — minimal stubs so plugin-spec.ts loads
  allowedScopeRoots: () => () => true,
  validateTemplates: () => ({ valid: true, errors: [] }),
  tokenize: () => [],
  Config: (() => {
    const get = (section: string) => {
      if (section === 'registry') return { insecure: true };
      if (section === 'dockerConfig') {
        return {
          strategy: 'podman',
          tempRoot: path.join(process.cwd(), 'tmp'),
          timeoutMs: 900000,
          pushTimeoutMs: 300000,
          kanikoExecutor: '/kaniko/executor',
          kanikoCacheDir: '/kaniko/cache',
        };
      }
      return {};
    };
    return { get, getAny: get };
  })(),
}));

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
    expect(result.imageTag).toMatch(/^p-myplugin-/);
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

  it('should return null dockerfileContent when Dockerfile is not present', async () => {
    const pluginSpecYaml = `
name: no-docker
version: "2.0.0"
commands:
  - make build
dockerfile: missing-dockerfile
`;
    const zipPath = buildZip({ 'plugin-spec.yaml': pluginSpecYaml });

    const result = await parsePluginZip(zipPath);
    expect(result.dockerfileContent).toBeNull();
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
imageTag: p-prebuilttest-aabbccddee11
`;
    const zipPath = buildZip({
      'plugin-spec.yaml': pluginSpecYaml,
      'config.yaml': configYaml,
      'image.tar': 'fake-tar-content',
    });

    const result = await parsePluginZip(zipPath);
    expect(result.buildType).toBe('prebuilt');
    expect(result.imageTag).toBe('p-prebuilttest-aabbccddee11');
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

  it('should reject prebuilt without imageTag', async () => {
    const pluginSpecYaml = `
name: no-tag
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
    });

    await expect(parsePluginZip(zipPath)).rejects.toThrow('imageTag is required');
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
imageTag: p-conflict-aabbccddee11
`;
    const zipPath = buildZip({
      'plugin-spec.yaml': pluginSpecYaml,
      'config.yaml': configYaml,
    });

    await expect(parsePluginZip(zipPath)).rejects.toThrow('dockerfile is not allowed');
  });

  it('should reject build_image with imageTag', async () => {
    const pluginSpecYaml = `
name: bad-combo
version: "1.0.0"
commands:
  - echo ok
`;
    const configYaml = `
pluginSpec: plugin-spec.yaml
buildType: build_image
imageTag: p-badcombo-aabbccddee11
`;
    const zipPath = buildZip({
      'plugin-spec.yaml': pluginSpecYaml,
      'config.yaml': configYaml,
    });

    await expect(parsePluginZip(zipPath)).rejects.toThrow('imageTag is not allowed');
  });

  it('should reject invalid imageTag format', async () => {
    const pluginSpecYaml = `
name: bad-tag
version: "1.0.0"
commands:
  - echo ok
`;
    const configYaml = `
pluginSpec: plugin-spec.yaml
buildType: prebuilt
imageTag: not-a-valid-tag
`;
    const zipPath = buildZip({
      'plugin-spec.yaml': pluginSpecYaml,
      'config.yaml': configYaml,
    });

    await expect(parsePluginZip(zipPath)).rejects.toThrow('imageTag must match');
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
