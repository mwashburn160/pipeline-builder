// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the SNS signing-cert download cache (marketplace-helpers).
 *
 * The cache must never store a non-200 / non-PEM response: one 503 or HTML
 * error page would otherwise poison `certCache` forever and reject ALL
 * marketplace notifications until the process restarts. We drive this through
 * the exported `verifySNSSignature` (the only caller of the private
 * `downloadCert`) with `https` mocked, asserting on refetch behaviour.
 */

import { EventEmitter } from 'events';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

// Controllable https.get: each call consults `responder` for status + body.
let responder: () => { statusCode: number; body: string };

const mockGet = jest.fn((_url: string, cb: (res: any) => void) => {
  const req: any = new EventEmitter();
  req.setTimeout = jest.fn();
  req.destroy = jest.fn();
  process.nextTick(() => {
    const { statusCode, body } = responder();
    const res: any = new EventEmitter();
    res.statusCode = statusCode;
    res.setEncoding = jest.fn();
    res.resume = jest.fn();
    res.destroy = jest.fn();
    cb(res);
    process.nextTick(() => {
      if (statusCode === 200) res.emit('data', body);
      res.emit('end');
    });
  });
  return req;
});

jest.unstable_mockModule('https', () => ({
  default: { get: (...a: unknown[]) => mockGet(...(a as [string, (res: any) => void])) },
  get: (...a: unknown[]) => mockGet(...(a as [string, (res: any) => void])),
}));

const { verifySNSSignature } = await import('../src/helpers/marketplace-helpers.js');
type SNSMessage = import('../src/helpers/marketplace-helpers.js').SNSMessage;

// A body that satisfies the PEM shape guard (crypto.verify will still reject it,
// but downloadCert caches it before verification runs).
const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfaked\n-----END CERTIFICATE-----\n';

// Unique cert URL per test so the process-wide certCache can't bleed across cases.
let urlCounter = 0;
function message(): SNSMessage {
  return {
    Type: 'Notification',
    MessageId: 'msg-1',
    TopicArn: 'arn:aws:sns:us-east-1:0:topic',
    Message: '{"action":"subscribe-success"}',
    Timestamp: '2026-01-01T00:00:00.000Z',
    SignatureVersion: '1',
    Signature: 'AAAA',
    SigningCertURL: `https://sns.us-east-1.amazonaws.com/cert-${++urlCounter}.pem`,
  };
}

describe('SNS signing-cert cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does NOT cache a non-200 response and refetches on the next call', async () => {
    const msg = message();

    // First delivery: cert endpoint is down (503) → must not cache.
    responder = () => ({ statusCode: 503, body: 'gateway error' });
    await expect(verifySNSSignature(msg)).resolves.toBe(false);
    expect(mockGet).toHaveBeenCalledTimes(1);

    // Second delivery: endpoint recovers (200 PEM). Because the 503 was NOT
    // cached, the helper must fetch again rather than serve the poisoned entry.
    responder = () => ({ statusCode: 200, body: PEM });
    await verifySNSSignature(msg);
    expect(mockGet).toHaveBeenCalledTimes(2);

    // Third delivery: the good 200 IS cached now, so no further network fetch.
    await verifySNSSignature(msg);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('does NOT cache a 200 whose body is not a PEM certificate', async () => {
    const msg = message();

    responder = () => ({ statusCode: 200, body: '<html>not a cert</html>' });
    await expect(verifySNSSignature(msg)).resolves.toBe(false);
    expect(mockGet).toHaveBeenCalledTimes(1);

    // A non-PEM 200 is rejected + uncached, so the next delivery refetches.
    await verifySNSSignature(msg);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});
