// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Secret values never enter the model's context.
 *
 * Pipelines and templates carry secret material in their `props` — build `env`
 * and `buildArgs` values, a source `token`, anything under a secret-named key.
 * Everything a tool returns is fed back to the model, and anything in that
 * context can surface in the assistant's prose or in a later tool call, so the
 * agent's tool results are projected through {@link redactForModel} before the
 * model sees them (`toModelOutput`, wired once in `buildAgentTools`). The Ask
 * panel still receives the unredacted result — it is the caller's own data, read
 * with their own token — so a reviewable diff shows real values.
 *
 * WHERE a secret lives is api-core's `mapSecretValues` — the same definition the
 * compliance attributes use — so the two cannot drift.
 *
 * Each secret is replaced by a PLACEHOLDER that names it without revealing it:
 * `[REDACTED:<tag>]`, the tag an HMAC of the value under a per-process random
 * key. That is what lets an EDIT round-trip: the model hands back a whole
 * `props` document still carrying placeholders, and {@link restoreSecrets} puts
 * the real values back — by tag, so a secret is restored correctly even when the
 * model moved the step that carries it — before anything is diffed or proposed.
 * A placeholder is therefore never written over a real secret.
 */

import { createHmac, randomBytes } from 'crypto';

import { mapSecretValues, type SecretValuePath } from '@pipeline-builder/api-core';

/**
 * Key for the placeholder tags. Per process: a tag is only ever restored within
 * the turn that produced it (tool results are not part of the client-held
 * history), and a random key keeps a tag from being checked against a guessed
 * value offline.
 */
const TAG_KEY = randomBytes(32);

/** `[REDACTED:<12 hex>]`, or the bare `[REDACTED]` marker other projections write. */
const PLACEHOLDER = /^\[REDACTED(?::([0-9a-f]{12}))?\]$/;

function tagOf(value: unknown): string {
  return createHmac('sha256', TAG_KEY).update(JSON.stringify(value) ?? 'undefined').digest('hex').slice(0, 12);
}

/** Nothing to hide in an unset value — and "is it set?" is part of the diagnosis. */
const isUnset = (v: unknown): boolean => v === undefined || v === null || v === '';

/** `props.stages[0].steps[1].env.API_KEY` */
export function formatPath(path: SecretValuePath): string {
  return path.reduce<string>((out, seg) => (typeof seg === 'number' ? `${out}[${seg}]` : out ? `${out}.${seg}` : seg), '');
}

/** Replace every secret value in `value` with its placeholder. Keys and structure are kept. */
export function redactForModel(value: unknown): unknown {
  return mapSecretValues(value, (secret) => (isUnset(secret) ? secret : `[REDACTED:${tagOf(secret)}]`));
}

export interface SecretRestoreResult {
  /** `changes` with every recognised placeholder replaced by the real value. */
  value: unknown;
  /** Placeholders that match no secret of the current document (stale, invented, or bare markers). */
  unknownPlaceholders: string[];
  /** Secret positions the model gave a NEW value where the current document already holds a different secret. */
  overwrittenSecrets: string[];
  /** Secret positions the model gave a value where the current document holds none. */
  addedSecrets: string[];
}

/**
 * Restore the real secret values into a model-proposed `changes` object, and
 * report every way the model touched a secret.
 *
 * `current` is the entity as it is NOW, unredacted — the edit tool's own re-read.
 * A placeholder anywhere in `changes` is swapped for the value whose tag it
 * carries; one that matches nothing is reported, never passed through. A
 * plaintext value at a secret position was written by the model (it never saw a
 * real one): reported as an overwrite when the current document holds a
 * different secret at that path, as an addition when it holds none.
 */
export function restoreSecrets(changes: unknown, current: unknown): SecretRestoreResult {
  const byTag = new Map<string, unknown>();
  const byPath = new Map<string, unknown>();
  mapSecretValues(current, (secret, path) => {
    if (!isUnset(secret)) {
      byTag.set(tagOf(secret), secret);
      byPath.set(formatPath(path), secret);
    }
    return secret;
  });

  const unknownPlaceholders: string[] = [];
  const restoredPaths = new Set<string>();
  const restore = (v: unknown, path: Array<string | number>): unknown => {
    if (typeof v === 'string') {
      const m = PLACEHOLDER.exec(v);
      if (!m) return v;
      const tag = m[1];
      if (tag !== undefined && byTag.has(tag)) {
        restoredPaths.add(formatPath(path));
        return byTag.get(tag);
      }
      unknownPlaceholders.push(formatPath(path));
      return v;
    }
    if (Array.isArray(v)) return v.map((item, i) => restore(item, [...path, i]));
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, child]) => [k, restore(child, [...path, k])]));
    }
    return v;
  };
  const value = restore(changes, []);

  const overwrittenSecrets: string[] = [];
  const addedSecrets: string[] = [];
  mapSecretValues(value, (secret, path) => {
    const at = formatPath(path);
    if (isUnset(secret) || restoredPaths.has(at) || unknownPlaceholders.includes(at)) return secret;
    const existing = byPath.get(at);
    if (existing === undefined) addedSecrets.push(at);
    else if (JSON.stringify(existing) !== JSON.stringify(secret)) overwrittenSecrets.push(at);
    return secret;
  });

  return { value, unknownPlaceholders, overwrittenSecrets, addedSecrets };
}
