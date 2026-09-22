// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The signer contract for platform's ES256 user-token keys.
 *
 * ONE interface, two implementations — AWS KMS where a managed key is available,
 * a local PEM (a file on docker, a mounted Kubernetes Secret on the k8s targets)
 * everywhere else. The choice is made once, at boot, from config; nothing at a
 * call site ever branches on it, so there is no dual code path to keep in step.
 *
 * A signer only ever SIGNS. Verification is a pure function of the public key,
 * which platform holds in memory for every key it publishes — so platform's own
 * verification never calls KMS and stays synchronous (the rate limiter and the
 * refresh path verify inline).
 */

import type { KeyObject } from 'crypto';

/** One signing key: what it is called publicly, what it can sign, what verifies it. */
export interface SigningKey {
  /** RFC 7638 thumbprint of the public key — the `kid` claim and the JWKS entry id. */
  kid: string;
  /** Published in the JWKS so every verifier can check this key's signatures. */
  publicKey: KeyObject;
  /**
   * Raw `r || s` ES256 signature over `input`. Absent on a RETIRING key: it is
   * still published (so tokens it signed keep verifying for one overlap window)
   * but must never sign anything new.
   */
  sign?(input: Buffer): Promise<Buffer>;
}

/** The key set platform boots with: one signing key, plus any retiring keys. */
export interface SigningKeySet {
  /** The key every new token is signed with. */
  current: SigningKey;
  /** Retiring keys — published for verification only. */
  retiring: SigningKey[];
}
