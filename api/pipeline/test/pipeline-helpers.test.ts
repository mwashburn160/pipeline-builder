import { normalizePipeline, validateFilter, sendPipelineNotFound } from '../src/helpers/pipeline-helpers';

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
  PipelineFilterSchema: {},
}));

jest.mock('@mwashburn160/pipeline-core', () => ({
  schema: {
    pipeline: {
      id: 'id',
      project: 'project',
      organization: 'organization',
      pipelineName: 'pipelineName',
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

describe('pipeline-helpers', () => {
  describe('normalizePipeline', () => {
    it('should ensure keywords is always an array', () => {
      const record = { id: '1', project: 'proj', keywords: null };
      const result = normalizePipeline(record as any);

      expect(Array.isArray(result.keywords)).toBe(true);
    });

    it('should preserve existing keyword arrays', () => {
      const record = { id: '1', keywords: ['ci', 'cd'] };
      const result = normalizePipeline(record as any);

      expect(result.keywords).toEqual(['ci', 'cd']);
    });

    it('should not modify non-array fields', () => {
      const record = { id: 'uuid-1', project: 'my-project', organization: 'my-org', keywords: [] };
      const result = normalizePipeline(record as any);

      expect(result.id).toBe('uuid-1');
      expect(result.project).toBe('my-project');
      expect(result.organization).toBe('my-org');
    });
  });

  describe('validateFilter', () => {
    it('should call validateQuery with the request and PipelineFilterSchema', () => {
      const { validateQuery } = jest.requireMock('@mwashburn160/api-core');
      const req = { query: { project: 'my-project' } } as any;

      validateFilter(req);

      expect(validateQuery).toHaveBeenCalledWith(req, expect.anything());
    });

    it('should return ok result for valid input', () => {
      const { validateQuery } = jest.requireMock('@mwashburn160/api-core');
      validateQuery.mockReturnValueOnce({ ok: true, value: { project: 'test' } });

      const result = validateFilter({ query: { project: 'test' } } as any);
      expect(result.ok).toBe(true);
    });

    it('should return error for invalid input', () => {
      const { validateQuery } = jest.requireMock('@mwashburn160/api-core');
      validateQuery.mockReturnValueOnce({ ok: false, error: 'Invalid filter parameter' });

      const result = validateFilter({ query: {} } as any);
      expect(result.ok).toBe(false);
    });
  });

  describe('sendPipelineNotFound', () => {
    it('should send 404 with Pipeline entity name', () => {
      const { sendEntityNotFound } = jest.requireMock('@mwashburn160/api-core');
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any;

      sendPipelineNotFound(res);

      expect(sendEntityNotFound).toHaveBeenCalledWith(res, 'Pipeline');
    });
  });
});
