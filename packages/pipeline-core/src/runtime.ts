// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * @module @pipeline-builder/pipeline-core/runtime
 *
 * The Lambda-runtime entry: the small, dependency-light helpers the platform's
 * Lambdas (pipeline-events, pipeline-manager's token-renew handler) bundle into
 * their one-file zips — platform-credential handling, audit-correlation headers,
 * platform TLS policy and the synth-failure line protocol.
 *
 * Deliberately NOT the package root: the root barrel pulls in the config layer,
 * axios and api-core, which a bundled Lambda must not carry. Every module
 * re-exported here is a leaf (node built-ins only), except the credential
 * helpers, which import `@aws-sdk/client-secrets-manager` — provided by the AWS
 * Lambda Node.js runtime and kept external by the bundle step, so consumers that
 * call them outside Lambda must install it themselves.
 */

export {
  ACCESS_KEY_PREFIXES,
  isCredentialRefusal,
  assertAccessKey,
  readCredentialSecret,
  readAccessKeyFromSecret,
  createPlatformCredential,
  type PlatformCredential,
} from './handlers/platform-credential.js';
export { MAX_CORRELATION_VALUE, sanitizeCorrelationValue, correlationHeaders } from './core/audit-correlation.js';
export {
  PLATFORM_CA_BUNDLE_ENV,
  PLATFORM_TLS_VERIFY_ENV,
  platformCaBundle,
  platformCaList,
  platformTlsVerify,
} from './core/platform-tls.js';
export {
  SYNTH_FAILURE_MARKER,
  synthFailure,
  formatSynthFailure,
  parseSynthFailure,
  type SynthFailure,
  type SynthFailurePlugin,
} from './core/synth-failure.js';
