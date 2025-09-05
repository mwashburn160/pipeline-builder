import { createHash } from 'crypto';

export class UniqueId {
  private _length: number;
  private _prefix: string;

  constructor(organization: string, project: string, length: number = 12) {
    this._length = length;
    this._prefix = organization.concat(`-${project}`);
  }

  generate(str: string, length: number = this._length): string {
    let encoded = Buffer.from(this._prefix.concat(`-${str}`), 'utf-8').toString('base64');
    let id = createHash('md5').update(encoded).digest('hex');
    if (id.length > length) id = id.substring(0, length);
    return id.substring(0, length).toUpperCase();
  }
}