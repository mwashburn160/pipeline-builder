import { Request } from 'express';

export interface AuthenticatedRequest extends Request {
  id?: string;
}

export const getOrgId = (req: AuthenticatedRequest): string | undefined => {
  const orgId = req.headers['x-org-id'];
  if (typeof orgId === 'string') {
    return orgId;
  }

  return undefined;
};