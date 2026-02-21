import { normalizePlugin, validateFilter, sendPluginNotFound } from '../src/helpers/plugin-helpers';

// ---------------------------------------------------------------------------
// Mock api-core
// ---------------------------------------------------------------------------
jest.mock('@mwashburn160/api-core', () => ({
  normalizeArrayFields: jest.fn(<T extends Record<string, unknown>>(record: T, fields: (keyof T)[]) => {
    const result = { ...record };
    for (const field of fields) {
      if (!Array.isArray(result[field])) {
        (result as Record<string, unknown>)[field as string] = [];
      }
    }
    return result;
  }),
  createOrderByResolver: jest.fn(() => jest.fn()),
  sendEntityNotFound: jest.fn((res: any, entity: string) => {
    res.status(404).json({ success: false, statusCode: 404, message: `${entity} not found.` });
    return res;
  }),
  validateQuery: jest.fn((_req: any, _schema: any) => ({ ok: true, value: {} })),
  PluginFilterSchema: {},
}));

jest.mock('@mwashburn160/pipeline-core', () => ({
  schema: {
    plugin: {
      id: 'id',
      name: 'name',
      version: 'version',
      createdAt: 'createdAt',
      updatedAt: 'updatedAt',
      isActive: 'isActive',
      isDefault: 'isDefault',
    },
  },
}));

jest.mock('drizzle-orm', () => ({
  asc: jest.fn(),
  desc: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('plugin-helpers', () => {
  describe('normalizePlugin', () => {
    it('should return the record with array fields ensured', () => {
      const record = { id: '1', name: 'test', keywords: null, installCommands: undefined, commands: 'echo hi' };
      const result = normalizePlugin(record as any);

      expect(Array.isArray(result.keywords)).toBe(true);
      expect(Array.isArray(result.installCommands)).toBe(true);
      expect(Array.isArray(result.commands)).toBe(true);
    });

    it('should preserve existing arrays', () => {
      const record = { id: '1', keywords: ['a', 'b'], installCommands: ['npm i'], commands: ['build'] };
      const result = normalizePlugin(record as any);

      expect(result.keywords).toEqual(['a', 'b']);
      expect(result.installCommands).toEqual(['npm i']);
      expect(result.commands).toEqual(['build']);
    });

    it('should not modify non-array fields', () => {
      const record = { id: '1', name: 'test-plugin', version: '1.0.0', keywords: [], installCommands: [], commands: [] };
      const result = normalizePlugin(record as any);

      expect(result.id).toBe('1');
      expect(result.name).toBe('test-plugin');
      expect(result.version).toBe('1.0.0');
    });
  });

  describe('validateFilter', () => {
    it('should call validateQuery with the request and PluginFilterSchema', () => {
      const { validateQuery } = jest.requireMock('@mwashburn160/api-core');
      const req = { query: { name: 'my-plugin' } } as any;

      validateFilter(req);

      expect(validateQuery).toHaveBeenCalledWith(req, expect.anything());
    });

    it('should return ok result for valid input', () => {
      const { validateQuery } = jest.requireMock('@mwashburn160/api-core');
      validateQuery.mockReturnValueOnce({ ok: true, value: { name: 'test' } });

      const result = validateFilter({ query: { name: 'test' } } as any);
      expect(result.ok).toBe(true);
    });

    it('should return error for invalid input', () => {
      const { validateQuery } = jest.requireMock('@mwashburn160/api-core');
      validateQuery.mockReturnValueOnce({ ok: false, error: 'Invalid filter' });

      const result = validateFilter({ query: {} } as any);
      expect(result.ok).toBe(false);
    });
  });

  describe('sendPluginNotFound', () => {
    it('should send 404 response with plugin entity name', () => {
      const { sendEntityNotFound } = jest.requireMock('@mwashburn160/api-core');
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any;

      sendPluginNotFound(res);

      expect(sendEntityNotFound).toHaveBeenCalledWith(res, 'Plugin');
    });
  });
});
