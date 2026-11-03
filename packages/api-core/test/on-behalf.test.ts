// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The on-behalf marker: a service forwarding a user's token adds a SIGNED
 * service token so the peer skips the apiCalls meter/check for that hop. The
 * property that matters is that a USER cannot produce one — every forgery below
 * must leave the request billed (`onBehalfCaller` → undefined) and be counted.
 */

import { generateKeyPairSync } from 'crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { ON_BEHALF_HEADER, onBehalfCaller, onBehalfHeaders } from '../src/middleware/on-behalf.js';
import { runWithAuditContext } from '../src/services/audit-context.js';
import { callQuotaExemption } from '../src/services/quota.js';
import { installTestServiceKeys, type TestServiceKeysHandle } from '../src/testing/service-tokens.js';
import { resetCounterEmitter, setCounterEmitter } from '../src/utils/metric-emitter.js';

let keys: TestServiceKeysHandle;
let rejections: string[];

beforeAll(() => { keys = installTestServiceKeys(['ask', 'pipeline', 'billing']); });
afterAll(() => { keys.uninstall(); resetCounterEmitter(); });
beforeEach(() => {
  keys.becomeService('ask');
  rejections = [];
  setCounterEmitter((name, labels = {}) => {
    if (name === 'quota_on_behalf_rejected_total') rejections.push(labels.reason ?? '');
  });
});

const USER = { sub: 'user-1', organizationId: 'org-1', principalType: 'user' as const };

/** A verified request as requireAuth leaves it, carrying `marker`. */
function req(marker: string | undefined, user: Record<string, unknown> = USER): never {
  return { headers: marker ? { [ON_BEHALF_HEADER]: marker } : {}, user } as never;
}

describe('onBehalfHeaders + onBehalfCaller', () => {
  it('a marker minted by ask for this user and org is honoured', () => {
    const marker = onBehalfHeaders({ sub: 'user-1', organizationId: 'org-1' })[ON_BEHALF_HEADER];
    expect(marker).toBeTruthy();
    expect(onBehalfCaller(req(marker))).toBe('ask');
    expect(callQuotaExemption(req(marker) as never)).toBe('on_behalf');
    expect(rejections).toEqual([]);
  });

  it('is minted for the ambient verified principal when no subject is passed', () => {
    const headers = runWithAuditContext({ principal: () => USER as never }, () => onBehalfHeaders());
    expect(onBehalfCaller(req(headers[ON_BEHALF_HEADER]))).toBe('ask');
  });

  it('mints nothing without a user to vouch for (the hop is then billed)', () => {
    expect(onBehalfHeaders()).toEqual({});
    const headers = runWithAuditContext({ principal: () => ({ sub: 'service:ask', principalType: 'service', organizationId: 'o' }) as never }, () => onBehalfHeaders());
    expect(headers).toEqual({});
  });

  it('is typed so it can never be used as an access token', () => {
    const marker = onBehalfHeaders({ sub: 'user-1', organizationId: 'org-1' })[ON_BEHALF_HEADER]!;
    const claims = jwt.decode(marker) as Record<string, unknown>;
    expect(claims.type).toBe('on_behalf');
    expect(claims.sub).toBe('service:ask');
    expect((claims.exp as number) - (claims.iat as number)).toBe(120);
  });

  it('IGNORES a header a user forged — garbage, an HMAC token, or a self-signed ES256 token', () => {
    expect(onBehalfCaller(req('forged'))).toBeUndefined();
    const hmac = jwt.sign({ type: 'on_behalf', principalType: 'service', sub: 'service:ask', obo: 'user-1', organizationId: 'org-1' }, 'guess');
    expect(onBehalfCaller(req(hmac))).toBeUndefined();
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const selfSigned = jwt.sign({ type: 'on_behalf', principalType: 'service', sub: 'service:ask', obo: 'user-1', organizationId: 'org-1' }, privateKey, { algorithm: 'ES256', keyid: 'made-up' });
    expect(onBehalfCaller(req(selfSigned))).toBeUndefined();
    expect(callQuotaExemption(req(selfSigned) as never)).toBeUndefined();
    expect(rejections).toEqual(['invalid', 'invalid', 'invalid', 'invalid']);
  });

  it('is bound to the user and org it was minted for', () => {
    const marker = onBehalfHeaders({ sub: 'user-1', organizationId: 'org-1' })[ON_BEHALF_HEADER];
    expect(onBehalfCaller(req(marker, { ...USER, sub: 'user-2' }))).toBeUndefined();
    expect(onBehalfCaller(req(marker, { ...USER, organizationId: 'org-2' }))).toBeUndefined();
    // The org comparison is case-insensitive, like the normalized request identity.
    expect(onBehalfCaller(req(marker, { ...USER, organizationId: 'ORG-1' }))).toBe('ask');
    expect(rejections).toEqual(['subject', 'org']);
  });

  it('is honoured only from a service that forwards user tokens by design', () => {
    keys.becomeService('billing');
    const marker = onBehalfHeaders({ sub: 'user-1', organizationId: 'org-1' })[ON_BEHALF_HEADER];
    expect(onBehalfCaller(req(marker))).toBeUndefined();
    expect(rejections).toEqual(['caller']);
    keys.becomeService('pipeline');
    expect(onBehalfCaller(req(onBehalfHeaders({ sub: 'user-1', organizationId: 'org-1' })[ON_BEHALF_HEADER]))).toBe('pipeline');
  });

  it('refuses a real ACCESS-typed service token passed as the marker', () => {
    expect(onBehalfCaller(req(keys.sign('ask', { obo: 'user-1', organizationId: 'org-1' })))).toBeUndefined();
    expect(rejections).toEqual(['invalid']);
  });

  it('means nothing on an unauthenticated request', () => {
    const marker = onBehalfHeaders({ sub: 'user-1', organizationId: 'org-1' })[ON_BEHALF_HEADER];
    expect(onBehalfCaller({ headers: { [ON_BEHALF_HEADER]: marker } } as never)).toBeUndefined();
    expect(rejections).toEqual(['unauthenticated']);
  });
});
