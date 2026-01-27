import { AccessTokenPayload } from './jwt.type';

declare global {
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
    }
  }
}