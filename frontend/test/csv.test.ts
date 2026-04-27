// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseCsv } from '../src/lib/csv';

describe('parseCsv', () => {
  it('parses a simple header + rows', () => {
    const csv = 'a,b,c\n1,2,3\n4,5,6';
    const out = parseCsv(csv);
    expect(out.headers).toEqual(['a', 'b', 'c']);
    expect(out.rowCount).toBe(2);
    expect(out.rows).toEqual([
      { a: '1', b: '2', c: '3' },
      { a: '4', b: '5', c: '6' },
    ]);
  });

  it('handles quoted fields with embedded commas', () => {
    const csv = 'name,reason\n"plugin-a","approved by sec, see ticket"';
    const out = parseCsv(csv);
    expect(out.rows[0]).toEqual({ name: 'plugin-a', reason: 'approved by sec, see ticket' });
  });

  it('handles escaped double-quotes', () => {
    const csv = 'a,b\n"he said ""hi""","ok"';
    const out = parseCsv(csv);
    expect(out.rows[0]).toEqual({ a: 'he said "hi"', b: 'ok' });
  });

  it('handles quoted fields with embedded newlines', () => {
    const csv = 'a,b\n"line1\nline2","ok"';
    const out = parseCsv(csv);
    expect(out.rows[0]).toEqual({ a: 'line1\nline2', b: 'ok' });
  });

  it('handles CRLF line endings', () => {
    const csv = 'a,b\r\n1,2\r\n3,4\r\n';
    const out = parseCsv(csv);
    expect(out.rowCount).toBe(2);
    expect(out.rows[0]).toEqual({ a: '1', b: '2' });
    expect(out.rows[1]).toEqual({ a: '3', b: '4' });
  });

  it('skips trailing blank lines', () => {
    const csv = 'a\n1\n\n\n';
    const out = parseCsv(csv);
    expect(out.rowCount).toBe(1);
  });

  it('returns empty when input is empty', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [], rowCount: 0 });
  });

  it('trims whitespace in headers but preserves field contents', () => {
    const csv = ' a , b \nfoo , bar ';
    const out = parseCsv(csv);
    expect(out.headers).toEqual(['a', 'b']);
    expect(out.rows[0]).toEqual({ a: 'foo ', b: ' bar ' });
  });

  it('fills missing trailing cells with empty string', () => {
    const csv = 'a,b,c\n1,2';
    const out = parseCsv(csv);
    expect(out.rows[0]).toEqual({ a: '1', b: '2', c: '' });
  });
});
