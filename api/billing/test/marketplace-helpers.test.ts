// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for AWS Marketplace SNS helper functions.
 */

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import {
  mapActionToStatus,
  verifySNSSignature,
  type SNSMessage,
} from '../src/helpers/marketplace-helpers';

// mapActionToStatus

describe('mapActionToStatus', () => {
  it('maps subscribe-success to active', () => {
    expect(mapActionToStatus('subscribe-success')).toEqual({
      status: 'active',
      cancelAtPeriodEnd: false,
    });
  });

  it('maps unsubscribe-pending to active with cancelAtPeriodEnd', () => {
    expect(mapActionToStatus('unsubscribe-pending')).toEqual({
      status: 'active',
      cancelAtPeriodEnd: true,
    });
  });

  it('maps unsubscribe-success to canceled', () => {
    expect(mapActionToStatus('unsubscribe-success')).toEqual({
      status: 'canceled',
      cancelAtPeriodEnd: false,
    });
  });

  it('maps subscribe-fail to incomplete', () => {
    expect(mapActionToStatus('subscribe-fail')).toEqual({
      status: 'incomplete',
      cancelAtPeriodEnd: false,
    });
  });

  it('returns null for unknown actions', () => {
    expect(mapActionToStatus('entitlement-updated')).toBeNull();
    expect(mapActionToStatus('something-else')).toBeNull();
    expect(mapActionToStatus('')).toBeNull();
  });
});

// verifySNSSignature

describe('verifySNSSignature', () => {
  const baseMessage: SNSMessage = {
    Type: 'Notification',
    MessageId: 'msg-1',
    TopicArn: 'arn:aws:sns:us-east-1:123:topic',
    Message: '{"action":"subscribe-success"}',
    Timestamp: '2026-01-01T00:00:00.000Z',
    SignatureVersion: '1',
    Signature: 'fakebase64==',
    SigningCertURL: 'https://sns.us-east-1.amazonaws.com/cert.pem',
  };

  it('returns false for unsupported SignatureVersion', async () => {
    const result = await verifySNSSignature({ ...baseMessage, SignatureVersion: '2' });
    expect(result).toBe(false);
  });

  it('returns false when SigningCertURL is not HTTPS', async () => {
    const result = await verifySNSSignature({
      ...baseMessage,
      SigningCertURL: 'http://sns.us-east-1.amazonaws.com/cert.pem',
    });
    expect(result).toBe(false);
  });

  it('returns false when SigningCertURL host is not amazonaws.com', async () => {
    const result = await verifySNSSignature({
      ...baseMessage,
      SigningCertURL: 'https://evil.com/cert.pem',
    });
    expect(result).toBe(false);
  });

  it('returns false when SigningCertURL path is not .pem', async () => {
    const result = await verifySNSSignature({
      ...baseMessage,
      SigningCertURL: 'https://sns.us-east-1.amazonaws.com/cert.txt',
    });
    expect(result).toBe(false);
  });

  it('returns false when URL is malformed', async () => {
    const result = await verifySNSSignature({
      ...baseMessage,
      SigningCertURL: 'not a url',
    });
    expect(result).toBe(false);
  });
});
