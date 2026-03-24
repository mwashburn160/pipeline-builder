import { validateEntityId, printCommandHeader, printSslWarning, printExecutionSummary } from '../src/utils/command-utils';

// Mock output-utils to capture console output
jest.mock('../src/utils/output-utils', () => ({
  printSection: jest.fn(),
  printKeyValue: jest.fn(),
  printInfo: jest.fn(),
  printSuccess: jest.fn(),
  printError: jest.fn(),
  printWarning: jest.fn(),
}));

jest.mock('../src/config/cli.constants', () => ({
  generateExecutionId: jest.fn(() => 'ABCD1234'),
  formatDuration: jest.fn((ms: number) => `${ms}ms`),
}));

const { printSection, printWarning, printKeyValue } = jest.requireMock('../src/utils/output-utils');

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
