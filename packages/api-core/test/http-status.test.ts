import { HttpStatus } from '../src/constants/http-status';

describe('HttpStatus', () => {
  it('should have correct 2xx success codes', () => {
    expect(HttpStatus.OK).toBe(200);
    expect(HttpStatus.CREATED).toBe(201);
    expect(HttpStatus.ACCEPTED).toBe(202);
    expect(HttpStatus.NO_CONTENT).toBe(204);
  });

  it('should have correct 4xx client error codes', () => {
    expect(HttpStatus.BAD_REQUEST).toBe(400);
    expect(HttpStatus.UNAUTHORIZED).toBe(401);
    expect(HttpStatus.FORBIDDEN).toBe(403);
    expect(HttpStatus.NOT_FOUND).toBe(404);
    expect(HttpStatus.CONFLICT).toBe(409);
    expect(HttpStatus.UNPROCESSABLE_ENTITY).toBe(422);
    expect(HttpStatus.TOO_MANY_REQUESTS).toBe(429);
  });

  it('should have correct 5xx server error codes', () => {
    expect(HttpStatus.INTERNAL_SERVER_ERROR).toBe(500);
    expect(HttpStatus.BAD_GATEWAY).toBe(502);
    expect(HttpStatus.SERVICE_UNAVAILABLE).toBe(503);
    expect(HttpStatus.GATEWAY_TIMEOUT).toBe(504);
  });
});
