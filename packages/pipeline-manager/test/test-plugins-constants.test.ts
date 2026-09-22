// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guard for deploy/bin/test-plugins.sh: the catalog's bash validator
 * keeps its own copies of the plugin enums, catalog vocabularies and limits,
 * and a value the upload API refuses must fail there first (and vice versa).
 * Every list and limit is parsed out of the script and compared with the
 * api-core schema it mirrors.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from '@jest/globals';
import {
  EGRESS_MAX_HOSTS, ICON_KEY_PATTERN, PLUGIN_BUILD_TYPES, PLUGIN_CATEGORIES, PLUGIN_CHANGELOG_MAX_BYTES,
  PLUGIN_COMPUTE_TYPES, PLUGIN_FAILURE_BEHAVIORS, PLUGIN_LINT_CODEBUILD_FIELDS, PLUGIN_LINT_REQUIRED_FIELDS,
  PLUGIN_README_MAX_BYTES, PLUGIN_TYPES, SPDX_LICENSE_IDS, URL_SHORTENER_HOSTS,
} from '@pipeline-builder/api-core';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = fs.readFileSync(path.join(REPO, 'deploy/bin/test-plugins.sh'), 'utf-8');

/** The quoted members of a top-level bash array `NAME=( "a" "b" ... )` (may span lines). */
function bashArray(name: string): string[] {
  const m = new RegExp(`^${name}=\\(([\\s\\S]*?)\\)`, 'm').exec(SCRIPT);
  if (!m) throw new Error(`test-plugins.sh: no array ${name}`);
  return [...m[1]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!);
}

/** A top-level integer assignment: `NAME=50` or `NAME=$((64 * 1024))`. */
function bashInt(name: string): number {
  const m = new RegExp(`^${name}=(?:\\$\\(\\(\\s*(\\d+)\\s*\\*\\s*(\\d+)\\s*\\)\\)|(\\d+))\\s*$`, 'm').exec(SCRIPT);
  if (!m) throw new Error(`test-plugins.sh: no integer ${name}`);
  return m[3] !== undefined ? Number(m[3]) : Number(m[1]) * Number(m[2]);
}

/** A top-level single-quoted string assignment: `NAME='...'`. */
function bashString(name: string): string {
  const m = new RegExp(`^${name}='([^']*)'`, 'm').exec(SCRIPT);
  if (!m) throw new Error(`test-plugins.sh: no string ${name}`);
  return m[1]!;
}

const sorted = (xs: Iterable<string>) => [...xs].sort();

describe('test-plugins.sh mirrors the api-core plugin schema', () => {
  it.each([
    ['VALID_PLUGIN_TYPES', PLUGIN_TYPES],
    ['VALID_COMPUTE_TYPES', PLUGIN_COMPUTE_TYPES],
    ['VALID_FAILURE_BEHAVIORS', PLUGIN_FAILURE_BEHAVIORS],
    ['VALID_CATEGORIES', PLUGIN_CATEGORIES],
    ['VALID_BUILD_TYPES', PLUGIN_BUILD_TYPES],
  ] as const)('%s', (name, schema) => {
    expect(bashArray(name)).toEqual([...schema]);
  });

  it.each([
    ['SPDX_LICENSE_IDS', SPDX_LICENSE_IDS],
    ['URL_SHORTENER_HOSTS', URL_SHORTENER_HOSTS],
  ] as const)('%s (as a set)', (name, schema) => {
    const list = bashArray(name);
    expect(new Set(list).size).toBe(list.length);
    expect(sorted(list)).toEqual(sorted(schema));
  });

  it.each([
    ['README_MAX_BYTES', PLUGIN_README_MAX_BYTES],
    ['CHANGELOG_MAX_BYTES', PLUGIN_CHANGELOG_MAX_BYTES],
    ['EGRESS_MAX_HOSTS', EGRESS_MAX_HOSTS],
  ] as const)('%s', (name, value) => {
    expect(bashInt(name)).toBe(value);
  });

  it('ICON_KEY_RE', () => {
    expect(bashString('ICON_KEY_RE')).toBe(ICON_KEY_PATTERN.source);
  });

  it('the required spec fields match the shared lint', () => {
    expect(sorted([...bashArray('REQUIRED_FIELDS'), ...bashArray('V2_FIELDS')])).toEqual(sorted(PLUGIN_LINT_REQUIRED_FIELDS));
    expect(bashArray('CODEBUILD_FIELDS')).toEqual([...PLUGIN_LINT_CODEBUILD_FIELDS]);
  });
});
