// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// buildTemplateVars throws api-core's ValidationError — the shared mock provides it.
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { buildTemplateVars, instantiateTemplateProps } = await import('../src/helpers/instantiate-template.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
const input = (over: Record<string, unknown>) => ({ name: 'x', type: 'string', ...over }) as any;

describe('buildTemplateVars', () => {
  it('applies a declared default when no value is supplied', () => {
    expect(buildTemplateVars([input({ name: 'region', default: 'us-east-1' })], {}).region).toBe('us-east-1');
  });
  it('throws when a required input is missing', () => {
    expect(() => buildTemplateVars([input({ name: 'r', required: true })], {})).toThrow();
  });
  it('coerces a numeric string to a number', () => {
    expect(buildTemplateVars([input({ name: 'n', type: 'number' })], { n: '5' }).n).toBe(5);
  });
  it('rejects a non-finite number', () => {
    expect(() => buildTemplateVars([input({ name: 'n', type: 'number' })], { n: 'abc' })).toThrow();
  });
  it('coerces boolean strings', () => {
    expect(buildTemplateVars([input({ name: 'b', type: 'boolean' })], { b: 'true' }).b).toBe(true);
    expect(buildTemplateVars([input({ name: 'b', type: 'boolean' })], { b: 'false' }).b).toBe(false);
  });
  it('rejects an unrecognized boolean string', () => {
    expect(() => buildTemplateVars([input({ name: 'b', type: 'boolean' })], { b: 'yes' })).toThrow();
  });
  it('enforces the options set', () => {
    expect(() => buildTemplateVars([input({ name: 'e', options: ['a', 'b'] })], { e: 'c' })).toThrow();
    expect(buildTemplateVars([input({ name: 'e', options: ['a', 'b'] })], { e: 'a' }).e).toBe('a');
  });
  it('only populates declared inputs (ignores extra provided keys)', () => {
    const vars = buildTemplateVars([input({ name: 'a' })], { a: '1', b: 'ignored' } as any);
    expect(vars.a).toBe('1');
    expect('b' in vars).toBe(false);
  });
});

describe('instantiateTemplateProps', () => {
  it('bakes identity + merged vars into the props', () => {
    const props = instantiateTemplateProps(
      { props: { synth: {}, vars: { existing: 1 } }, inputs: [input({ name: 'region' })] },
      { project: 'p', organization: 'o', pipelineName: 'pn', inputs: { region: 'us' } },
    );
    expect(props.project).toBe('p');
    expect(props.organization).toBe('o');
    expect(props.pipelineName).toBe('pn');
    expect((props.vars as any).region).toBe('us');
    expect((props.vars as any).existing).toBe(1);
  });
  it('does not mutate the source template props', () => {
    const template = { props: { synth: {}, vars: {} as Record<string, unknown> }, inputs: [input({ name: 'r' })] };
    instantiateTemplateProps(template, { project: 'p', organization: 'o', inputs: { r: 'v' } });
    expect(template.props.vars).toEqual({});
  });
});
