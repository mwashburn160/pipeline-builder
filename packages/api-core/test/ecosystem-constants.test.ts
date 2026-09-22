// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin-ecosystem constants (docs/plugin-publishing.md):
 * the publisher handle rules, the terms version, the request-kind tables and
 * the instance flags.
 */

import { describe, it, expect, afterEach } from '@jest/globals';

import {
  BUILTIN_RESERVED_HANDLES,
  DEFAULT_PUBLISHER_TERMS_VERSION,
  isAnonymousSubmissionsEnabled,
  isOfficialAutoApprovalEnabled,
  isPluginPublishingEnabled,
  isPluginReviewsEnabled,
  OFFICIAL_CATALOG_LOADER_ACCOUNT,
  PUBLISH_PERMISSION_REQUEST_KINDS,
  publisherHandleProblem,
  publisherTermsVersion,
  REQUEST_SLA_HOURS,
  STEP_UP_REQUEST_KINDS,
  TENANT_REQUEST_KINDS,
  VERIFY_REQUEST_KINDS,
} from '../src/types/ecosystem.js';
import { ErrorCode, getStatusForErrorCode } from '../src/types/error-codes.js';

const ENV = ['PUBLISHER_TERMS_VERSION', 'OFFICIAL_AUTO_APPROVAL_ENABLED', 'PLUGIN_PUBLISHING_ENABLED', 'PLUGIN_REVIEWS_ENABLED', 'BILLING_ENABLED', 'ANONYMOUS_SUBMISSIONS_ENABLED'];
afterEach(() => { for (const k of ENV) delete process.env[k]; });

describe('publisher handles', () => {
  it.each(['acme', 'a1', 'acme-labs', 'x'.repeat(39)])('accepts %s', (h) => {
    expect(publisherHandleProblem(h)).toBeNull();
  });

  it.each(['a', 'x'.repeat(40), 'Acme', '-acme', 'acme-', 'ac--me', 'ac_me', 'ac.me'])('refuses %s', (h) => {
    expect(publisherHandleProblem(h)).not.toBeNull();
  });

  it('reserves the platform publishers', () => {
    expect(BUILTIN_RESERVED_HANDLES).toEqual(expect.arrayContaining(['pipeline-builder', 'community', 'official']));
    expect(OFFICIAL_CATALOG_LOADER_ACCOUNT).toBe('official-catalog-loader');
  });
});

describe('publisher terms version', () => {
  it('defaults, and follows PUBLISHER_TERMS_VERSION when set', () => {
    expect(publisherTermsVersion()).toBe(DEFAULT_PUBLISHER_TERMS_VERSION);
    process.env.PUBLISHER_TERMS_VERSION = '  2027-01  ';
    expect(publisherTermsVersion()).toBe('2027-01');
    process.env.PUBLISHER_TERMS_VERSION = ' ';
    expect(publisherTermsVersion()).toBe(DEFAULT_PUBLISHER_TERMS_VERSION);
  });
});

describe('request kinds', () => {
  it('splits tenant kinds between plugins:publish and publishers:manage (advisory drafts need publishers:manage)', () => {
    expect(TENANT_REQUEST_KINDS).toContain('advisory');
    expect(PUBLISH_PERMISSION_REQUEST_KINDS).not.toContain('advisory');
    expect(TENANT_REQUEST_KINDS).not.toContain('moderation');
    for (const k of PUBLISH_PERMISSION_REQUEST_KINDS) expect(TENANT_REQUEST_KINDS).toContain(k);
    expect(VERIFY_REQUEST_KINDS).toEqual(['transfer', 'claim', 'profile_change', 'verify']);
    expect(STEP_UP_REQUEST_KINDS).toEqual(expect.arrayContaining(['yank', 'moderation', ...VERIFY_REQUEST_KINDS]));
    expect(REQUEST_SLA_HOURS).toEqual({ standard: 48, security: 4 });
  });
});

describe('instance flags', () => {
  it('OFFICIAL_AUTO_APPROVAL_ENABLED defaults on and turns off with false/0/off/no', () => {
    expect(isOfficialAutoApprovalEnabled()).toBe(true);
    for (const v of ['false', '0', 'off', 'NO']) {
      process.env.OFFICIAL_AUTO_APPROVAL_ENABLED = v;
      expect(isOfficialAutoApprovalEnabled()).toBe(false);
    }
    process.env.OFFICIAL_AUTO_APPROVAL_ENABLED = 'true';
    expect(isOfficialAutoApprovalEnabled()).toBe(true);
  });

  it('PLUGIN_PUBLISHING_ENABLED defaults to on with billing (hosted) and off without (self-hosted)', () => {
    expect(isPluginPublishingEnabled()).toBe(true);
    process.env.BILLING_ENABLED = 'false';
    expect(isPluginPublishingEnabled()).toBe(false);
    process.env.PLUGIN_PUBLISHING_ENABLED = 'true';
    expect(isPluginPublishingEnabled()).toBe(true);
  });

  it('ANONYMOUS_SUBMISSIONS_ENABLED defaults OFF and turns on only when set', () => {
    expect(isAnonymousSubmissionsEnabled()).toBe(false);
    process.env.ANONYMOUS_SUBMISSIONS_ENABLED = 'true';
    expect(isAnonymousSubmissionsEnabled()).toBe(true);
    process.env.ANONYMOUS_SUBMISSIONS_ENABLED = 'off';
    expect(isAnonymousSubmissionsEnabled()).toBe(false);
  });

  it('PLUGIN_REVIEWS_ENABLED defaults on and turns off with false', () => {
    expect(isPluginReviewsEnabled()).toBe(true);
    process.env.PLUGIN_REVIEWS_ENABLED = 'false';
    expect(isPluginReviewsEnabled()).toBe(false);
  });
});

describe('ecosystem error codes', () => {
  it.each([
    [ErrorCode.SUBMISSIONS_DISABLED, 404],
    [ErrorCode.SUBMISSION_LIMIT, 429],
    [ErrorCode.NAME_TAKEN, 409],
    [ErrorCode.PROOF_OF_WORK_INVALID, 400],
    [ErrorCode.PUBLISHER_REQUIRED, 409],
    [ErrorCode.PUBLISHER_HANDLE_RESERVED, 409],
    [ErrorCode.PUBLISH_GATE_FAILED, 409],
    [ErrorCode.VERIFIED_PLAN_REQUIRED, 403],
    [ErrorCode.VERIFIED_DOMAIN_REQUIRED, 409],
    [ErrorCode.VERIFIED_OWNER_MFA_REQUIRED, 409],
    [ErrorCode.PUBLISHER_TERMS_REQUIRED, 403],
    [ErrorCode.PUBLISHER_ROOT_ORG_REQUIRED, 403],
    [ErrorCode.PUBLISHER_SUSPENDED, 403],
    [ErrorCode.PLUGIN_PUBLISHING_DISABLED, 403],
    [ErrorCode.PLUGIN_REVIEWS_DISABLED, 403],
    [ErrorCode.REVIEW_SELF_PROMOTION, 403],
    [ErrorCode.SEPARATION_OF_DUTIES, 403],
    [ErrorCode.PLUGIN_NOT_INSTALLED, 403],
    [ErrorCode.PLUGIN_BLOCKED_BY_POLICY, 403],
    [ErrorCode.PLUGIN_UNAVAILABLE, 409],
    [ErrorCode.PLUGIN_NAME_LISTED, 409],
  ])('%s maps to %i', (code, status) => {
    expect(getStatusForErrorCode(code)).toBe(status);
  });
});
