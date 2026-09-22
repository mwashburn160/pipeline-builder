// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * utils/output-utils.ts — the CLI's data output: json/yaml/csv/table rendering
 * (CSV escaping, table truncation/alignment), writing to a file INSIDE the
 * working directory only (path traversal refused), append mode, and the
 * display helpers.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const out = await import('../src/utils/output-utils.js');

const WORK = mkdtempSync(join(tmpdir(), 'pm-output-'));
const cwd = process.cwd();
const logged: string[] = [];
// eslint-disable-next-line no-control-regex
const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

beforeEach(() => {
  logged.length = 0;
  process.chdir(WORK);
  for (const m of ['log', 'error', 'warn', 'info', 'table'] as const) {
    jest.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(strip(a.map(String).join(' '))); });
  }
});
afterAll(() => {
  process.chdir(cwd);
  rmSync(WORK, { recursive: true, force: true });
});

const rows = [{ id: 'p1', name: 'alpha', note: 'has, comma' }, { id: 'p2', name: 'beta "quoted"', note: null }];

describe('outputData formats', () => {
  it('json: pretty by default, compact on request', () => {
    out.outputData({ a: 1 }, { silent: true });
    expect(logged.at(-1)).toBe('{\n  "a": 1\n}');
    out.outputData({ a: 1 }, { pretty: false });
    expect(logged.at(-1)).toBe('{"a":1}');
    expect(logged).toContainEqual(expect.stringContaining('Rendering as JSON'));
  });

  it('yaml', () => {
    out.outputData({ a: [1, 2] }, { format: 'yaml' });
    expect(logged.at(-1)).toContain('a:\n  - 1\n  - 2');
  });

  it('csv: quotes commas/quotes, blanks nulls; a scalar list joins; empty is empty', () => {
    out.outputData(rows, { format: 'csv', silent: true });
    expect(logged.at(-1)).toBe('id,name,note\np1,alpha,"has, comma"\np2,"beta ""quoted""",');
    out.outputData(['a', 'b'], { format: 'csv', silent: true });
    expect(logged.at(-1)).toBe('a,b');
    out.outputData([], { format: 'csv', silent: true });
    expect(logged.at(-1)).toBe('');
  });

  it('table: a list, a single object, and a scalar fall-back', () => {
    out.outputData(rows, { format: 'table' });
    expect(logged.at(-1)).toContain('│ id');
    expect(logged.at(-1)).toContain('beta "quoted"');
    out.outputData({ id: 'solo' }, { format: 'table', silent: true });
    expect(logged.at(-1)).toContain('solo');
    out.outputData('scalar', { format: 'table', silent: true });
    expect(console.table).toHaveBeenCalledWith(['scalar']);
  });
});

describe('formatTable', () => {
  it('renders nothing-to-show for empty input and JSON for scalar rows', () => {
    expect(strip(out.formatTable([]))).toBe('(No data to display)');
    expect(out.formatTable([1, 2])).toBe('[\n  1,\n  2\n]');
  });

  it('honours column widths, formatters and alignment, truncating overflow with …', () => {
    const t = strip(out.formatTable([{ n: 'abcdefghij', v: 7, c: 'x' }], [
      { header: 'N', key: 'n', width: 6 },
      { header: 'V', key: 'v', align: 'right', formatter: (x) => `#${x}` },
      { header: 'C', key: 'c', align: 'center', width: 5 },
    ]));
    expect(t).toContain('abc...');
    expect(t).toContain(' #7 ');
    expect(t).toContain('  x  ');
    expect(t.split('\n')[0]).toMatch(/^┌─+┬/);
  });
});

describe('file output', () => {
  it('writes, then appends, inside the working directory (creating the directory)', () => {
    out.outputData({ a: 1 }, { file: 'nested/out.json', silent: true });
    expect(readFileSync(join(WORK, 'nested/out.json'), 'utf8')).toBe('{\n  "a": 1\n}');
    out.outputData({ b: 2 }, { file: 'nested/out.json', silent: true, append: true, pretty: false });
    expect(readFileSync(join(WORK, 'nested/out.json'), 'utf8')).toBe('{\n  "a": 1\n}{"b":2}\n');
    expect(out.fileExists('nested/out.json')).toBe(true);
  });

  it('refuses a path that escapes the working directory', () => {
    expect(() => out.outputData({ a: 1 }, { file: '../../escape.json', silent: true })).toThrow('Path traversal rejected');
    expect(logged).toContainEqual(expect.stringContaining('Failed to write file'));
  });

  it('ensureOutputDirectory is idempotent and reports a failure', () => {
    out.ensureOutputDirectory(join(WORK, 'd1'));
    out.ensureOutputDirectory(join(WORK, 'd1'));
    expect(existsSync(join(WORK, 'd1'))).toBe(true);
    expect(() => out.ensureOutputDirectory('/dev/null/cannot')).toThrow();
    expect(logged).toContainEqual(expect.stringContaining('Failed to create directory'));
  });
});

describe('display helpers', () => {
  it('prints sections, key/values and dividers', () => {
    out.printSection('Title', 'sub');
    out.printKeyValue({ short: 1, longerKey: { nested: true } }, { indent: 2, separator: ':' });
    out.printDivider('=', 5);
    out.printDivider();
    const text = logged.join('\n');
    expect(text).toContain('Title');
    expect(text).toContain('sub');
    expect(text).toContain('  short     : 1');
    expect(text).toContain('{"nested":true}');
    expect(text).toContain('=====');
  });

  it('prints debug only when DEBUG=true', () => {
    const prev = process.env.DEBUG;
    process.env.DEBUG = 'false';
    out.printDebug('hidden');
    process.env.DEBUG = 'true';
    out.printDebug('shown', { k: 1 });
    process.env.DEBUG = prev;
    expect(logged.join('\n')).not.toContain('hidden');
    expect(logged.join('\n')).toContain('shown');
  });
});
