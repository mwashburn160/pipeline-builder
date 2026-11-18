// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every refusal branch of `authenticateAlertmanager` — the gate in front of the
 * alert relay, the on-call webhook and the on-call ack. Each one, if it let a
 * request through, would let anyone on the network inject alerts or ack pages.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Request } from 'express';
import { mockConfig } from './helpers/config-mock.js';

const instances: Array<{ id: string; token: string; previousToken?: string }> = [];
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ alertWebhook: { instances } }));

const { authenticateAlertmanager } = await import('../src/helpers/alertmanager-auth.js');

const req = (headers: Record<string, string>) => ({ headers }) as unknown as Request;
const TOKEN = 'a'.repeat(32);
const OLD = 'b'.repeat(32);

beforeEach(() => {
  instances.length = 0;
  instances.push({ id: 'am-0', token: TOKEN });
});

describe('authenticateAlertmanager', () => {
  it('503s when no instance is configured — the relay is not set up, nothing is wrong with the caller', () => {
    instances.length = 0;
    expect(authenticateAlertmanager(req({ 'authorization': `Bearer ${TOKEN}`, 'x-alertmanager-instance': 'am-0' })))
      .toEqual({ ok: false, status: 503, message: 'Alert relay not configured', reason: 'no-instances' });
  });

  it('401s without the instance header', () => {
    expect(authenticateAlertmanager(req({ authorization: `Bearer ${TOKEN}` })))
      .toMatchObject({ ok: false, status: 401, reason: 'no-instance-header' });
  });

  it('401s an unknown instance, even with a valid token for another one', () => {
    expect(authenticateAlertmanager(req({ 'authorization': `Bearer ${TOKEN}`, 'x-alertmanager-instance': 'am-9' })))
      .toMatchObject({ ok: false, status: 401, reason: 'unknown-instance' });
  });

  it('401s a wrong token, and a missing one', () => {
    expect(authenticateAlertmanager(req({ 'authorization': `Bearer ${OLD}`, 'x-alertmanager-instance': 'am-0' })))
      .toMatchObject({ ok: false, status: 401, reason: 'bad-token' });
    expect(authenticateAlertmanager(req({ 'x-alertmanager-instance': 'am-0' })))
      .toMatchObject({ ok: false, status: 401, reason: 'bad-token' });
  });

  it('accepts the current token', () => {
    expect(authenticateAlertmanager(req({ 'authorization': `Bearer ${TOKEN}`, 'x-alertmanager-instance': 'am-0' })))
      .toEqual({ ok: true, instance: { id: 'am-0', token: TOKEN } });
  });

  it('accepts the previous token only while a rotation is open', () => {
    const presented = req({ 'authorization': `Bearer ${OLD}`, 'x-alertmanager-instance': 'am-0' });
    instances[0] = { id: 'am-0', token: TOKEN, previousToken: OLD };
    expect(authenticateAlertmanager(presented)).toMatchObject({ ok: true });
    instances[0] = { id: 'am-0', token: TOKEN };
    expect(authenticateAlertmanager(presented)).toMatchObject({ ok: false, reason: 'bad-token' });
  });
});
