// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The CSV EXPORT path (the parser has its own suite in csv.test.ts). What the
 * file contains is read back through the real parser, so these assertions are
 * about what a spreadsheet would see, not about string shapes.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { downloadCsv } from '../src/lib/csv-export';
import { parseCsv } from '../src/lib/csv';

/** Run an export and return the CSV text it produced. */
async function exported(rows: Array<Record<string, unknown>>, headers: string[]): Promise<string> {
  let blob: Blob | undefined;
  const original = URL.createObjectURL;
  URL.createObjectURL = ((b: Blob) => { blob = b; return 'blob:test'; }) as typeof URL.createObjectURL;
  try {
    downloadCsv(rows, headers, 'out');
  } finally {
    URL.createObjectURL = original;
  }
  // jsdom's Blob has no `.text()`; FileReader is the portable way to read it.
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob!);
  });
}

describe('downloadCsv — formula injection', () => {
  it('quotes a cell containing a bare CR, so a formula cannot start a new cell', async () => {
    // The formula guard only inspects the FIRST character. A bare carriage
    // return is a row break to Excel, so an unquoted `x\r=HYPERLINK(...)` (a
    // build error message is enough to carry one) put the formula at the start
    // of a new cell, where it executed.
    // No comma and no double quote: nothing else would have forced quoting,
    // so only the CR rule stands between this and a live formula.
    const payload = 'x\r=1+2';
    const csv = await exported([{ msg: payload }], ['msg']);

    expect(csv.split('\n')[1]).toBe('"x\r=1+2"');
    expect(parseCsv(csv).rows[0]!.msg).toBe(payload);
  });

  it('still neutralises a leading formula character', async () => {
    const csv = await exported([{ name: '=cmd|\'/c calc\'' }], ['name']);
    expect(parseCsv(csv).rows[0]!.name).toBe("'=cmd|'/c calc'");
  });
});

describe('triggerBlobDownload', () => {
  it('revokes the object URL only AFTER the click has been handled', () => {
    // A synchronous revoke can cancel the download before the browser reads
    // the blob — occasional empty/failed files on the large exports.
    jest.useFakeTimers();
    const revoke = jest.spyOn(URL, 'revokeObjectURL');
    try {
      downloadCsv([{ a: 1 }], ['a'], 'out');
      expect(revoke).not.toHaveBeenCalled();
      jest.runAllTimers();
      expect(revoke).toHaveBeenCalledTimes(1);
    } finally {
      revoke.mockRestore();
      jest.useRealTimers();
    }
  });
});
