// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from 'crypto';
import https from 'https';
import { URL } from 'url';
import { createLogger } from '@pipeline-builder/api-core';
import type { QuotaTier } from '@pipeline-builder/api-core';

const logger = createLogger('marketplace-helpers');

// SNS Message Types

/** SNS message envelope. */
export interface SNSMessage {
  Type: 'SubscriptionConfirmation' | 'Notification' | 'UnsubscribeConfirmation';
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  SubscribeURL?: string;
  Token?: string;
}

/** Parsed marketplace notification from SNS Message body. */
export interface MarketplaceNotification {
  'action':
    | 'subscribe-success'
    | 'subscribe-fail'
    | 'unsubscribe-pending'
    | 'unsubscribe-success'
    | 'entitlement-updated';
  'customer-identifier': string;
  'product-code': string;
  'offer-identifier'?: string;
  'isFree-trial'?: boolean;
}

// SNS Signature Verification

/** Validate the signing certificate URL — must be HTTPS from amazonaws.com. */
function isValidCertUrl(certUrl: string): boolean {
  try {
    const url = new URL(certUrl);
    return (
      url.protocol === 'https:'
      && url.hostname.endsWith('.amazonaws.com')
      && url.pathname.endsWith('.pem')
    );
  } catch {
    return false;
  }
}

/** Download a PEM certificate from the given URL. */
function downloadCert(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => resolve(data));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

/**
 * Build the string-to-sign for an SNS message.
 * Field ordering varies by message type per AWS specification.
 */
function buildStringToSign(message: SNSMessage): string {
  const fields: string[] = [];

  if (message.Type === 'Notification') {
    fields.push('Message', message.Message);
    fields.push('MessageId', message.MessageId);
    if (message.Subject) fields.push('Subject', message.Subject);
    fields.push('Timestamp', message.Timestamp);
    fields.push('TopicArn', message.TopicArn);
    fields.push('Type', message.Type);
  } else {
    // SubscriptionConfirmation or UnsubscribeConfirmation
    fields.push('Message', message.Message);
    fields.push('MessageId', message.MessageId);
    fields.push('SubscribeURL', message.SubscribeURL || '');
    fields.push('Timestamp', message.Timestamp);
    fields.push('TopicArn', message.TopicArn);
    fields.push('Type', message.Type);
  }

  return fields.map((f) => f + '\n').join('');
}

/**
 * Verify the signature of an SNS message.
 * Downloads the signing certificate and validates the signature.
 */
export async function verifySNSSignature(message: SNSMessage): Promise<boolean> {
  try {
    if (message.SignatureVersion !== '1') {
      logger.warn('Unsupported SNS signature version', { version: message.SignatureVersion });
      return false;
    }

    if (!isValidCertUrl(message.SigningCertURL)) {
      logger.warn('Invalid SNS signing certificate URL', { url: message.SigningCertURL });
      return false;
    }

    const cert = await downloadCert(message.SigningCertURL);
    const stringToSign = buildStringToSign(message);

    const verifier = crypto.createVerify('SHA1withRSA');
    verifier.update(stringToSign);
    return verifier.verify(cert, message.Signature, 'base64');
  } catch (error) {
    logger.error('Failed to verify SNS signature', { error });
    return false;
  }
}

/**
 * Confirm an SNS subscription by fetching the SubscribeURL.
 */
export async function confirmSNSSubscription(subscribeUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    https
      .get(subscribeUrl, (res) => {
        res.on('data', () => { /* drain */ });
        res.on('end', () => resolve());
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

// Notification Mapping

/** Marketplace action → subscription status change lookup. */
const ACTION_STATUS_MAP: Record<string, { status: 'active' | 'canceled' | 'incomplete'; cancelAtPeriodEnd: boolean }> = {
  'subscribe-success': { status: 'active', cancelAtPeriodEnd: false },
  'unsubscribe-pending': { status: 'active', cancelAtPeriodEnd: true },
  'unsubscribe-success': { status: 'canceled', cancelAtPeriodEnd: false },
  'subscribe-fail': { status: 'incomplete', cancelAtPeriodEnd: false },
};

/**
 * Map an AWS Marketplace notification action to a subscription status change.
 */
export function mapActionToStatus(
  action: string,
): { status: 'active' | 'canceled' | 'incomplete'; cancelAtPeriodEnd: boolean } | null {
  return ACTION_STATUS_MAP[action] ?? null;
}

/**
 * Look up the QuotaTier for a plan ID.
 */
export function planIdToTier(planId: string): QuotaTier {
  const tierMap: Record<string, QuotaTier> = {
    developer: 'developer',
    pro: 'pro',
    unlimited: 'unlimited',
  };
  return tierMap[planId] || 'developer';
}
