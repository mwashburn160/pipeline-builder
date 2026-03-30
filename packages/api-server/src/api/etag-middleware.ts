import { createHash } from 'crypto';
import { Request, Response, NextFunction } from 'express';

/**
 * Middleware that adds ETag support for conditional GET requests.
 * Generates a weak ETag from the response body hash.
 * Returns 304 Not Modified when the client's If-None-Match header matches.
 */
export function etagMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    // Only apply to GET requests
    if (req.method !== 'GET') return next();

    res.json = (body: unknown) => {
      // Serialize once, hash, and send — avoids double JSON.stringify
      const serialized = JSON.stringify(body);
      const hash = createHash('md5').update(serialized).digest('hex').slice(0, 16);
      const etag = `W/"${hash}"`;

      res.setHeader('ETag', etag);

      // Check If-None-Match header
      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch && ifNoneMatch === etag) {
        res.status(304).end();
        return res;
      }

      // Send pre-serialized body to avoid double JSON.stringify
      res.setHeader('Content-Type', 'application/json');
      res.end(serialized);
      return res;
    };

    next();
  };
}
