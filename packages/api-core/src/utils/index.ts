// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

export {
  setLogContextProvider,
  redactSensitive,
  createLogger,
  type Logger,
  logger,
  default,
} from './logger.js';
export * from './api-key.js';
export * from './safe-require.js';
export * from './secure-compare.js';
export * from './crash-handlers.js';
export {
  sendSuccess,
  sendError,
  sendQuotaExceeded,
  sendPaginatedNested,
  paginationMeta,
  type PaginationMeta,
  extractDbError,
  errorMessage,
  sendBadRequest,
  sendInternalError,
  parsePaginationParams,
  type PaginationParams,
  type SortParams,
} from './response.js';
export {
  getParam,
  parseQueryInt,
  parseQueryString,
  parseOptionalDate,
  parsePositiveInt,
  parseQueryIntClamped,
  parsePage,
  validateBulkArray,
  parseReportInterval,
  parseDateRange,
  type Page,
  REPORT_INTERVALS,
} from './params.js';
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
  encodeJwsSigningInput,
  compactJws,
} from './jwk.js';
export type {
  PublicJwk,
  JwksDocument,
} from './jwk.js';
export * from './object.js';
export * from './date.js';
export {
  resetSupportAliasesCache,
  getPrimarySupportAlias,
  getAllSupportAliases,
  resolveRecipientAlias,
  DEFAULT_SUPPORT_ALIAS,
} from './alias-resolver.js';
export * from './concurrency.js';
export * from './audit.js';
export {
  getDefaultKeyProvider,
  resetDefaultKeyProvider,
  setKeyProvider,
  encryptSecret,
  decryptSecret,
  isEncryptedBlob,
  type EncryptedBlob,
  type KeyProvider,
  EnvKeyProvider,
  KmsKeyProvider,
  type PerOrgKmsConfig,
  type PerOrgKmsResolver,
  PerOrgKmsKeyProvider,
} from './secret-encryption.js';
export * from './secret-rotation.js';
export {
  setCounterEmitter,
  resetCounterEmitter,
  emitCounter,
} from './metric-emitter.js';
export * from './aws-scrub.js';
export {
  extractPredicate,
  SPDX_PREDICATE_TYPE,
} from './dsse.js';
export {
  maskLine,
  looksSensitive,
  REDACTED,
  SENSITIVE_VALUE_PATTERNS,
} from './sensitive-patterns.js';
export {
  isPrivateAddress,
  assertSafeUrl,
  safeFetch,
  type SafeFetchResponse,
} from './ssrf.js';
export * from './env.js';
export * from './service-registry.js';
export * from './retention.js';
export * from './compliance-attributes.js';
export {
  leadingZeroBits,
  proofOfWorkHash,
  challengeKey,
  clampDifficulty,
  createProofOfWorkChallenge,
  parseProofOfWorkChallenge,
  verifyProofOfWork,
  solveProofOfWork,
  POW_DEFAULT_DIFFICULTY,
  POW_MAX_DIFFICULTY,
  POW_CHALLENGE_TTL_MS,
  type ProofOfWorkChallenge,
  type ProofOfWorkSolution,
} from './proof-of-work.js';
