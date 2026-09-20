// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS KMS-backed ES256 signer — the EC2 and EKS targets.
 *
 * The private key never exists outside KMS: the key is created as an asymmetric
 * `ECC_NIST_P256` key with usage `SIGN_VERIFY`, and platform holds only
 * permission to call `Sign` and `GetPublicKey` on it. A platform compromise
 * therefore cannot exfiltrate the signing key, only use it while the pod lives.
 *
 * Configure the key by ALIAS (`alias/pipeline-builder-token-signing`), not by
 * ARN: an alias carries no AWS account id, so no account id reaches config,
 * logs, the JWKS or a token. The published `kid` is the key's RFC 7638
 * thumbprint for the same reason.
 *
 * The public key is fetched ONCE at boot and cached, so verification (and the
 * JWKS route) never depends on KMS being reachable — only minting does.
 */

import crypto from 'crypto';
import { createLogger, derToJoseSignature, publicJwkFrom, USER_TOKEN_CURVE, errorMessage } from '@pipeline-builder/api-core';
import type { SigningKey } from './signer.js';

const logger = createLogger('token-signing-kms');

/** P-256 ECDSA over SHA-256 — the only algorithm ES256 permits. */
const KMS_SIGNING_ALGORITHM = 'ECDSA_SHA_256';

/** The KMS client surface this module uses — narrow, so the tests can stand one in. */
export interface KmsSigningClient {
  send(command: unknown): Promise<{ PublicKey?: Uint8Array; Signature?: Uint8Array; KeySpec?: string; KeyUsage?: string }>;
}

interface KmsCommands {
  GetPublicKeyCommand: new (input: { KeyId: string }) => unknown;
  SignCommand: new (input: { KeyId: string; Message: Uint8Array; MessageType: string; SigningAlgorithm: string }) => unknown;
}

let overrideClient: { client: KmsSigningClient; commands: KmsCommands } | undefined;

/**
 * Test seam: supply the KMS client + command constructors instead of
 * constructing the real SDK. Pass `undefined` to restore the real client.
 */
export function _setKmsClientForTests(override: { client: KmsSigningClient; commands: KmsCommands } | undefined): void {
  overrideClient = override;
}

/**
 * The KMS client, loaded LAZILY. A static import would drag the SDK into the
 * boot graph of every install, including the file-signer ones that never touch
 * KMS. The literal `.js` specifier is required by the CJS/ESM dual build.
 */
async function kms(): Promise<{ client: KmsSigningClient; commands: KmsCommands }> {
  if (overrideClient) return overrideClient;
  const sdk = await import('@aws-sdk/client-kms');
  const client = new sdk.KMSClient({
    ...(process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {}),
    ...(process.env.AWS_KMS_ENDPOINT ? { endpoint: process.env.AWS_KMS_ENDPOINT } : {}),
  }) as unknown as KmsSigningClient;
  return {
    client,
    commands: { GetPublicKeyCommand: sdk.GetPublicKeyCommand, SignCommand: sdk.SignCommand } as unknown as KmsCommands,
  };
}

/**
 * Resolve one KMS key into a {@link SigningKey}: fetch and validate the public
 * half now (so a mis-specified key fails at boot, not on the first sign-in), and
 * hand back a `sign` that converts KMS's DER signature into the raw `r || s`
 * form a JWS carries.
 *
 * `canSign: false` yields a verification-only key — a retiring `kid` that stays
 * published for one overlap window.
 */
export async function loadKmsSigningKey(keyId: string, opts: { canSign: boolean }): Promise<SigningKey> {
  const { client, commands } = await kms();

  let response: { PublicKey?: Uint8Array; KeySpec?: string; KeyUsage?: string };
  try {
    response = await client.send(new commands.GetPublicKeyCommand({ KeyId: keyId }));
  } catch (error) {
    throw new Error(`KMS GetPublicKey failed for the token signing key: ${errorMessage(error)}`);
  }
  if (!response.PublicKey) throw new Error('KMS GetPublicKey returned no public key for the token signing key');
  if (response.KeySpec && response.KeySpec !== 'ECC_NIST_P256') {
    throw new Error(`Token signing key must be ECC_NIST_P256 (got ${response.KeySpec})`);
  }
  if (response.KeyUsage && response.KeyUsage !== 'SIGN_VERIFY') {
    throw new Error(`Token signing key must have KeyUsage SIGN_VERIFY (got ${response.KeyUsage})`);
  }

  // KMS returns DER (SubjectPublicKeyInfo); Node reads that directly.
  const publicKey = crypto.createPublicKey({ key: Buffer.from(response.PublicKey), format: 'der', type: 'spki' });
  // Throws unless the curve really is P-256 — a second guard for endpoints
  // (LocalStack, older KMS API shapes) that omit `KeySpec`.
  const { kid } = publicJwkFrom(publicKey);
  logger.info('Loaded KMS token signing key', { kid, canSign: opts.canSign, curve: USER_TOKEN_CURVE });

  return {
    kid,
    publicKey,
    ...(opts.canSign
      ? {
        sign: async (input: Buffer): Promise<Buffer> => {
          const signed = await client.send(new commands.SignCommand({
            KeyId: keyId,
            // RAW: KMS hashes the message itself. The alternative (DIGEST) would
            // mean hashing here and sending the digest, which buys nothing and
            // adds a way for the two sides to disagree.
            Message: input,
            MessageType: 'RAW',
            SigningAlgorithm: KMS_SIGNING_ALGORITHM,
          }));
          if (!signed.Signature) throw new Error('KMS Sign returned no signature');
          return derToJoseSignature(Buffer.from(signed.Signature));
        },
      }
      : {}),
  };
}
