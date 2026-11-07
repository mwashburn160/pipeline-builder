// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * One label per refusal, from one catalog.
 *
 * This replaced two hand-written switches that had drifted: 16 codes each,
 * only 9 shared. The drift was invisible because neither side failed — a code
 * the switch had forgotten simply returned the generic `error`, so the same
 * refusal reported two different shapes depending on which path saw it, in the
 * metric whose job is to tell a broken connection from a crash.
 *
 * So the assertions are about AGREEMENT and COVERAGE, not about any single
 * label: every code the catalogs can label resolves the same way everywhere,
 * and the codes that drifted are named explicitly so they cannot quietly lose
 * their label again.
 */

import { describe, it, expect } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';
import {
  labelledRefusalCodes,
  ssoRefusalReason,
  UNLABELLED_BY_DESIGN,
  UNLABELLED_REFUSAL_REASON,
} from '../src/helpers/sso-refusal-reason.js';

// The catalog itself imports nothing — that is the point of it — but the two
// error maps this suite cross-checks it against live in service modules that
// load `config`, which refuses to initialise without SECRET_ENCRYPTION_KEY
// outside dev. `mockConfig` is how every other platform suite satisfies that,
// and it has to run before those modules are evaluated, hence the dynamic
// imports below.
mockConfig({});

const { OIDC_ERROR_MAP } = await import('../src/services/oidc-service.js');
const { SAML_ERROR_MAP } = await import('../src/services/saml-service.js');

describe('the catalog covers both error maps', () => {
  it('decides every code in SAML_ERROR_MAP and OIDC_ERROR_MAP', () => {
    // The drift guard. A code added to either map must either get a label or be
    // listed as deliberately unlabelled — "forgotten" is the state this cannot
    // be allowed to have, because forgetting is silent: the refusal just
    // reports `error` and looks like a crash.
    const codes = [...Object.keys(SAML_ERROR_MAP), ...Object.keys(OIDC_ERROR_MAP)];
    const undecided = codes.filter(
      (c) => ssoRefusalReason(c) === UNLABELLED_REFUSAL_REASON && !UNLABELLED_BY_DESIGN.includes(c),
    );
    expect(undecided).toEqual([]);
  });

  it('keeps the unlabelled-by-design list honest', () => {
    // An entry that no longer exists in either map is a stale exemption, and a
    // stale exemption is how a real code gets excused later.
    const codes = new Set([...Object.keys(SAML_ERROR_MAP), ...Object.keys(OIDC_ERROR_MAP)]);
    expect(UNLABELLED_BY_DESIGN.filter((c) => !codes.has(c))).toEqual([]);
  });

  it('reports the generic reason for a code with no label, and for nonsense', () => {
    // Four SAML codes deliberately have none: they reach no refusal path.
    expect(ssoRefusalReason('SAML_METADATA_INVALID')).toBe(UNLABELLED_REFUSAL_REASON);
    expect(ssoRefusalReason('NOT_A_CODE')).toBe(UNLABELLED_REFUSAL_REASON);
    expect(ssoRefusalReason(undefined)).toBe(UNLABELLED_REFUSAL_REASON);
    expect(ssoRefusalReason('')).toBe(UNLABELLED_REFUSAL_REASON);
  });

  it('finds a non-trivial number of labels, so the checks above are not vacuous', () => {
    expect(labelledRefusalCodes().length).toBeGreaterThanOrEqual(23);
  });
});

describe('the codes that had drifted', () => {
  // Known ONLY to controllers/saml.ts, so the SSO test flow reported `error`:
  // a misconfigured or unentitled connection looked like a crash in the one
  // report an admin runs to find out why sign-in is broken.
  it.each([
    ['SAML_NOT_CONFIGURED', 'not_configured'],
    ['SAML_DISABLED', 'disabled'],
    ['SAML_NOT_ENTITLED', 'not_entitled'],
    ['SAML_PROTOCOL_MISMATCH', 'protocol_mismatch'],
  ])('%s is labelled %s in BOTH paths now', (code, reason) => {
    expect(ssoRefusalReason(code)).toBe(reason);
  });

  // Known ONLY to helpers/sso-test-flow.ts, so the live ACS path reported
  // `error` for every OIDC-side refusal it could see.
  it.each([
    ['OIDC_INVALID_STATE', 'invalid_state'],
    ['OIDC_NO_EMAIL', 'no_email'],
    ['OIDC_EMAIL_DOMAIN_NOT_ALLOWED', 'email_domain_not_allowed'],
    ['OIDC_INVALID_ID_TOKEN', 'invalid_id_token'],
    ['OIDC_TOKEN_EXCHANGE_FAILED', 'token_exchange_failed'],
    ['OIDC_DISCOVERY_FAILED', 'discovery_failed'],
    ['IDP_ERROR', 'idp_error'],
  ])('%s is labelled %s in BOTH paths now', (code, reason) => {
    expect(ssoRefusalReason(code)).toBe(reason);
  });
});

describe('OIDC twins of labelled SAML codes', () => {
  it.each([
    ['NOT_CONFIGURED', 'not_configured'],
    ['DISABLED', 'disabled'],
    ['NOT_ENTITLED', 'not_entitled'],
    ['PROTOCOL_MISMATCH', 'protocol_mismatch'],
  ])('%s reports the same label for SAML and OIDC', (suffix, reason) => {
    // The asymmetry this closes: the SAML form was labelled and the OIDC form
    // was not, so the identical refusal was legible on one protocol only.
    expect(ssoRefusalReason(`SAML_${suffix}`)).toBe(reason);
    expect(ssoRefusalReason(`OIDC_${suffix}`)).toBe(reason);
  });

  it('does not invent OIDC codes for SAML-only concepts', () => {
    // Assertions, encryption and IdP-initiated flows are SAML ideas. A
    // mechanical twin pass produced these names; none exists, and labelling
    // them would put values in the metric that nothing can ever emit.
    for (const code of [
      'OIDC_INVALID_ASSERTION', 'OIDC_ENCRYPTION_REQUIRED', 'OIDC_UNEXPECTED_ENCRYPTION',
      'OIDC_IDP_INITIATED', 'OIDC_REPLAYED_ASSERTION', 'OIDC_INCOMPLETE_CONFIG',
    ]) {
      expect({ code, inCatalog: code in OIDC_ERROR_MAP, labelled: ssoRefusalReason(code) })
        .toEqual({ code, inCatalog: false, labelled: UNLABELLED_REFUSAL_REASON });
    }
  });
});
