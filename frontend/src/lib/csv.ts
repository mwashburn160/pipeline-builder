// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal CSV parser. Handles:
 *   - Quoted fields with embedded commas/newlines/double-quotes ("" → ")
 *   - LF or CRLF line endings
 *   - Optional header row (returned as the first key set)
 *   - Trailing blank lines (skipped)
 *
 * Not goals: streaming, type coercion beyond raw strings, locale-specific
 * separators. For ~500-row exemption imports that's deliberate; bring in
 * `papaparse` if/when the requirements grow.
 */

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
  /** Number of data rows successfully parsed (excludes header). */
  rowCount: number;
}

const CR = '\r'.charCodeAt(0);
const LF = '\n'.charCodeAt(0);
const QUOTE = '"'.charCodeAt(0);
const COMMA = ','.charCodeAt(0);

export function parseCsv(input: string): ParsedCsv {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);

    if (inQuotes) {
      if (c === QUOTE) {
        if (i + 1 < input.length && input.charCodeAt(i + 1) === QUOTE) {
          field += '"';
          i++; // consume the escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += input[i];
      }
      continue;
    }

    if (c === QUOTE) {
      inQuotes = true;
      continue;
    }
    if (c === COMMA) {
      row.push(field);
      field = '';
      continue;
    }
    if (c === CR) {
      // Treat CR as part of CRLF; LF will trigger row push.
      continue;
    }
    if (c === LF) {
      row.push(field);
      records.push(row);
      row = [];
      field = '';
      continue;
    }
    field += input[i];
  }

  // Flush the trailing field/row if the file doesn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }

  // Drop fully-blank trailing rows (single empty-string cell).
  while (records.length > 0) {
    const last = records[records.length - 1];
    if (last.length === 1 && last[0] === '') records.pop();
    else break;
  }

  if (records.length === 0) return { headers: [], rows: [], rowCount: 0 };

  const headers = records[0].map((h) => h.trim());
  const rows = records.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) obj[headers[i]] = cells[i] ?? '';
    return obj;
  });

  return { headers, rows, rowCount: rows.length };
}
