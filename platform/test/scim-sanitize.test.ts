// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The SCIM router parses its own body (`application/scim+json`), AFTER the
 * app-wide `mongoSanitize()` has run — so it sanitizes it itself
 * (middleware/scim-sanitize.ts): operator and prototype keys go, dotted keys
 * stay (they are SCIM attribute paths in the path-less PATCH form IdPs send).
 */

import { jest, describe, it, expect } from '@jest/globals';

jest.unstable_mockModule('../src/utils/scim-response.js', () => ({
  sendScimError: (res: any, status: number, detail: string) => res.status(status).json({ detail }),
}));

const { scimSanitize } = await import('../src/middleware/scim-sanitize.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
function run(body: unknown) {
  const req: any = { body };
  const res: any = { status: jest.fn(() => res), json: jest.fn(() => res) };
  const next = jest.fn();
  scimSanitize(req, res, next);
  return { req, res, next };
}

describe('scimSanitize', () => {
  it('strips $-operator and prototype keys at every depth', () => {
    // Parsed the way express.json() parses it: `__proto__` is an OWN key here.
    const { req, next } = run(JSON.parse(
      '{"userName":{"$ne":null},"Operations":[{"op":"replace","value":{"$where":"sleep(1)","active":false,"constructor":{"prototype":{}}}}],"__proto__":{"polluted":true}}',
    ));
    expect(next).toHaveBeenCalled();
    expect(req.body.userName).toEqual({});
    expect(req.body.Operations[0].value).toEqual({ active: false });
    expect(Object.keys(req.body)).not.toContain('__proto__');
    expect(({} as any).polluted).toBeUndefined();
  });

  it('KEEPS dotted attribute-path keys — the path-less PATCH form depends on them', () => {
    const { req } = run({ Operations: [{ op: 'replace', value: { 'name.givenName': 'Ada', 'name.familyName': 'Lovelace' } }] });
    expect(req.body.Operations[0].value).toEqual({ 'name.givenName': 'Ada', 'name.familyName': 'Lovelace' });
  });

  it('refuses a pathologically nested body with a SCIM 400', () => {
    let deep: any = {};
    const root = deep;
    for (let i = 0; i < 40; i++) { deep.a = {}; deep = deep.a; }
    const { res, next } = run(root);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});
