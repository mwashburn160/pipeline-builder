// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * In-memory ES256 signing keys for the platform suites.
 *
 * Platform is the only minter of user tokens, so anything that exercises the
 * real `utils/token.ts` (issueTokens, signApiKeyToken, issueStepUpToken,
 * issueImpersonationToken) needs a loaded signing key. Rather than writing a PEM
 * to disk per suite — or reaching for KMS — this generates keys in memory and
 * installs them through the token-signing test seam, which also points api-core's
 * JWKS cache at them so `requireStepUp` and friends verify without any HTTP.
 *
 * Call it once at the top of a suite (it is idempotent per call — each call
 * installs a fresh set).
 */

import crypto from 'crypto';
import { publicJwkFrom } from '@pipeline-builder/api-core';
import { _setTokenSigningKeysForTests } from '../../src/services/token-signing/index.js';
import type { SigningKey, SigningKeySet } from '../../src/services/token-signing/signer.js';

/** One generated key. `canSign: false` yields a verification-only (retiring) key. */
export function generateSigningKey(opts: { canSign?: boolean } = {}): SigningKey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const { kid } = publicJwkFrom(publicKey);
  return {
    kid,
    publicKey,
    ...(opts.canSign === false
      ? {}
      : { sign: async (input: Buffer) => crypto.sign('sha256', input, { key: privateKey, dsaEncoding: 'ieee-p1363' }) }),
  };
}

/**
 * Install a signing key set: one signing key plus `retiring` verification-only
 * keys (the rotation-overlap shape). Returns the set so a test can assert on
 * `kid`s.
 */
export function installTestSigningKeys(retiring = 0): SigningKeySet {
  const set: SigningKeySet = {
    current: generateSigningKey(),
    retiring: Array.from({ length: retiring }, () => generateSigningKey({ canSign: false })),
  };
  _setTokenSigningKeysForTests(set);
  return set;
}

/** Drop the installed keys (and the JWKS cache pointing at them). */
export function clearTestSigningKeys(): void {
  _setTokenSigningKeysForTests(undefined);
}
