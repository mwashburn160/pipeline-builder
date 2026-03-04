import { sendMessageNotFound, sendThreadNotFound } from '../src/helpers/message-helpers';

// Mock api-core
jest.mock('@mwashburn160/api-core', () => ({
  sendEntityNotFound: jest.fn(),
}));

// Tests

describe('message-helpers', () => {
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
