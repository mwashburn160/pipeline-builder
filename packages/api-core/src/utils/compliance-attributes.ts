// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Secret-redaction for compliance-event `attributes`.
 *
 * Shared by the plugin AND pipeline services (previously a byte-identical copy
 * in each — a security-critical function that must not drift: a future "also
 * redact `credentials`" fix has to protect BOTH services). Both feed entity
 * attributes to the compliance engine over Redis, and neither may leak plaintext
 * secrets there.
 *
 * The compliance rule engine reads secret maps (`env`/`buildArgs`, incl. nested
 * `props.synth.env`, `props.stages[].steps[].env`, …) ONLY by KEY — `$keys(env)`,
 * `$count(env)`, dot-path existence, key-`contains` — never by value (see
 * api/compliance/src/engine/rule-operators.ts + its tests). So we preserve each
 * secret map's shape + KEYS while overwriting every value with a marker; scalar
 * secret fields (source `token`, passwords, …) are replaced outright. Structure
 * and non-secret metadata pass through unchanged, so rule evaluation is
 * identical while plaintext secrets never reach Redis or the compliance service.
 */

/** Marker written in place of a redacted secret VALUE. */
const REDACTED = '[REDACTED]';

/** Map keys whose (string→string) VALUES are secret build-time material. */
const SECRET_MAP_KEYS = new Set(['env', 'buildArgs']);

/**
 * Scalar keys that themselves carry a secret string (tokens/passwords/etc.).
 * Applied only to string values so boolean flags and declaration arrays (e.g.
 * `secrets: PluginSecret[]`) are left intact.
 */
function isSecretScalarKey(key: string): boolean {
  const k = key.toLowerCase();
  return k.includes('token') || k.includes('secret') || k.includes('password')
    || k.includes('passphrase') || k.includes('credential') || k.includes('apikey')
    || k.includes('accesskey') || k.includes('privatekey');
}

/** Only plain (Object-prototype) objects are traversed — Dates/class instances pass through intact. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Project an entity into the compliance-event `attributes`, redacting secret
 * VALUES while preserving everything the compliance engine actually evaluates.
 * Recurses so nested secrets (deep inside a pipeline's `props`) are covered too.
 */
export function toComplianceAttributes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toComplianceAttributes);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_MAP_KEYS.has(k) && isPlainObject(v)) {
        // Preserve keys (compliance reads $keys/$count/presence), redact values.
        out[k] = Object.fromEntries(Object.keys(v).map((mk) => [mk, REDACTED]));
      } else if (isSecretScalarKey(k) && typeof v === 'string') {
        out[k] = REDACTED;
      } else {
        out[k] = toComplianceAttributes(v);
      }
    }
    return out;
  }
  return value; // primitives, Date, null — untouched
}
