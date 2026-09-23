// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * DSSE-envelope parsing for cosign attestation output.
 *
 * `cosign verify-attestation` prints one DSSE envelope per VERIFIED attestation,
 * one JSON object per line:
 * `{ payloadType, payload: base64(in-toto statement), signatures }`.
 * Signature verification has already happened in cosign by the time we see this
 * — this module only decodes what cosign vouched for.
 *
 * This lives in api-core because BOTH the plugin service (build-time SBOM read)
 * and the image-registry service (registry-side signed-SBOM read) parse the same
 * output. Two hand-copied parse loops in supply-chain verification code is a
 * security risk, not untidiness: a fix applied to one copy silently leaves the
 * other accepting what it should not.
 *
 * Callers keep their OWN not-found policy on top (throw vs. return null) —
 * that is a per-service decision, the parse is not.
 */

/** in-toto predicate type for an SPDX SBOM, as cosign's `--type spdxjson` emits. */
export const SPDX_PREDICATE_TYPE = 'https://spdx.dev/Document';

/**
 * Return the predicate of the LAST envelope in `stdout` whose in-toto statement
 * carries `predicateType`, or null when none does.
 *
 * LAST, not first: a rebuild re-attests the same digest and cosign lists
 * attestations oldest-first, so the newest attestation is the final line.
 *
 * Lines that are not parseable envelopes are skipped rather than fatal — cosign
 * prints nothing else on stdout today, but stray output must not turn a valid
 * attestation into a verification failure.
 */
export function extractPredicate(stdout: string, predicateType: string): Record<string, unknown> | null {
  let predicate: Record<string, unknown> | null = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const envelope = JSON.parse(trimmed) as { payload?: string };
      if (!envelope.payload) continue;
      const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf-8')) as {
        predicateType?: string;
        predicate?: unknown;
      };
      if (statement.predicateType === predicateType && statement.predicate && typeof statement.predicate === 'object') {
        predicate = statement.predicate as Record<string, unknown>;
      }
    } catch {
      // Not an envelope line.
    }
  }
  return predicate;
}
