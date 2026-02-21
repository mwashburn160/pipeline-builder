import { extractListResponse } from '../src/utils/output.utils';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractListResponse', () => {
  it('should extract items using primary key', () => {
    const response = { pipelines: [{ id: '1' }, { id: '2' }], total: 2, hasMore: false };
    const result = extractListResponse(response, 'pipelines');

    expect(result.items).toEqual([{ id: '1' }, { id: '2' }]);
    expect(result.total).toBe(2);
    expect(result.hasMore).toBe(false);
  });

  it('should extract items using "items" key as fallback', () => {
    const response = { items: [{ id: '1' }], total: 1, hasMore: true };
    const result = extractListResponse(response, 'pipelines');

    expect(result.items).toEqual([{ id: '1' }]);
    expect(result.total).toBe(1);
    expect(result.hasMore).toBe(true);
  });

  it('should handle plain array response', () => {
    const response = [{ id: '1' }, { id: '2' }, { id: '3' }];
    const result = extractListResponse(response, 'pipelines');

    expect(result.items).toEqual(response);
    expect(result.total).toBeUndefined();
    expect(result.hasMore).toBe(false);
  });

  it('should return empty items for unexpected object format', () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    const response = { unexpected: 'data' };
    const result = extractListResponse(response, 'pipelines');

    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(false);

    consoleSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('should throw for non-object, non-array response', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const logSpy = jest.spyOn(console, 'log').mockImplementation();

    expect(() => extractListResponse('invalid', 'pipelines')).toThrow(
      'Unexpected API response format',
    );

    consoleSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('should throw for null response', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const logSpy = jest.spyOn(console, 'log').mockImplementation();

    expect(() => extractListResponse(null, 'plugins')).toThrow(
      'Unexpected API response format',
    );

    consoleSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('should handle hasMore from response object', () => {
    const response = { plugins: [{ id: '1' }], hasMore: true };
    const result = extractListResponse(response, 'plugins');
    expect(result.hasMore).toBe(true);
  });

  it('should default hasMore to false when not present', () => {
    const response = { plugins: [{ id: '1' }] };
    const result = extractListResponse(response, 'plugins');
    expect(result.hasMore).toBe(false);
  });
});
