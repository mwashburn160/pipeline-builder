import { sendError, sendSuccess, sendUnauthorized, sendForbidden, sendNotFound } from '../src/utils/response';

function createMockRes() {
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
}

describe('response utilities', () => {
  describe('sendError', () => {
    it('should send error response with status and message', () => {
      const res = createMockRes();
      sendError(res, 400, 'Bad request');

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        statusCode: 400,
        message: 'Bad request',
      });
    });

    it('should include error code when provided', () => {
      const res = createMockRes();
      sendError(res, 422, 'Validation failed', 'VALIDATION_ERROR');

      expect(res.json).toHaveBeenCalledWith({
        success: false,
        statusCode: 422,
        message: 'Validation failed',
        code: 'VALIDATION_ERROR',
      });
    });

    it('should not include code key when code is undefined', () => {
      const res = createMockRes();
      sendError(res, 500, 'Internal error');

      const body = res.json.mock.calls[0][0];
      expect(body).not.toHaveProperty('code');
    });
  });

  describe('sendUnauthorized', () => {
    it('should send 401 with default message', () => {
      const res = createMockRes();
      sendUnauthorized(res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 401, message: 'Unauthorized' }),
      );
    });

    it('should send 401 with custom message', () => {
      const res = createMockRes();
      sendUnauthorized(res, 'Token expired');

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Token expired' }),
      );
    });

    it('should include error code when provided', () => {
      const res = createMockRes();
      sendUnauthorized(res, 'Invalid token', 'TOKEN_INVALID');

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'TOKEN_INVALID' }),
      );
    });
  });

  describe('sendForbidden', () => {
    it('should send 403 with default message', () => {
      const res = createMockRes();
      sendForbidden(res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 403, message: 'Forbidden' }),
      );
    });

    it('should send 403 with custom message', () => {
      const res = createMockRes();
      sendForbidden(res, 'Admin only');

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Admin only' }),
      );
    });
  });

  describe('sendNotFound', () => {
    it('should send 404 with default message', () => {
      const res = createMockRes();
      sendNotFound(res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 404, message: 'Not found' }),
      );
    });

    it('should send 404 with custom message', () => {
      const res = createMockRes();
      sendNotFound(res, 'User not found');

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'User not found' }),
      );
    });
  });

  describe('sendSuccess', () => {
    it('should send success response with default status 200', () => {
      const res = createMockRes();
      sendSuccess(res, { id: '1' });

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        statusCode: 200,
        data: { id: '1' },
      });
    });

    it('should include message when provided', () => {
      const res = createMockRes();
      sendSuccess(res, { id: '1' }, 'Created');

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Created', data: { id: '1' } }),
      );
    });

    it('should use custom status code', () => {
      const res = createMockRes();
      sendSuccess(res, { id: '1' }, 'Created', 201);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 201 }),
      );
    });

    it('should omit data when undefined', () => {
      const res = createMockRes();
      sendSuccess(res);

      const body = res.json.mock.calls[0][0];
      expect(body).not.toHaveProperty('data');
      expect(body).not.toHaveProperty('message');
    });

    it('should omit message when undefined', () => {
      const res = createMockRes();
      sendSuccess(res, { value: 42 });

      const body = res.json.mock.calls[0][0];
      expect(body).not.toHaveProperty('message');
      expect(body.data).toEqual({ value: 42 });
    });
  });
});
