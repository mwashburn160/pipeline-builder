// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock output-utils to capture console output
const printSection = jest.fn();
const printKeyValue = jest.fn();
const printInfo = jest.fn();
const printSuccess = jest.fn();
const printError = jest.fn();
const printWarning = jest.fn();

jest.unstable_mockModule('../src/utils/output-utils.js', () => ({
  __esModule: true,
  printSection,
  printKeyValue,
  printInfo,
  printSuccess,
  printError,
  printWarning,
  printDebug: jest.fn(),
  printDivider: jest.fn(),
  outputData: jest.fn(),
  formatTable: jest.fn(),
  ensureOutputDirectory: jest.fn(),
  fileExists: jest.fn(),
  unwrapEnvelope: jest.fn(),
  extractSingleResponse: jest.fn(),
  extractListResponse: jest.fn(),
}));

jest.unstable_mockModule('../src/config/cli.constants.js', () => ({
  __esModule: true,
  generateExecutionId: jest.fn(() => 'ABCD1234'),
  formatDuration: jest.fn((ms: number) => `${ms}ms`),
  // Real value needed by the api-client transitively imported via command-utils.
  TIMEOUTS: { HTTP_REQUEST: 30000, CDK_COMMAND: 0, HEALTH_CHECK: 5000, UPLOAD: 300000 },
}));

const { validateEntityId, printCommandHeader, printSslWarning, printExecutionSummary } =
  await import('../src/utils/command-utils.js');

describe('printCommandHeader', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should return an execution ID', () => {
    const id = printCommandHeader('Test Command');
    expect(id).toBe('ABCD1234');
  });

  it('should call printSection with title', () => {
    printCommandHeader('Deploy');
    expect(printSection).toHaveBeenCalledWith('Deploy');
  });
});

describe('printSslWarning', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should warn when verifySsl is false', () => {
    printSslWarning(false);
    expect(printWarning).toHaveBeenCalledWith('SSL certificate verification is DISABLED');
  });

  it('should not warn when verifySsl is true', () => {
    printSslWarning(true);
    expect(printWarning).not.toHaveBeenCalled();
  });

  it('should not warn when verifySsl is undefined', () => {
    printSslWarning(undefined);
    expect(printWarning).not.toHaveBeenCalled();
  });
});

describe('printExecutionSummary', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should print key-value with execution ID and duration', () => {
    printExecutionSummary('ABCD1234', 1500);
    expect(printKeyValue).toHaveBeenCalledWith(
      expect.objectContaining({
        'Execution ID': 'ABCD1234',
      }),
    );
  });
});

describe('validateEntityId', () => {
  it('should return trimmed ID for valid ULID (26 chars)', () => {
    const id = '01HQJG5V5Z0000000000000000';
    expect(validateEntityId(id, 'Pipeline')).toBe(id);
  });

  it('should return trimmed ID for valid UUID (36 chars)', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    expect(validateEntityId(id, 'Pipeline')).toBe(id);
  });

  it('should trim whitespace', () => {
    const id = '  01HQJG5V5Z0000000000000000  ';
    expect(validateEntityId(id, 'Pipeline')).toBe(id.trim());
  });

  it('should throw for empty string', () => {
    expect(() => validateEntityId('', 'Pipeline')).toThrow('Pipeline ID must be a non-empty string');
  });

  it('should throw for undefined', () => {
    expect(() => validateEntityId(undefined, 'Plugin')).toThrow('Plugin ID must be a non-empty string');
  });

  it('should warn for non-standard length but not throw', () => {
    const id = 'short-id';
    const result = validateEntityId(id, 'Pipeline');
    expect(result).toBe(id);
    expect(printWarning).toHaveBeenCalledWith(
      'Pipeline ID format may be invalid',
      expect.objectContaining({ actualLength: 8 }),
    );
  });
});
