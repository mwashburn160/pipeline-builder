// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for validation/plugin-name-confusable — the name gate new community
 * listings pass (plugin-ecosystem §4.2 "Names", E9).
 */

import { describe, it, expect } from '@jest/globals';
import {
  damerauLevenshtein, findConfusableName, isConfusableName, normalizeConfusableName,
} from '../src/validation/plugin-name-confusable.js';

const TOP = ['terraform', 'kubectl', 'docker-build', 'tfsec', 'eslint', 'helm'];

describe('normalizeConfusableName', () => {
  it('lowercases, strips separators and folds look-alikes', () => {
    expect(normalizeConfusableName('Docker_Build.v2')).toBe('dockerbuildv2');
    expect(normalizeConfusableName('terraf0rm')).toBe('terraform');
    expect(normalizeConfusableName('he1m')).toBe('helm');
    expect(normalizeConfusableName('t3st5')).toBe('tests');
    expect(normalizeConfusableName('rnodern')).toBe('modem');
    expect(normalizeConfusableName('vvget')).toBe('wget');
  });
});

describe('damerauLevenshtein', () => {
  it('counts insertions, deletions, substitutions and adjacent transpositions as one edit', () => {
    expect(damerauLevenshtein('abc', 'abc')).toBe(0);
    expect(damerauLevenshtein('abc', 'abcd')).toBe(1);
    expect(damerauLevenshtein('abc', 'ab')).toBe(1);
    expect(damerauLevenshtein('abc', 'abx')).toBe(1);
    expect(damerauLevenshtein('abc', 'acb')).toBe(1);
    expect(damerauLevenshtein('kitten', 'sitting')).toBe(3);
    expect(damerauLevenshtein('', 'abc')).toBe(3);
  });

  it('stops early past the limit', () => {
    expect(damerauLevenshtein('abcdefgh', 'zzzzzzzz', 1)).toBe(2);
    expect(damerauLevenshtein('a', 'abcdef', 1)).toBe(2);
  });
});

describe('findConfusableName / isConfusableName', () => {
  it('flags look-alikes of top listings', () => {
    expect(findConfusableName('terraf0rm', TOP)).toBe('terraform');
    expect(findConfusableName('kube-ctl', TOP)).toBe('kubectl');
    expect(findConfusableName('docker_build', TOP)).toBe('docker-build');
    expect(findConfusableName('tfsed', TOP)).toBe('tfsec');
    expect(findConfusableName('eslnit', TOP)).toBe('eslint');
    expect(findConfusableName('terraforms', TOP)).toBe('terraform');
    expect(findConfusableName('he1m', TOP)).toBe('helm');
  });

  it('counts an exact name as a match', () => {
    expect(findConfusableName('helm', TOP)).toBe('helm');
  });

  it('lets clearly different names through', () => {
    expect(isConfusableName('my-linter', TOP)).toBe(false);
    expect(isConfusableName('terraform-docs', TOP)).toBe(false);
    expect(isConfusableName('prettier', TOP)).toBe(false);
    expect(isConfusableName('---', TOP)).toBe(false);
    expect(isConfusableName('anything', [])).toBe(false);
  });
});
