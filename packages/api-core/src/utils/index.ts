// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

export * from './logger.js';
export * from './api-key.js';
export * from './safe-require.js';
export * from './secure-compare.js';
export * from './crash-handlers.js';
export * from './response.js';
export * from './params.js';
export * from './headers.js';
export * from './identity.js';
// JWK primitives. Platform IS the token signer, so it legitimately needs
// `publicJwkFrom` + `derToJoseSignature` from the package surface.
// `jwkThumbprint` and `publicKeyFromJwk` are kid-derivation/verification
// plumbing used only inside api-core — deep-import them from there instead of
// leaking them to every service.
export {
  USER_TOKEN_ALGORITHM,
  USER_TOKEN_CURVE,
  JWKS_PATH,
  decodeJwtHeader,
  isJwksDocument,
  publicJwkFrom,
  derToJoseSignature,
} from './jwk.js';
export type { PublicJwk, JwksDocument, JwtHeader } from './jwk.js';
export * from './object.js';
export * from './alias-resolver.js';
export * from './concurrency.js';
export * from './audit.js';
export * from './secret-encryption.js';
export * from './secret-rotation.js';
export * from './metric-emitter.js';
export * from './aws-scrub.js';
export * from './sensitive-patterns.js';
export * from './ssrf.js';
export * from './env.js';
export * from './compliance-attributes.js';
