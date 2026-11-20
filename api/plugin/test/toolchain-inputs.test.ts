// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A toolchain release's kept build inputs (services/remediation/toolchain-inputs.ts):
 * what an upload keeps (top-level text inputs only), where, and how a missing,
 * garbled or wrong-shaped object reads (as missing — the fix then goes to the
 * owner — never as a crash of the remediation job).
 */

import * as fs from 'fs';
import * as os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';

const realApiCore = await import('@pipeline-builder/api-core');
const counters: Array<[string, Record<string, string>]> = [];
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: (name: string, labels: Record<string, string>) => { counters.push([name, labels]); },
}));
const send = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core/s3', () => stubModule('@pipeline-builder/api-core/s3', { s3Client: () => ({ send }), ensureBucket: jest.fn() }));
const put = jest.fn<AnyFn>(async () => undefined);
jest.unstable_mockModule('../src/services/plugin-sources.js', () => ({ pluginSourcesBucket: () => 'plugin-sources', putRemediationArtifact: put }));

const { keepToolchainInputs, liveToolchainInputs, readToolchainInputs, toolchainInputsKey } = await import('../src/services/remediation/toolchain-inputs.js');

const body = (text: string) => ({ Body: { transformToString: async () => text } });
const dirWith = (files: Record<string, string | Buffer>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-inputs-'));
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c);
  return dir;
};

beforeEach(() => { jest.clearAllMocks(); counters.length = 0; });

describe('what an upload keeps', () => {
  it('top-level text inputs only: never image.tar, config.yaml, README.md, a binary, a sub-directory or an oversized file', () => {
    const dir = dirWith({
      'Dockerfile': 'FROM x\n',
      'plugin-spec.yaml': 'name: a\n',
      'config.yaml': 'buildType: prebuilt\n',
      'README.md': '# a',
      'image.tar': 'tar',
      'blob.bin': Buffer.from([1, 0, 2]),
      'huge.txt': 'x'.repeat(256 * 1024 + 1),
    });
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'nested'), 'n');
    expect(readToolchainInputs(dir)).toEqual({ 'Dockerfile': 'FROM x\n', 'plugin-spec.yaml': 'name: a\n' });
  });

  it('keeps them under the system org\'s toolchain-inputs/<release>/<half>.json', async () => {
    const dir = dirWith({ 'Dockerfile': 'FROM x\n', 'plugin-spec.yaml': 's' });
    expect(await keepToolchainInputs('1.2.3', 'cdk-synth', dir)).toBe(true);
    expect(put).toHaveBeenCalledWith(`${realApiCore.SYSTEM_ORG_ID.toLowerCase()}/toolchain-inputs/1.2.3/cdk-synth.json`, JSON.stringify({ 'Dockerfile': 'FROM x\n', 'plugin-spec.yaml': 's' }));
    expect(toolchainInputsKey('1.2.3', 'cdk-synth')).toBe(`${realApiCore.SYSTEM_ORG_ID.toLowerCase()}/toolchain-inputs/1.2.3/cdk-synth.json`);
  });

  it('a store failure never fails the upload: it is counted (alerted) and answers false', async () => {
    put.mockRejectedValueOnce(new Error('rustfs down'));
    expect(await keepToolchainInputs('1.2.3', 'pipeline-bootstrap', dirWith({ 'plugin-spec.yaml': 's' }))).toBe(false);
    expect(counters).toEqual([['toolchain_fix_failures_total', { stage: 'keep_inputs' }]]);
  });

  it('an unreadable upload directory is counted the same way', async () => {
    expect(await keepToolchainInputs('1.2.3', 'pipeline-bootstrap', '/definitely/not/here')).toBe(false);
    expect(counters).toEqual([['toolchain_fix_failures_total', { stage: 'keep_inputs' }]]);
    expect(put).not.toHaveBeenCalled();
  });
});

describe('reading them back', () => {
  it('a kept object reads back as its file map, from the plugin-sources bucket', async () => {
    send.mockResolvedValueOnce(body(JSON.stringify({ Dockerfile: 'FROM x\n' })));
    expect(await liveToolchainInputs.read('1.2.3', 'pipeline-bootstrap')).toEqual({ Dockerfile: 'FROM x\n' });
    expect((send.mock.calls[0]![0] as { input: unknown }).input).toEqual({ Bucket: 'plugin-sources', Key: toolchainInputsKey('1.2.3', 'pipeline-bootstrap') });
  });

  it('missing (NoSuchKey) reads as null', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'NoSuchKey' }));
    expect(await liveToolchainInputs.read('1.2.3', 'cdk-synth')).toBeNull();
  });

  it.each([
    ['garbled JSON', 'not json {'],
    ['an array', '["Dockerfile"]'],
    ['a non-string file', '{"Dockerfile": 7}'],
    ['an empty body', ''],
  ])('%s reads as null (missing), never crashing the remediation job', async (_label, text) => {
    send.mockResolvedValueOnce(body(text));
    expect(await liveToolchainInputs.read('1.2.3', 'cdk-synth')).toBeNull();
  });

  it('any other storage error is thrown (the job retries it)', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    await expect(liveToolchainInputs.read('1.2.3', 'cdk-synth')).rejects.toThrow('denied');
  });

  it('write stores the JSON at the key', async () => {
    await liveToolchainInputs.write('2.0.0', 'pipeline-bootstrap', { Dockerfile: 'd' });
    expect(put).toHaveBeenCalledWith(toolchainInputsKey('2.0.0', 'pipeline-bootstrap'), '{"Dockerfile":"d"}');
  });
});
