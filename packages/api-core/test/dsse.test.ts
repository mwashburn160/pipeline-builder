// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The DSSE parse loop is supply-chain verification code shared by the plugin
 * and image-registry services. It is pinned HERE — the shared home — so the two
 * services cannot drift on what counts as a valid attestation.
 */

import { describe, it, expect } from '@jest/globals';

import { extractPredicate, SPDX_PREDICATE_TYPE } from '../src/utils/dsse.js';

const SLSA = 'https://slsa.dev/provenance/v1';

/** A DSSE envelope as cosign prints it: base64 in-toto statement in `payload`. */
const envelope = (statement: unknown): string => JSON.stringify({
  payloadType: 'application/vnd.in-toto+json',
  payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
  signatures: [{ keyid: '', sig: 'zzz' }],
});

const spdx = (predicate: unknown) => envelope({ _type: 'https://in-toto.io/Statement/v0.1', predicateType: SPDX_PREDICATE_TYPE, predicate });

describe('extractPredicate', () => {
  it('returns the LAST matching predicate (a rebuild re-attests; cosign lists oldest first)', () => {
    const out = [
      'Verification for registry/plugin@sha256:abc --',
      'The following checks were performed on each of these signatures:',
      spdx({ spdxVersion: 'SPDX-2.3', name: 'old' }),
      spdx({ spdxVersion: 'SPDX-2.3', name: 'new' }),
    ].join('\n');
    expect(extractPredicate(out, SPDX_PREDICATE_TYPE)).toEqual({ spdxVersion: 'SPDX-2.3', name: 'new' });
  });

  it('ignores envelopes of a different predicate type, even when they come last', () => {
    const out = [
      spdx({ name: 'sbom' }),
      envelope({ predicateType: SLSA, predicate: { builder: {} } }),
    ].join('\n');
    expect(extractPredicate(out, SPDX_PREDICATE_TYPE)).toEqual({ name: 'sbom' });
  });

  it('selects by the requested predicate type, not a hard-coded one', () => {
    const out = [spdx({ name: 'sbom' }), envelope({ predicateType: SLSA, predicate: { builder: { id: 'pb' } } })].join('\n');
    expect(extractPredicate(out, SLSA)).toEqual({ builder: { id: 'pb' } });
  });

  it.each([
    ['empty output', ''],
    ['whitespace only', '  \n\n  '],
    ['non-JSON noise', 'The following checks were performed\n{not json'],
    ['an envelope without a payload', JSON.stringify({ payloadType: 'x' })],
    ['a payload that is not base64 JSON', JSON.stringify({ payload: Buffer.from('nope').toString('base64') })],
    ['a non-matching predicate type', envelope({ predicateType: SLSA, predicate: { a: 1 } })],
    ['a statement whose predicate is not an object', spdx('string')],
    ['a statement with no predicate at all', envelope({ predicateType: SPDX_PREDICATE_TYPE })],
  ])('returns null for %s', (_label, out) => {
    expect(extractPredicate(out, SPDX_PREDICATE_TYPE)).toBeNull();
  });

  it('tolerates indentation and blank lines around real envelopes', () => {
    expect(extractPredicate(`\n   ${spdx({ name: 'x' })}   \n\n`, SPDX_PREDICATE_TYPE)).toEqual({ name: 'x' });
  });

  it('does not treat a null predicate as a match (typeof null === "object")', () => {
    expect(extractPredicate(spdx(null), SPDX_PREDICATE_TYPE)).toBeNull();
  });

  it('exposes the SPDX predicate type both services verify against', () => {
    expect(SPDX_PREDICATE_TYPE).toBe('https://spdx.dev/Document');
  });
});
