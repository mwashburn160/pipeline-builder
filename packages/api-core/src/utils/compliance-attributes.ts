// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Secret-redaction for compliance-event `attributes`.
 *
 * Shared by the plugin AND pipeline services — a security-critical function
 * that must not drift: an "also redact `credentials`" fix has to protect BOTH. Both feed entity
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

import { RULE_FIELDS, type RuleTarget } from '../types/wire-vocabulary.js';

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

/** A JSON path from the document root: object keys and array indices. */
export type SecretValuePath = ReadonlyArray<string | number>;

/**
 * Walk `value` and replace every secret VALUE with `replace(secret, path)`,
 * leaving keys, structure and non-secret fields as they are. The ONE definition
 * of "where a secret lives in an entity" — each value of a secret map (`env`,
 * `buildArgs`, at any depth), and any string under a secret-named key (token,
 * secret, password, credential, …) — shared by every projection that must not
 * leak one: the compliance attributes below, and the Ask assistant's model
 * context, which needs a placeholder it can restore.
 *
 * Only plain objects and arrays are traversed; everything else passes through.
 */
export function mapSecretValues(value: unknown, replace: (secret: unknown, path: SecretValuePath) => unknown): unknown {
  const walk = (v: unknown, path: Array<string | number>): unknown => {
    if (Array.isArray(v)) return v.map((item, i) => walk(item, [...path, i]));
    if (!isPlainObject(v)) return v; // primitives, Date, null — untouched
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(v)) {
      if (SECRET_MAP_KEYS.has(k) && isPlainObject(child)) {
        // Preserve keys (compliance reads $keys/$count/presence), redact values.
        out[k] = Object.fromEntries(Object.entries(child).map(([mk, mv]) => [mk, replace(mv, [...path, k, mk])]));
      } else if (isSecretScalarKey(k) && typeof child === 'string') {
        out[k] = replace(child, [...path, k]);
      } else {
        out[k] = walk(child, [...path, k]);
      }
    }
    return out;
  };
  return walk(value, []);
}

/**
 * Project an entity into the compliance-event `attributes`, redacting secret
 * VALUES while preserving everything the compliance engine actually evaluates.
 * Recurses so nested secrets (deep inside a pipeline's `props`) are covered too.
 */
export function toComplianceAttributes(value: unknown): unknown {
  return mapSecretValues(value, () => REDACTED);
}

/**
 * The stored fields of `source` that `target`'s rules can read: one copy of
 * every non-derived root in {@link RULE_FIELDS}, skipping the ones `source`
 * doesn't have. The live checks build their payload with this, so a field the
 * rule catalog lists can't be missing from what they send. Derived fields (a
 * plugin's image facts, a pipeline's `stepFacts`) are added by their own
 * derivations, never copied from a caller.
 */
export function pickRuleAttributes(target: RuleTarget, source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of RULE_FIELDS[target]) {
    if (spec.derived) continue;
    const root = spec.path.split('.')[0]!;
    if (source[root] !== undefined) out[root] = source[root];
  }
  return out;
}
