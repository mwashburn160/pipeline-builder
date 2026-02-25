import { validateFilter, sendMessageNotFound, sendThreadNotFound } from '../src/helpers/message-helpers';

// ---------------------------------------------------------------------------
// Mock api-core
// ---------------------------------------------------------------------------
jest.mock('@mwashburn160/api-core', () => ({
  sendEntityNotFound: jest.fn((res: any, entity: string) => {
    res.status(404).json({ success: false, statusCode: 404, message: `${entity} not found.` });
    return res;
  }),
  validateQuery: jest.fn((_req: any, _schema: any) => ({ ok: true, value: {} })),
  MessageFilterSchema: {},
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('message-helpers', () => {
  describe('validateFilter', () => {
    it('should call validateQuery with the request and MessageFilterSchema', () => {
      const { validateQuery } = jest.requireMock('@mwashburn160/api-core');
      const req = { query: { messageType: 'announcement' } } as any;

      validateFilter(req);

      expect(validateQuery).toHaveBeenCalledWith(req, expect.anything());
    });

    it('should return ok result for valid input', () => {
      const { validateQuery } = jest.requireMock('@mwashburn160/api-core');
      validateQuery.mockReturnValueOnce({ ok: true, value: { messageType: 'conversation' } });

      const result = validateFilter({ query: { messageType: 'conversation' } } as any);
      expect(result.ok).toBe(true);
    });

    it('should return error for invalid input', () => {
      const { validateQuery } = jest.requireMock('@mwashburn160/api-core');
      validateQuery.mockReturnValueOnce({ ok: false, error: 'Invalid filter parameter' });

      const result = validateFilter({ query: {} } as any);
      expect(result.ok).toBe(false);
    });
  });

  describe('sendMessageNotFound', () => {
    it('should send 404 with Message entity name', () => {
      const { sendEntityNotFound } = jest.requireMock('@mwashburn160/api-core');
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any;

      sendMessageNotFound(res);

      expect(sendEntityNotFound).toHaveBeenCalledWith(res, 'Message');
    });
  });

  describe('sendThreadNotFound', () => {
    it('should send 404 with Thread entity name', () => {
      const { sendEntityNotFound } = jest.requireMock('@mwashburn160/api-core');
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any;

      sendThreadNotFound(res);

      expect(sendEntityNotFound).toHaveBeenCalledWith(res, 'Thread');
    });
  });
});
