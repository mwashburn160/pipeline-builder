// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Rotation drill for the image-registry token SIGNING key
 * (docs/runbooks/secret-rotation.md).
 *
 * Unlike the shared HMAC secrets, this keypair's overlap window lives in the
 * TRUST BUNDLE: `REGISTRY_TOKEN_CERTIFICATE` is mounted both here (for the
 * `x5c` header) and into the registry as `REGISTRY_AUTH_TOKEN_ROOTCERTBUNDLE`.
 * A rotation therefore runs with a two-cert bundle (new first, outgoing second)
 * so tokens minted under EITHER key keep verifying until the outgoing ones
 * expire (`REGISTRY_TOKEN_EXPIRES_IN`, 300s by default).
 *
 * `registryVerify` below is the check Docker Distribution v3 performs: take the
 * JWT's `x5c` leaf, require it to be one of the certs in the root bundle, and
 * verify the signature with that cert's public key. So the assertions prove the
 * real acceptance behaviour, not just our own bookkeeping.
 */

import { X509Certificate } from 'crypto';
import { jest, describe, it, expect } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { apiCoreMock } from './helpers/mock-api-core.js';

const OLD_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC/uvorjR4hVMJv
0MxdyyGAj8woPBqga+8pYMRt/k693LuUZujtl32SPSQVVRYjzOGgvn5gF5lMoYkh
WMiSpkqgnQXS4ylnyfNxJLNsQFhyae2+lzh1fvrORCLo5ahIxRaEe53ZDlFzmWk8
jUxn6hB/Uj4AxryyOyfJBIXSgGcBiTYEy7qbPOtIRltu06V8gFq9AwzeTHQ8TtLL
/rlsw6WvdEqBui4FtA7sgt6AyetWEp/HU8u85U9apML4dZm4c0ljUa8BtP3ZxnPt
Ph/vJn2RXGk2OZoeZCN4o79etxSMPxYVZz/amJBnEWUfdCn6ZfZUjrSkGvDHq0q5
NNMmahQ9AgMBAAECggEACc8eLUa6Z9BPOfXCfY+e0+s8xxfbcTbRxPnsAB2ejS+j
EtKuBY52e0TGA70MlYHN+abtTmtpVCaVM7Uis9VZTud3Ag+i/BSfWrvwMwWwELsd
0Z5TzOJqy00976Y6P8OCOqkcDbFiFj+JxweKmmwQR9dJup6a+Ppg93OUCM2OwjZa
be6YimPqS29OddqLP2bhAoGykLcW2hmHzDcXC7rHyG7nR37/qIWJwY3PqLFkOmwB
tcU1YBjjQCC9fr2YbJdXKWJQoktB7BKRQY+mGBh5JMHKoFS7hc43hzN96CcZVlEG
vFYlnqlcwqzA981Mbk48yU1OwCERPZsOfzdv/EbNSQKBgQDqj3P3m3X4hNk12EZ/
+1WUDjk1Zb0cOKJoRU4BbZtIu3BoRMk2piEzfXj6LM4gGGScqIvA4hagdLiiSe+h
LauMcnkSpHhmA8AaH3E4dTGFDQx0b9dDTKu9UCto39bYV5nBdvIV18C3E91T77tV
6aojwFv153gqQNAfDJfUJ4NAKQKBgQDRQVU0vqcaG8n/iKRwTSFae4CsJEz5/6LH
OTVih1f+IkN34B1o/tWJCYL00DQYrPAKLKBXXGgUGCsvP0qdN8j8IuPSAwknZwX5
y33eXZSy5GfTK8Og3u+vD5WXYH50iLTZ8gbj+SkeRh1Iz3+zIX/CP9khQq9IGD0G
tkh460Hl9QKBgAW5+trQsNCgba0i2pXFTRGQR1VGZpeJym1BQ+ZFBsV/zf69ryvm
YmkfZxS0g1PFRK+ObdsHqgXA08EijPciZk3Hfa021rmm3cnFer4mHk9hQiyVjmvW
M1sr2eN1k4k0mkxe2wotekb99SlXcPtn+P9mcthODmD5tBsN86b6T/oBAoGAS8s4
S6SK7kAGiJI7zZmCbT2yu6diYmMf2L12Arw3OQu8GF2LCY7UVZCmaHpJhG6Pe3/y
i/IimLSwX6qzIgMkv377ugPzetwsI/B7JOIMjEeC+9AsSca2Vlh0vKHs69TgfNjX
eheztw16afcOsBmAJyHtScjXqGtvH1FDKtk7w0kCgYBixxwzrvcnvv1iC36CqFL8
ClLvJeLqs7H+vc2ggYAAnhg9LkJ3GX0Ocuybxt9dM4AlBhn1IVZ6kwcLLjAPezl5
un92mzJiPgBVKAPVWbZZ4UarqXn8ATLRAxNOT6sM+oTaVjUcXgxB+Soth+RPUIge
YJnkbFG6JS+bq8O5+N3VSQ==
-----END PRIVATE KEY-----
`;
const OLD_CERT = `-----BEGIN CERTIFICATE-----
MIIDLzCCAhegAwIBAgIUIoW3p/W0frI6Fsx94GJw3O1kiGowDQYJKoZIhvcNAQEL
BQAwJzElMCMGA1UEAwwccGlwZWxpbmUtaW1hZ2UtcmVnaXN0cnktdGVzdDAeFw0y
NjA2MTIxNDIyMjNaFw0zNjA2MDkxNDIyMjNaMCcxJTAjBgNVBAMMHHBpcGVsaW5l
LWltYWdlLXJlZ2lzdHJ5LXRlc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK
AoIBAQC/uvorjR4hVMJv0MxdyyGAj8woPBqga+8pYMRt/k693LuUZujtl32SPSQV
VRYjzOGgvn5gF5lMoYkhWMiSpkqgnQXS4ylnyfNxJLNsQFhyae2+lzh1fvrORCLo
5ahIxRaEe53ZDlFzmWk8jUxn6hB/Uj4AxryyOyfJBIXSgGcBiTYEy7qbPOtIRltu
06V8gFq9AwzeTHQ8TtLL/rlsw6WvdEqBui4FtA7sgt6AyetWEp/HU8u85U9apML4
dZm4c0ljUa8BtP3ZxnPtPh/vJn2RXGk2OZoeZCN4o79etxSMPxYVZz/amJBnEWUf
dCn6ZfZUjrSkGvDHq0q5NNMmahQ9AgMBAAGjUzBRMB0GA1UdDgQWBBQyqTJclUMN
9e7SbSxlIM4izd8lWDAfBgNVHSMEGDAWgBQyqTJclUMN9e7SbSxlIM4izd8lWDAP
BgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQCFkqUk/0ztTKSwN38z
1WdcMKCGUTi1TlBqPKiFhWIdFA5GreAI8AS3B3DRgFaDpnH/mc17iYmJB4LcJJ6r
qQm20VpipNm6y5d6Tcy+DvmP8s+1n8SYbG/Z2XAml4uOLh1WX7OVj/JoP/34NUPu
ANzOxfLl1430qwBcpcXqdF/BVmJn9Z4ekq/Z/CjcBf1EBVGKSHRpp6bbHKgUUH5E
klG0KIX9XwOCxWkdutHR/uKzXoquWBO1dQ02W6Q9x+hKHmi/V0wtDlATi5MHdosx
rzOZmOFBeXYrkwSUTtzfL8JfllcmQ3g3sY/lSk9yazPaqKpBTYspjB07/iMXbWdN
7mYv
-----END CERTIFICATE-----
`;
const NEW_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQCWk3Su/evcmI6f
fErPGZJb7NZQ7g0l7Da8ZFMuWmLwp8egMufbB7oKOqnHQtq9kRee1CPim+DQ0cwm
MOiUN+hZDiARDy7C5NX8ghz/h+WuinmFWqJHU4jFSKep0fPMAyP9y7svpzqFSYq1
6nJj/QbERiDSX4tyX39y/uUiEf4ll4gKEMWH6SIoTyDmVj+Aduhc29s8YecTMcjC
iV506ROGnEg5MI9BXwABWw58XKGTijvyToaT281REHa7fhByQYVfMyBNnLbrFlcQ
TvL/3PjpRnbl2ClVVb+TPvf3j2034cHR056YnQ33s6rOzJDYygB04N8yB3SQW+Bc
shOx1MCxAgMBAAECggEACEaeeSe3mO5BmH5qViufobHIrbYHvvfWolAZSkjpezSd
gi6KE72++eTzg+Imx5h75dzfBAtxNcjyIX86qTrRaGOgW4+sEEYnhLNaCKlddFRk
DXJHzQfIUp+Fp43Eiof5qG9UIHBehQjfuNPj6Z70ikEYeLeLoIOjK5za1x6KC2LN
HDbTqblHJQQza1SaAhhm3LiAznccf/az0jvDKDqSDW8xTsghze1TBdGJEkBFi1cE
73V4EnD+FXhBsOnGBmv07Bg+r3eN/o3v9ch4UbJQc7nximOAbs/WJEX4jERzlQND
+jjw/6fnStOGkPmzrNHmv8WNYR5iG9TFm2PjuNYtCQKBgQDMDfqsqKw98h/oatWV
BkWI9NPX7fgi9XrbO4htXBtXw15yIU5s9B2gYvoXtUL+Spg+tvt+DzEiAdY71Fad
7BV/3ElhQEpwjXaZFct7Z/n+D/zoBdEI4VbytYAcBrZA8t3OTt2P055n48bR78x2
n58zTzep52SRF4jBDr7XaGuk3wKBgQC86FU3rZAgLNl6L5i8MhjbIiRVQQ65zivI
7hZOfFLCcWuyIgPsJBiCyfohk/mrjo4vX9OQad4612BiVev2/Nzk9Pidqzm47OjE
ZRclkJeiJgQ+imIupShhZeko0sj6sx3AO/dkcH9c9t6tDixDRAAL/2csASpDi6rL
JOgRu/w8bwKBgQC+ppD/oNjNR9voG2lSw3lUbOtBZGXiw9j13Lmq89PYPAGSQOw1
gB/uKovgessNLETy06RGM4uEapLvc4U6J8ounHMzGg5y+rlEbsiflJZOekGhx013
LpM+UbZQeTTvmfsDN0xrhR0LlBW/MH2ol5r3JZyscjXUGlj7h/tm53kroQKBgQCn
JR75o71paqWGggSvR9hMU/o34Ndpua1uHJNqIICNgROcSpKT5yA04QdLnIWFsR3H
dw9XsQSrpZOnjoS5ReUhREuSHkV1hVEzLIr9duFj3CVXPNRAl2uSOjzCHTcs8zz4
sVZk7VET7W77ShYJ8mnkM7iS6/j8SOD225Hm1yEISwKBgQCKfmcmdh4uHFdawjSF
PpJeOC1rrsg1WIfpzubqY0SNVqexdAy+dIPi+2ZJV0vzEKcP/PaWSEG+RpnSNwZg
u8oRY7mzLFI20X69+tydLy0a+7sOjpmnMGWfc9Wvjugbt9Nhp0GHupnhMx/IHrxW
9eXH8sf01sNHKXXEGt0fsHAE4A==
-----END PRIVATE KEY-----
`;
const NEW_CERT = `-----BEGIN CERTIFICATE-----
MIIDQTCCAimgAwIBAgIUTnzT8yg3RWZ4YJfjUtfbqF17h8AwDQYJKoZIhvcNAQEL
BQAwMDEuMCwGA1UEAwwlcGlwZWxpbmUtaW1hZ2UtcmVnaXN0cnktcm90YXRpb24t
dGVzdDAeFw0yNjA5MTcxODEwMjZaFw0zNjA5MTQxODEwMjZaMDAxLjAsBgNVBAMM
JXBpcGVsaW5lLWltYWdlLXJlZ2lzdHJ5LXJvdGF0aW9uLXRlc3QwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQCWk3Su/evcmI6ffErPGZJb7NZQ7g0l7Da8
ZFMuWmLwp8egMufbB7oKOqnHQtq9kRee1CPim+DQ0cwmMOiUN+hZDiARDy7C5NX8
ghz/h+WuinmFWqJHU4jFSKep0fPMAyP9y7svpzqFSYq16nJj/QbERiDSX4tyX39y
/uUiEf4ll4gKEMWH6SIoTyDmVj+Aduhc29s8YecTMcjCiV506ROGnEg5MI9BXwAB
Ww58XKGTijvyToaT281REHa7fhByQYVfMyBNnLbrFlcQTvL/3PjpRnbl2ClVVb+T
Pvf3j2034cHR056YnQ33s6rOzJDYygB04N8yB3SQW+BcshOx1MCxAgMBAAGjUzBR
MB0GA1UdDgQWBBSq4coYnoVUGzcwNAW8NFM8yX68yjAfBgNVHSMEGDAWgBSq4coY
noVUGzcwNAW8NFM8yX68yjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQCS7srx5Wh3gPppIczZqqKXHTzNQvBjy6ogEae37+gnbeL9MC6mxPvICsRl
8BgoRz9zs3WEZJOeGKewANwUUtexrjiiVUJw3rYV2KDcsModz3pmINo626UaYoGV
giGkJ2rESSXV6DkA+fVc6aJdJ+eJ62MrOWdiZKpHbh72AMiWwj4voq0Ynv8TAK/r
7iv+WuWmr8jhxCceS9evfJ4a1kYpE4pqfC9S5PhNf9ZRYq4vyqO+n8lyUApCCl2F
9MDJw+H9qTnCJDEQxAgRXKSPodjzV9yiOFxHR5HL9bG+TdN9Na7skRHcswJy0ycP
ttFVVnP0u9NjATseisdMepkYXeTh
-----END CERTIFICATE-----
`;

process.env.IMAGE_REGISTRY_HOST = 'localhost';
process.env.REGISTRY_TOKEN_ISSUER = 'test-platform';
process.env.REGISTRY_TOKEN_SERVICE = 'test-registry';
process.env.JWT_SECRET = 'test-jwt-secret';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createQuotaService: () => ({
    check: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ limit: -1 }),
  }),
  getServiceAuthHeader: jest.fn<(...args: unknown[]) => string>().mockReturnValue('Bearer test'),
}));

/** Load token-service with a given key + cert bundle (both modules re-read env). */
async function loadTokenService(privateKey: string, bundle: string) {
  process.env.REGISTRY_TOKEN_PRIVATE_KEY = privateKey;
  process.env.REGISTRY_TOKEN_CERTIFICATE = bundle;
  jest.resetModules();
  return import('../src/services/token-service.js');
}

const certsIn = (bundle: string) =>
  (bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map((p) => new X509Certificate(p));

/** What the registry does: x5c leaf must be in the root bundle AND verify the signature. */
function registryVerify(token: string, rootBundle: string): void {
  const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()) as { x5c: string[] };
  const leaf = new X509Certificate(Buffer.from(header.x5c[0], 'base64'));
  if (!certsIn(rootBundle).some((c) => c.raw.equals(leaf.raw))) {
    throw new Error('x5c leaf is not in the registry root bundle');
  }
  jwt.verify(token, leaf.publicKey.export({ format: 'pem', type: 'spki' }).toString(), { algorithms: ['RS256'] });
}

const mint = async (svc: { authorizeAndIssue: Function }) => (await (svc.authorizeAndIssue as (
  i: unknown, s: unknown[], a: string,
) => Promise<{ token: string }>)(
  { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false, isSuperAdmin: false, canWritePlugins: true },
  [{ type: 'repository', name: 'org-acme/app', actions: ['pull'] }],
  'u1',
)).token;

describe('registry token signing-key rotation', () => {
  it('a token minted under the OLD key verifies during the overlap and is REJECTED once the bundle is trimmed', async () => {
    // — steady state on the old key.
    const oldToken = await mint(await loadTokenService(OLD_KEY, OLD_CERT));
    expect(() => registryVerify(oldToken, OLD_CERT)).not.toThrow();

    // — overlap: new key signing, bundle trusts BOTH certs.
    const overlapBundle = `${NEW_CERT}${OLD_CERT}`;
    const svc = await loadTokenService(NEW_KEY, overlapBundle);
    const newToken = await mint(svc);
    // Old tokens (still within their 300s TTL) and new ones both pass.
    expect(() => registryVerify(oldToken, overlapBundle)).not.toThrow();
    expect(() => registryVerify(newToken, overlapBundle)).not.toThrow();
    // The leaf the registry chains is the NEW cert, not the outgoing one.
    const leaf = JSON.parse(Buffer.from(newToken.split('.')[0], 'base64url').toString()) as { x5c: string[] };
    expect(new X509Certificate(Buffer.from(leaf.x5c[0], 'base64')).raw.equals(certsIn(NEW_CERT)[0].raw)).toBe(true);

    // — rotation finished: bundle trimmed to the new cert only.
    expect(() => registryVerify(newToken, NEW_CERT)).not.toThrow();
    expect(() => registryVerify(oldToken, NEW_CERT)).toThrow(/not in the registry root bundle/);
  });

  it('reports the rotation window through the secret_rotation_previous_set probe', async () => {
    const { previousSecretStates } = await import('@pipeline-builder/api-core');
    const state = () => (previousSecretStates() as Array<{ secret: string; previousSet: boolean }>)
      .find((s) => s.secret === 'REGISTRY_TOKEN_CERTIFICATE');

    await loadTokenService(NEW_KEY, `${NEW_CERT}${OLD_CERT}`);
    expect(state()?.previousSet).toBe(true);

    await loadTokenService(NEW_KEY, NEW_CERT);
    expect(state()?.previousSet).toBe(false);
  });

  it('refuses to start when the private key does not match the FIRST cert in the bundle', async () => {
    // The classic rotation misstep: new key, bundle still listing the outgoing
    // cert first. Every minted token would be unverifiable.
    await expect(loadTokenService(NEW_KEY, `${OLD_CERT}${NEW_CERT}`))
      .rejects.toThrow(/does not match the FIRST certificate/);
  });
});
