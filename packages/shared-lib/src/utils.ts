import { createHash } from 'crypto';

export function generateId(str: string): string {
  let b64 = Buffer.from(str, 'utf-8').toString('base64');
  let id = createHash('md5').update(b64).digest('hex');
  if (id.length > 12) id = id.substring(0, 11);
  return id;
}