/**
 * Tests for parseIntEnv logic used in postgres-connection.ts.
 *
 * parseIntEnv is module-private so we replicate the logic here
 * (same approach as metrics.test.ts for normalizeRoute).
 */

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

describe('parseIntEnv', () => {
  it('returns fallback when value is undefined', () => {
    expect(parseIntEnv(undefined, 5432)).toBe(5432);
  });

  it('returns fallback when value is empty string', () => {
    expect(parseIntEnv('', 20)).toBe(20);
  });

  it('parses valid integer strings', () => {
    expect(parseIntEnv('3000', 5432)).toBe(3000);
    expect(parseIntEnv('0', 5432)).toBe(0);
    expect(parseIntEnv('100', 20)).toBe(100);
  });

  it('returns fallback for non-numeric strings', () => {
    expect(parseIntEnv('abc', 5432)).toBe(5432);
    expect(parseIntEnv('not-a-number', 20)).toBe(20);
  });

  it('parses integers with trailing non-numeric chars', () => {
    // parseInt('50abc', 10) returns 50 — this is expected behavior
    expect(parseIntEnv('50abc', 20)).toBe(50);
  });

  it('returns fallback for NaN-producing values', () => {
    expect(parseIntEnv('NaN', 5432)).toBe(5432);
  });

  it('handles negative numbers', () => {
    expect(parseIntEnv('-1', 5432)).toBe(-1);
  });

  it('parses with radix 10 (no octal interpretation)', () => {
    // With radix 10, '010' should be 10 not 8
    expect(parseIntEnv('010', 0)).toBe(10);
  });
});
