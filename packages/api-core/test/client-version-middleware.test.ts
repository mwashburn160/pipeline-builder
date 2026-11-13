// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * clientVersionGate (src/middleware/client-version.ts): a CLI below
 * PIPELINE_MANAGER_MIN_VERSION gets 426 CLIENT_UPGRADE_REQUIRED; everything
 * unidentified passes; a malformed minimum refuses to start.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import {
  _resetVersionLabelsForTests, CLIENT_REQUESTS_METRIC, CLIENT_UPGRADE_REQUIRED_METRIC, CLIENT_VERSION_HEADER, clientVersionGate,
  MAX_VERSION_LABELS, MIN_CLIENT_VERSION_HEADER,
} from '../src/middleware/client-version.js';
import { auditContextFromRequest } from '../src/services/audit-context.js';
import { ErrorCode } from '../src/types/error-codes.js';
import { resetCounterEmitter, setCounterEmitter } from '../src/utils/metric-emitter.js';

let counted: Array<[string, Record<string, string>]>;
beforeEach(() => {
  counted = [];
  _resetVersionLabelsForTests();
  setCounterEmitter((name, labels) => { counted.push([name, labels ?? {}]); });
});
afterEach(() => resetCounterEmitter());

function req(version?: string, ci = false): Request {
  return {
    get: (h: string) => (h === CLIENT_VERSION_HEADER ? version : h === 'X-CodeBuild-Build-Id' && ci ? 'proj:uuid' : undefined),
  } as unknown as Request;
}

function res() {
  const r = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    headersSent: false,
    setHeader(k: string, v: string) { r.headers[k] = v; return r; },
    status(c: number) { r.statusCode = c; return r; },
    json(b: unknown) { r.body = b; return r; },
  };
  return r;
}

function run(min: string | undefined, version?: string, ci = false) {
  const next = jest.fn();
  const r = res();
  clientVersionGate(min)(req(version, ci), r as unknown as Response, next);
  return { next, r };
}

describe('clientVersionGate', () => {
  it('refuses nothing while no minimum is set, but still counts the version', () => {
    for (const min of [undefined, '', '  ']) {
      const { next, r } = run(min, '1.0.0');
      expect(next).toHaveBeenCalled();
      expect(r.headers).toEqual({});
    }
    expect(counted).toEqual(Array(3).fill([CLIENT_REQUESTS_METRIC, { version: '1.0.0', caller: 'interactive' }]));
  });

  it('refuses to start on a malformed minimum (a typo must not disable the gate)', () => {
    expect(() => clientVersionGate('4.4')).toThrow('PIPELINE_MANAGER_MIN_VERSION is not a semver version');
  });

  it('answers 426 CLIENT_UPGRADE_REQUIRED to an older CLI, naming the fix', () => {
    const { next, r } = run('4.4.21', '4.4.20');
    expect(next).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(426);
    expect(r.body).toMatchObject({
      code: ErrorCode.CLIENT_UPGRADE_REQUIRED,
      details: { minVersion: '4.4.21', clientVersion: '4.4.20' },
    });
    expect((r.body as { message: string }).message).toContain('pipeline-manager --upgrade');
    expect(r.headers[MIN_CLIENT_VERSION_HEADER]).toBe('4.4.21');
    expect(counted).toEqual([
      [CLIENT_REQUESTS_METRIC, { version: '4.4.20', caller: 'interactive' }],
      [CLIENT_UPGRADE_REQUIRED_METRIC, { version: '4.4.20', min: '4.4.21' }],
    ]);
  });

  it('passes a CLI at or above the minimum, advertising the minimum', () => {
    for (const v of ['4.4.21', '4.5.0']) {
      const { next, r } = run('4.4.21', v);
      expect(next).toHaveBeenCalled();
      expect(r.headers[MIN_CLIENT_VERSION_HEADER]).toBe('4.4.21');
    }
  });

  it('never refuses a CI (CodeBuild) caller, whose CLI is baked into a plugin image, but counts it', () => {
    const { next, r } = run('4.4.21', '4.4.19', true);
    expect(next).toHaveBeenCalled();
    expect(r.statusCode).toBe(0);
    expect(counted).toEqual([[CLIENT_REQUESTS_METRIC, { version: '4.4.19', caller: 'ci' }]]);
  });

  it('treats a prerelease of the minimum as older', () => {
    expect(run('5.0.0', '5.0.0-rc.1').r.statusCode).toBe(426);
  });

  it('passes unidentified callers: no header, or a value that is not a version', () => {
    for (const v of [undefined, '', 'cli', '4.4']) {
      const { next, r } = run('4.4.21', v);
      expect(next).toHaveBeenCalled();
      expect(r.statusCode).toBe(0);
    }
    expect(counted).toEqual([]);
  });

  it('labels x.y.z only, and folds versions past the cap into "other" (the header is pre-auth input)', () => {
    run(undefined, '5.0.0-rc.1+b7');
    expect(counted[0]).toEqual([CLIENT_REQUESTS_METRIC, { version: '5.0.0', caller: 'interactive' }]);
    for (let i = 0; i < MAX_VERSION_LABELS + 10; i++) run(undefined, `1.0.${i}`);
    const labels = new Set(counted.map(([, l]) => l.version));
    expect(labels.size).toBe(MAX_VERSION_LABELS + 1);
    expect(labels.has('other')).toBe(true);
    counted = [];
    run(undefined, '5.0.0');
    expect(counted[0]?.[1].version).toBe('5.0.0');
  });
});

describe('clientVersionOf', () => {
  it('reads a semver header, and nothing else', async () => {
    const { clientVersionOf } = await import('../src/middleware/client-version.js');
    const of = (h: unknown) => clientVersionOf({ headers: h } as Request);
    expect(of({ 'x-pb-client-version': ' 4.4.21 ' })).toBe('4.4.21');
    expect(of({ 'x-pb-client-version': ['4.4.22', '1.0.0'] })).toBe('4.4.22');
    expect(of({ 'x-pb-client-version': 'cli' })).toBeUndefined();
    expect(of({})).toBeUndefined();
    expect(of(undefined)).toBeUndefined();
  });
});

describe('audit context', () => {
  it('records the CLI version alongside the other inbound correlation ids', () => {
    const r = { headers: { 'x-pb-client-version': '4.4.21' }, ip: '10.0.0.1' } as unknown as Request;
    expect(auditContextFromRequest(r).correlation).toEqual({ clientVersion: '4.4.21' });
  });
});
