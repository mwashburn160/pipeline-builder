// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `proposable` is the gate on the one request header a client may use to
 * influence an audit event, so these tests assert the REFUSAL as hard as the
 * acceptance: exactly one value passes, anything else fails the request BEFORE
 * the handler runs (so no write can land with its provenance thrown away), and
 * a request that says nothing is untouched.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ASK_PROVENANCE_REFUSED_COUNTER, proposable } from '../src/middleware/ask-provenance.js';
import { ASK_AGENT_PROPOSER, ASK_PROPOSED_BY_HEADER } from '../src/types/ask-proposals.js';
import { resetCounterEmitter, setCounterEmitter } from '../src/utils/metric-emitter.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const counted = jest.fn<(name: string, labels?: Record<string, string>, value?: number) => void>();

function run(headerValue?: unknown): { next: jest.Mock; status: jest.Mock; json: jest.Mock } {
  const next = jest.fn();
  const json = jest.fn();
  const status = jest.fn(() => ({ json })) as any;
  const req = {
    method: 'PUT',
    headers: headerValue === undefined ? {} : { [ASK_PROPOSED_BY_HEADER]: headerValue },
  } as any;
  proposable(req, { status, json, headersSent: false } as any, next as any);
  return { next, status, json };
}

describe('proposable', () => {
  beforeEach(() => setCounterEmitter(counted));
  afterEach(() => resetCounterEmitter());

  it('lets an ordinary request through untouched', () => {
    const { next, status } = run();
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    expect(counted).not.toHaveBeenCalled();
  });

  it('lets the agent marker through', () => {
    const { next, status } = run(ASK_AGENT_PROPOSER);
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it('REFUSES any other proposer with a 400, before the handler runs', () => {
    const { next, status, json } = run('the-admin');
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    const body = json.mock.calls[0][0] as any;
    expect(body.success).toBe(false);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.message).toContain(ASK_PROPOSED_BY_HEADER);
  });

  it('never echoes the rejected value back to the caller', () => {
    const { json } = run('<img src=x onerror=alert(1)>');
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('onerror');
  });

  it('counts the refusal — a foreign proposer is a signal, not a shrug', () => {
    run('ask-agent-2');
    expect(counted).toHaveBeenCalledWith(ASK_PROVENANCE_REFUSED_COUNTER, { method: 'PUT' }, 1);
  });

  it('refuses a near-miss: case, whitespace and prefixes are not the constant', () => {
    for (const forged of ['Ask-Agent', ' ask-agent', 'ask-agent ', 'askagent']) {
      const { next, status } = run(forged);
      expect(next).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(400);
    }
  });
});
