// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for AWS Marketplace SNS helper functions.
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';
import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// A fixed RSA keypair + matching self-signed x509 cert (generated once with
// openssl, test-only) standing in for the SNS signing certificate. The cert
// download is served from the `https` mock below, so these tests never touch AWS.
const SIGNING_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDTxO9WuC7X1G5f
F2QT75QIPUaQZ3izxzkgN/wm+5F+1kjjgqFuPeZkhRylIT9yZgrkcOQT9mHo7dNo
PoaT5xTprZDJdqVwv2PfQvwAuudUSGKMxdGJVReoCqhYpYLX3jpDKKN1dCjkNyvi
PROZf1+zCaJd6ZC3SJQloNqhNzdLhzVpNka3aV8QRIca6ELIjJfTzEQqK9C8EpzJ
ul7BBO3EzQL+h9ahAge55CcfSgsSq2d17jpt4h7o3Xo8rB771/tVolx6GsJR6nXX
F+fDq2ESXppMWpwyjPc/H+bGY+0HL2EhGLJvoLVHBzMHCyznlWwtwkffIHya42pi
creEKTGjAgMBAAECggEAHkxYU+dxKEcH7Yn6sxF9c/pUXLe5ILuZtD7eUDOA+w0s
i4R2lT+89VfII+YQXk00NL/kGekP1BQmwYzkk0emCdLf2rsja3CumNRMGsyi6T+b
/fkVhBkNE+lGcbxobnsoidBIJrdSXGh6WlmTssvzBLoVpWsT3e0/6OxNK3CrdB4n
AhiOjJ0nhi0x+HtOkPCO99kg00Xf5pSc173uU/uMvbGjhgZirtO1s7qbCZTyO9EA
Z7EVm2yUdDvkIDl0VHjmmhybkbXh0z+uLgILhZigMr/CU1pRnAEpMSfUF2tR4NBv
sn1CR7UWiQJE7Crm+tSrXzinjryhQ1TpbFm9LCYqYQKBgQDvxBCEHUW3LlRMsO7p
8rZAY8doXz2WL+sc8Veh9UtO/Upl+WWYrkMt/6o2VRY9tmOdit4GMGhefUCl8XYZ
dwwyBgLta/JshcZT1wBcCVABF5sxE6UYeSLHzDyG2g3nulKdi7/69D6dnR1jU07T
W46FJHMdLbNmtTP11XYwF3WSgwKBgQDiG5jEYsBCDLOSdYPrJD7+aEaxfZBmTPZ3
cKuh+UFHfLuE4V7Hds9FpDZX0tgOz4Dbr83PdBa3Q/lR05xx1DZN5AFLQNh5llCD
wEfGRh0Fpz8rmOCgO5I0hLPOro2nmFg5hIePY7O4PVLi170VOvLe5zw5mmQ513vA
XK8q1Pk6YQKBgQDL4E0m+fkg9V0rRTwyZHcCs5WJM4sb3S0wFCwvBHR/+zM7GOGB
/ZQUVhS3VIyv9xoniUCXxKvKxPim4nZI2wjctG3i0up1yx7EhcrBeA22kAsfpRO6
hq7Dc/B3vo0aYT4ExyN80hk4TrQBlIIviOfcYQ0dX5HwIN7JCDUSWbBY3wKBgQDQ
B4X5gcXTvy3kXVyfFn0iwrvwB0+436yP3cj7wIGQDTHWIyh5qlUvhNM+4E1K6x1q
goiACxXvTYnxABnbHN1Nsq6CF0pUK7kuTtV6lf2TuvnC2egpZEWzLjjkuvK3tNHP
MaErixbKNxmwfb+I7fCQpv1hHiyCj0BbjqrXZJVdYQKBgDJgBUfdUF+xUp5cij8J
6XmFwF/gVStOSunlgQXoVVc6OhcjMfFXrQfGrzpD2l21twlICSZ9TZgUXrN7TFI8
xLXVVKR+30D8V18l0gQGQoGQEri+4uIlVbSOAl60uSc6ogSHRNDQAqyWiGM7FH0f
8KLpciktNFZHMsKvOhaUKBe3
-----END PRIVATE KEY-----
`;
const SIGNING_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDSTCCAjGgAwIBAgIUDzPt+xUV+4E7YvRkNueR9OYa+KEwDQYJKoZIhvcNAQEL
BQAwMzExMC8GA1UEAwwoc25zLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tIHRlc3Qg
Zml4dHVyZTAgFw0yNjEwMDUwMjI0MzhaGA8yMTI2MDkxMTAyMjQzOFowMzExMC8G
A1UEAwwoc25zLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tIHRlc3QgZml4dHVyZTCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBANPE71a4LtfUbl8XZBPvlAg9
RpBneLPHOSA3/Cb7kX7WSOOCoW495mSFHKUhP3JmCuRw5BP2Yejt02g+hpPnFOmt
kMl2pXC/Y99C/AC651RIYozF0YlVF6gKqFilgtfeOkMoo3V0KOQ3K+I9E5l/X7MJ
ol3pkLdIlCWg2qE3N0uHNWk2RrdpXxBEhxroQsiMl9PMRCor0LwSnMm6XsEE7cTN
Av6H1qECB7nkJx9KCxKrZ3XuOm3iHujdejysHvvX+1WiXHoawlHqddcX58OrYRJe
mkxanDKM9z8f5sZj7QcvYSEYsm+gtUcHMwcLLOeVbC3CR98gfJrjamJyt4QpMaMC
AwEAAaNTMFEwHQYDVR0OBBYEFFCfgPq/HY10L0rVkhHp1JDqHDmdMB8GA1UdIwQY
MBaAFFCfgPq/HY10L0rVkhHp1JDqHDmdMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZI
hvcNAQELBQADggEBADLqP1NvidLkEhqWioJN86v8qr+rhiOm3awk96yDDDzu03Uv
eHiJskX1fhcZQPRMN0EhgPV1jYfP91H5I++YcyrnKOG2KkdEjiaxNrSG1osl/US3
vno4UAjsRIPEsdxedrkgENhLYdZ5Ns0b8akYjfeidtudzSvBb/WSD0oqHG6hWJHz
gQU0nRREjnqMml1fdPJ61+MIRTWrREKmWQIXBYCP/iX9gCMDvlOakNVTDfHdnbXO
ULTp+lJRJxguM6meZiN3w2iMRyjjRpSJ7DPWTZrnnXrwD7WNMHd6koyqQcTIlo9o
6yu0Llkaly0Vr6LOSSjb+8Ah9T9t0EIC3AgOgF8=
-----END CERTIFICATE-----
`;

// Serve SIGNING_CERT_PEM for every cert download — only as much of
// `https.get` as downloadCert uses.
jest.unstable_mockModule('https', () => {
  const get = (_url: string, onResponse: (res: EventEmitter) => void) => {
    const req = Object.assign(new EventEmitter(), {
      setTimeout: () => req,
      destroy: () => undefined,
    });
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      setEncoding: () => undefined,
      resume: () => undefined,
      destroy: () => undefined,
    });
    process.nextTick(() => {
      onResponse(res);
      res.emit('data', SIGNING_CERT_PEM);
      res.emit('end');
    });
    return req;
  };
  return { default: { get }, get };
});
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const {
  mapActionToStatus,
  verifySNSSignature,
} = await import('../src/helpers/marketplace-helpers.js');
type SNSMessage = import('../src/helpers/marketplace-helpers.js').SNSMessage;

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

  /**
   * Sign `message` as SNS does: the AWS-specified string-to-sign, built here
   * independently of the implementation so a field-order bug there is caught too.
   */
  function signAsSns(message: SNSMessage, digest: 'sha1' | 'sha256'): SNSMessage {
    const fields = message.Type === 'Notification'
      ? ['Message', 'MessageId', ...(message.Subject ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
    const stringToSign = fields
      .map((f) => `${f}\n${(message as unknown as Record<string, string>)[f] ?? ''}\n`)
      .join('');
    const signature = crypto.sign(digest, Buffer.from(stringToSign), SIGNING_KEY_PEM).toString('base64');
    return { ...message, Signature: signature };
  }

  // The positive path was untested, so verification passing NOTHING went
  // unnoticed: it handed Node AWS's 'SHA1withRSA'/'SHA256withRSA' names, which
  // createVerify rejects with ERR_CRYPTO_INVALID_DIGEST.
  it('accepts a genuine SignatureVersion 1 (SHA1) notification', async () => {
    const result = await verifySNSSignature(signAsSns({ ...baseMessage, SignatureVersion: '1' }, 'sha1'));
    expect(result).toBe(true);
  });

  it('accepts a genuine SignatureVersion 2 (SHA256) notification', async () => {
    const result = await verifySNSSignature(signAsSns({ ...baseMessage, SignatureVersion: '2' }, 'sha256'));
    expect(result).toBe(true);
  });

  it('accepts a genuine SubscriptionConfirmation', async () => {
    const confirmation: SNSMessage = {
      ...baseMessage,
      Type: 'SubscriptionConfirmation',
      SignatureVersion: '2',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t',
      Token: 't',
    };
    const result = await verifySNSSignature(signAsSns(confirmation, 'sha256'));
    expect(result).toBe(true);
  });

  it('rejects a genuine signature over a tampered message', async () => {
    const signed = signAsSns({ ...baseMessage, SignatureVersion: '2' }, 'sha256');
    const result = await verifySNSSignature({ ...signed, Message: '{"action":"unsubscribe-success"}' });
    expect(result).toBe(false);
  });

  it('returns false for unsupported SignatureVersion', async () => {
    const result = await verifySNSSignature({ ...baseMessage, SignatureVersion: '3' });
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
