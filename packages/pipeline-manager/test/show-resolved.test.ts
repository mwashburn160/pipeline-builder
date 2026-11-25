// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `synth --show-resolved` / `deploy --show-resolved` print the props AS SYNTH
 * SEES THEM: pipeline-core's `resolvePipelineProps` (the resolver
 * PipelineBuilder runs) over the real BuilderProps fields — `project`, `vars`,
 * and metadata across `global` ← `defaults.metadata` ← `synth.metadata`.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const { printResolvedOrExit } = await import('../src/utils/pipeline-config.js');

let logSpy: ReturnType<typeof jest.spyOn>;
let errSpy: ReturnType<typeof jest.spyOn>;
let exitSpy: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`__EXIT_${code ?? 0}__`); }) as never);
});
afterEach(() => { logSpy.mockRestore(); errSpy.mockRestore(); exitSpy.mockRestore(); });

describe('printResolvedOrExit', () => {
  it('prints project, metadata layers and vars resolved', async () => {
    await printResolvedOrExit({
      project: '{{ vars.service }}',
      global: { env: 'dev', url: 'https://github.com/{{ vars.repo }}' },
      synth: { metadata: { env: '{{ vars.stage }}' }, source: { type: 'github', options: { repo: 'acme/web' } } },
      vars: { service: 'web', stage: 'prod', repo: 'acme/web' },
      pipelineId: 'p1',
    });
    const printed = JSON.parse(String(logSpy.mock.calls[0]![0]));
    expect(printed.project).toBe('web');
    expect(printed.global.url).toBe('https://github.com/acme/web');
    expect(printed.synth.metadata.env).toBe('prod');
    expect(printed.pipelineId).toBe('p1');
  });

  it('exits 1 on an unresolved reference', async () => {
    await expect(printResolvedOrExit({ project: 'p', global: { a: '{{ vars.missing }}' } })).rejects.toThrow(/__EXIT_1__/);
    expect(String(errSpy.mock.calls.flat().join('\n'))).toMatch(/vars\.missing|missing/);
  });
});
