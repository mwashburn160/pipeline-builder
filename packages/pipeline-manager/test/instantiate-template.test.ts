// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI tests for `template instantiate`. Exercises name→id resolution (including
 * the ambiguous/missing cases that must NOT guess), input collection and
 * precedence, and the rendered-props output paths — all against a mocked client.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockCreateAuthenticatedClient = jest.fn();
const mockOutputData = jest.fn();
const mockPrintWarning = jest.fn();

jest.unstable_mockModule('../src/utils/output-utils.js', () => ({
  __esModule: true,
  printCommandHeader: () => 'EXEC-TEST',
  printSslWarning: jest.fn(),
  printSuccess: jest.fn(),
  printWarning: mockPrintWarning,
  printInfo: jest.fn(),
  printError: jest.fn(),
  printKeyValue: jest.fn(),
  printSection: jest.fn(),
  printDebug: jest.fn(),
  outputData: mockOutputData,
}));

jest.unstable_mockModule('../src/utils/command-utils.js', () => ({
  __esModule: true,
  printCommandHeader: () => 'EXEC-TEST',
  printExecutionSummary: jest.fn(),
  printSslWarning: jest.fn(),
  createAuthenticatedClient: mockCreateAuthenticatedClient,
  withSslOptions: (cmd: unknown) => cmd,
}));

const { Command } = await import('commander');
const { instantiateTemplate } = await import('../src/commands/instantiate-template.js');

const TEMPLATE_URL = '/api/pipeline-templates';

/** Rendered props the platform returns for the happy path. */
const RENDERED = {
  project: 'react',
  organization: 'AcmeCorp',
  vars: { orgId: 'org-uuid' },
  synth: { source: { options: { token: 'secretsmanager:pipeline-builder/{{ pipeline.vars.orgId }}/github-token' } } },
  stages: [{ stageName: 'Build' }, { stageName: 'Security' }],
};

function mockClient(overrides: { templates?: unknown[]; props?: unknown } = {}) {
  const get = jest.fn<(url: string, params?: unknown) => Promise<unknown>>()
    .mockResolvedValue({
      success: true,
      data: { templates: overrides.templates ?? [{ id: 'tpl-1', name: 'react-javascript' }] },
    });
  const post = jest.fn<(url: string, body?: unknown) => Promise<unknown>>()
    .mockResolvedValue({ success: true, data: { props: overrides.props ?? RENDERED } });
  mockCreateAuthenticatedClient.mockReturnValue({
    getConfig: () => ({ api: { pipelineTemplateUrl: TEMPLATE_URL } }),
    get,
    post,
  });
  return { get, post };
}

let exitSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  jest.clearAllMocks();
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__EXIT_${code ?? 0}__`);
  }) as never);
});

afterEach(() => { exitSpy.mockRestore(); });

function runCli(args: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  // Mirror production wiring: the `instantiate` leaf under the `template` namespace.
  const template = program.command('template');
  instantiateTemplate(template);
  return program.parseAsync(['node', 'test', 'template', 'instantiate', ...args]);
}

const BASE = ['--project', 'react', '--organization', 'AcmeCorp'];

describe('template instantiate', () => {
  it('resolves --name to an id and posts the instantiate body', async () => {
    const { get, post } = mockClient();

    await runCli([...BASE, '--name', 'react-javascript', '--input', 'orgId=org-uuid']);

    expect(get).toHaveBeenCalledWith(TEMPLATE_URL, { name: 'react-javascript', limit: 100 });
    expect(post).toHaveBeenCalledWith(`${TEMPLATE_URL}/tpl-1/instantiate`, {
      project: 'react',
      organization: 'AcmeCorp',
      inputs: { orgId: 'org-uuid' },
    });
    expect(mockOutputData).toHaveBeenCalledWith(RENDERED, expect.objectContaining({ format: 'json' }));
  });

  it('--id skips the catalog lookup entirely', async () => {
    const { get, post } = mockClient();

    await runCli([...BASE, '--id', 'tpl-99']);

    expect(get).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(`${TEMPLATE_URL}/tpl-99/instantiate`, {
      project: 'react',
      organization: 'AcmeCorp',
    });
  });

  it('sends pipelineName when --pipeline-name is given', async () => {
    const { post } = mockClient();

    await runCli([...BASE, '--id', 'tpl-1', '--pipeline-name', 'my-pipeline']);

    expect(post).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ pipelineName: 'my-pipeline' }));
  });

  it('refuses an unknown template name rather than instantiating something else', async () => {
    const { post } = mockClient({ templates: [{ id: 'tpl-2', name: 'react-typescript' }] });

    await expect(runCli([...BASE, '--name', 'react-javascript'])).rejects.toThrow(/__EXIT_/);
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses to guess when a name matches more than one visible template', async () => {
    const { post } = mockClient({
      templates: [{ id: 'tpl-a', name: 'react-javascript' }, { id: 'tpl-b', name: 'react-javascript' }],
    });

    await expect(runCli([...BASE, '--name', 'react-javascript'])).rejects.toThrow(/__EXIT_/);
    expect(post).not.toHaveBeenCalled();
  });

  it('requires --name or --id', async () => {
    mockClient();
    await expect(runCli([...BASE])).rejects.toThrow(/__EXIT_/);
  });

  it('rejects --name and --id together', async () => {
    mockClient();
    await expect(runCli([...BASE, '--name', 'x', '--id', 'y'])).rejects.toThrow(/__EXIT_/);
  });

  it('rejects a malformed --input', async () => {
    mockClient();
    await expect(runCli([...BASE, '--id', 'tpl-1', '--input', 'orgId'])).rejects.toThrow(/__EXIT_/);
  });

  it('keeps `=` inside an input value', async () => {
    const { post } = mockClient();

    await runCli([...BASE, '--id', 'tpl-1', '--input', 'query=a=b']);

    expect(post).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ inputs: { query: 'a=b' } }));
  });

  it('rejects a non-round-trippable --format', async () => {
    mockClient();
    await expect(runCli([...BASE, '--id', 'tpl-1', '--format', 'table'])).rejects.toThrow(/__EXIT_/);
  });

  describe('--inputs-file', () => {
    const tmpFile = (contents: string) => {
      const p = path.join(os.tmpdir(), `pb-inputs-${Date.now()}-${Math.random()}.json`);
      fs.writeFileSync(p, contents);
      return p;
    };

    it('merges the file under any --input flags', async () => {
      const { post } = mockClient();
      const file = tmpFile(JSON.stringify({ orgId: 'from-file', region: 'us-east-1' }));

      await runCli([...BASE, '--id', 'tpl-1', '--inputs-file', file, '--input', 'orgId=from-flag']);

      expect(post).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        inputs: { orgId: 'from-flag', region: 'us-east-1' },
      }));
      fs.unlinkSync(file);
    });

    it('rejects a missing file', async () => {
      mockClient();
      await expect(runCli([...BASE, '--id', 'tpl-1', '--inputs-file', '/no/such/file.json']))
        .rejects.toThrow(/__EXIT_/);
    });

    it('rejects a non-object payload', async () => {
      mockClient();
      const file = tmpFile('[1, 2, 3]');
      await expect(runCli([...BASE, '--id', 'tpl-1', '--inputs-file', file])).rejects.toThrow(/__EXIT_/);
      fs.unlinkSync(file);
    });

    it('rejects a nested (non-scalar) input value', async () => {
      mockClient();
      const file = tmpFile(JSON.stringify({ orgId: { nested: true } }));
      await expect(runCli([...BASE, '--id', 'tpl-1', '--inputs-file', file])).rejects.toThrow(/__EXIT_/);
      fs.unlinkSync(file);
    });
  });

  describe('unresolved placeholders', () => {
    it('warns when a self-scope {{ vars.X }} survived instantiation', async () => {
      mockClient({ props: { project: '{{ vars.appName }}', vars: {} } });

      await runCli([...BASE, '--id', 'tpl-1']);

      expect(mockPrintWarning).toHaveBeenCalledWith(
        expect.stringContaining('unresolved placeholders'),
        expect.objectContaining({ vars: 'appName' }),
      );
    });

    it('does not warn about synth-time {{ pipeline.vars.X }} tokens', async () => {
      // The GitHub source token legitimately keeps its `pipeline.*` placeholder —
      // that resolves at synth, not at instantiate.
      mockClient();

      await runCli([...BASE, '--id', 'tpl-1', '--input', 'orgId=org-uuid']);

      expect(mockPrintWarning).not.toHaveBeenCalled();
    });
  });

  it('writes props to --output and stays silent on stdout with --json', async () => {
    mockClient();
    const out = path.join(os.tmpdir(), `pb-props-${Date.now()}.json`);

    await runCli([...BASE, '--id', 'tpl-1', '--output', out, '--json']);

    expect(mockOutputData).toHaveBeenCalledWith(RENDERED, { format: 'json', file: out, silent: true });
  });

  it('fails when the API returns no props', async () => {
    mockCreateAuthenticatedClient.mockReturnValue({
      getConfig: () => ({ api: { pipelineTemplateUrl: TEMPLATE_URL } }),
      get: jest.fn(),
      post: jest.fn<(...args: any[]) => Promise<unknown>>().mockResolvedValue({ success: true, data: {} }),
    });

    await expect(runCli([...BASE, '--id', 'tpl-1'])).rejects.toThrow(/__EXIT_/);
    expect(mockOutputData).not.toHaveBeenCalled();
  });
});
