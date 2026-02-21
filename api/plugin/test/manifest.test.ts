import * as fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { parsePluginZip, ValidationError } from '../src/helpers/manifest';

// ---------------------------------------------------------------------------
// Mock uuid to produce deterministic values
// ---------------------------------------------------------------------------
jest.mock('uuid', () => ({
  v7: jest.fn(() => '01234567-89ab-cdef-0123-456789abcdef'),
}));

jest.mock('@mwashburn160/pipeline-core', () => ({
  __esModule: true,
}));

// ---------------------------------------------------------------------------
// Helper: build an in-memory ZIP with the given entries
// ---------------------------------------------------------------------------
function buildZip(entries: Record<string, string>): string {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(content, 'utf-8'));
  }
  const tmpDir = path.join(process.cwd(), 'tmp', 'test-zips');
  fs.mkdirSync(tmpDir, { recursive: true });
  const zipPath = path.join(tmpDir, `test-${Date.now()}.zip`);
  zip.writeZip(zipPath);
  return zipPath;
}

// ---------------------------------------------------------------------------
// Cleanup after tests
// ---------------------------------------------------------------------------
afterAll(() => {
  const tmpDir = path.join(process.cwd(), 'tmp');
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parsePluginZip', () => {
  it('should parse a valid ZIP with manifest.yaml', () => {
    const manifest = `
name: my-plugin
version: "1.0.0"
commands:
  - npm run build
`;
    const zipPath = buildZip({
      'manifest.yaml': manifest,
      'Dockerfile': 'FROM node:20\nRUN echo hello',
    });

    const result = parsePluginZip(zipPath);

    expect(result.manifest.name).toBe('my-plugin');
    expect(result.manifest.version).toBe('1.0.0');
    expect(result.manifest.commands).toEqual(['npm run build']);
    expect(result.dockerfile).toBe('Dockerfile');
    expect(result.dockerfileContent).toContain('FROM node:20');
    expect(result.imageTag).toMatch(/^p-myplugin-/);
    expect(fs.existsSync(result.extractDir)).toBe(true);
  });

  it('should throw when manifest.yaml is missing', () => {
    const zipPath = buildZip({
      'Dockerfile': 'FROM node:20',
      'README.md': '# hello',
    });

    expect(() => parsePluginZip(zipPath)).toThrow(ValidationError);
    expect(() => parsePluginZip(zipPath)).toThrow('manifest.yaml file missing in ZIP');
  });

  it('should throw when required manifest fields are missing', () => {
    const zipPath = buildZip({
      'manifest.yaml': 'description: incomplete manifest',
    });

    expect(() => parsePluginZip(zipPath)).toThrow(ValidationError);
    expect(() => parsePluginZip(zipPath)).toThrow('name, version, and commands are required');
  });

  it('should throw on path traversal in dockerfile field', () => {
    const manifest = `
name: evil-plugin
version: "1.0.0"
commands:
  - echo pwned
dockerfile: "../../../etc/passwd"
`;
    const zipPath = buildZip({ 'manifest.yaml': manifest });

    expect(() => parsePluginZip(zipPath)).toThrow(ValidationError);
    expect(() => parsePluginZip(zipPath)).toThrow('path traversal');
  });

  it('should throw on absolute dockerfile path', () => {
    const manifest = `
name: evil-plugin
version: "1.0.0"
commands:
  - echo pwned
dockerfile: "/etc/passwd"
`;
    const zipPath = buildZip({ 'manifest.yaml': manifest });

    expect(() => parsePluginZip(zipPath)).toThrow(ValidationError);
  });

  it('should return null dockerfileContent when Dockerfile is not present', () => {
    const manifest = `
name: no-docker
version: "2.0.0"
commands:
  - make build
dockerfile: missing-dockerfile
`;
    const zipPath = buildZip({ 'manifest.yaml': manifest });

    const result = parsePluginZip(zipPath);
    expect(result.dockerfileContent).toBeNull();
  });

  it('should use default Dockerfile when manifest does not specify one', () => {
    const manifest = `
name: default-docker
version: "1.0.0"
commands:
  - npm start
`;
    const zipPath = buildZip({
      'manifest.yaml': manifest,
      'Dockerfile': 'FROM alpine:3',
    });

    const result = parsePluginZip(zipPath);
    expect(result.dockerfile).toBe('Dockerfile');
    expect(result.dockerfileContent).toBe('FROM alpine:3');
  });
});

describe('ValidationError', () => {
  it('should be an instance of Error', () => {
    const err = new ValidationError('test message');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ValidationError');
    expect(err.message).toBe('test message');
  });
});
