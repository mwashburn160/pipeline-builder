// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * This deployment's SAML service-provider key material (services/saml-sp-keys.ts).
 *
 * ONE document per purpose, DEPLOYMENT-wide (not per org): the SP key is this
 * installation's identity towards every identity provider, exactly as the token
 * signing key is its identity towards every relying service.
 *
 *   `signing`     — RSA key + self-signed certificate that signs AuthnRequests
 *                   (when an org opts in) and every LogoutRequest/Response.
 *   `encryption`  — RSA key + certificate an IdP encrypts assertions to.
 *   `test-marker` — HMAC key that signs the dry-run ("test connection") marker
 *                   carried in the SSO `state` / `RelayState`. No certificate.
 *
 * The private half is stored ONLY as an EncryptedBlob under
 * SECRET_ENCRYPTION_KEY (utils/secret-blob.ts); the certificate is public by
 * design and stored in clear. Generated on first use; the `_id` is the purpose,
 * so two replicas racing to generate collide on the primary key and the loser
 * re-reads the winner's document.
 */

import { Schema, model, Document } from 'mongoose';

export type SamlSpKeyPurpose = 'signing' | 'encryption' | 'test-marker';

export interface SamlSpKeyDocument extends Omit<Document, '_id'> {
  _id: SamlSpKeyPurpose;
  /** JSON EncryptedBlob of the PEM private key (or the HMAC secret). */
  privateKeyEncrypted: string;
  /** PEM X.509 certificate — absent for the HMAC `test-marker` key. */
  certificate?: string;
  createdAt: Date;
  updatedAt: Date;
}

const samlSpKeySchema = new Schema<SamlSpKeyDocument>(
  {
    _id: { type: String, required: true },
    privateKeyEncrypted: { type: String, required: true },
    certificate: { type: String },
  },
  { timestamps: true, collection: 'saml_sp_keys' },
);

export default model<SamlSpKeyDocument>('SamlSpKey', samlSpKeySchema);
