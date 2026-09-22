// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, type ReactNode } from 'react';
import { KeyRound } from 'lucide-react';
import { SectionCard } from '@/components/ui/SectionCard';
import { Callout } from '@/components/ui/Callout';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Select } from '@/components/ui/Select';
import { FormField } from '@/components/ui/FormField';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SuccessAlert } from '@/components/ui/SuccessAlert';
import { ReadOnlyNotice } from '@/components/ui/ReadOnlyNotice';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { SamlMetadataImport } from '@/components/sso/SamlMetadataImport';
import { SpValues } from '@/components/sso/SpValues';
import { useFormState } from '@/hooks/useFormState';
import api from '@/lib/api';
import type { IdpProtocol, OrgIdpConfigCreate, OrgIdpConfigDto, ParsedIdpMetadata, SamlAttributeMapping } from '@/types';
import { changedIdpFields } from './idp-diff';

/**
 * Split the certificate textarea into certificates.
 *
 * PEM blocks are kept whole (their own internal newlines are meaningful);
 * anything that isn't a PEM block is treated as one bare-base64 certificate per
 * blank-line-separated chunk, which is how IdP consoles that hand out raw base64
 * present them.
 */
function parseCertificates(text: string): string[] {
  const pemBlocks = text.match(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g);
  if (pemBlocks && pemBlocks.length > 0) return pemBlocks.map((b) => b.trim());
  return text.split(/\n\s*\n/).map((c) => c.replace(/\s+/g, '')).filter(Boolean);
}

/**
 * SAML 2.0 connection editor. Used in two places:
 *
 *   - as a CARD (the team settings drawer), where it also owns the PROTOCOL
 *     SELECTOR: an org federates over OIDC or over SAML, never both. The OIDC
 *     card keeps its own fields — switching protocols does not erase them;
 *   - inside the SSO SETUP WIZARD (`wizard` prop) as step 3, where the wizard
 *     has already chosen SAML: saving selects SAML, and a brand-new connection
 *     is created DISABLED until it has been tested.
 *
 * Two halves, in the order an administrator works through them:
 *
 *   1. WHAT TO GIVE THE IDENTITY PROVIDER — entity ID, ACS, SLO and metadata
 *      URLs (+ the SP certificates), read from the SERVER (`sp-info`) with copy
 *      buttons — never derived from the browser's origin.
 *   2. WHAT THE IDENTITY PROVIDER GIVES BACK — IMPORTED from its metadata (URL,
 *      paste or upload) or typed: entity ID, SSO URL, SLO URL, signing
 *      certificate(s), attribute names; plus the two per-org switches, "sign
 *      AuthnRequests" and "IdP encrypts assertions".
 *
 * CERTIFICATES ARE A LIST, and that is the whole rotation story: during a
 * rotation both the outgoing and the incoming certificate are trusted, so
 * assertions signed by either verify and nobody is locked out mid-cutover. The
 * change is in the audit log as `sso.saml.certificate.rotate`. See
 * docs/runbooks/secret-rotation.md.
 *
 * Gated on `org:idp` plus a strong step-up (the same gate the OIDC connection
 * uses) and on the `sso` entitlement — all enforced server-side. CREATES with
 * `PUT` when the org has no connection yet and otherwise `PATCH`es only the
 * fields that changed.
 */
export function OrgSamlSettings({
  orgId,
  config,
  readOnly,
  onSaved,
  wizard,
}: {
  orgId: string;
  /** The org's stored config, or null when none exists yet. */
  config: OrgIdpConfigDto | null;
  readOnly: boolean;
  /** Fired with the saved config so the page sees the new protocol without a reload. */
  onSaved: (config: OrgIdpConfigDto) => void;
  /** Render as the setup wizard's details step (see above). */
  wizard?: { presetAttributes?: SamlAttributeMapping; submitLabel?: string };
}) {
  const form = useFormState();
  const [protocol, setProtocol] = useState<IdpProtocol>('oidc');
  const [entityId, setEntityId] = useState('');
  const [ssoUrl, setSsoUrl] = useState('');
  const [sloUrl, setSloUrl] = useState('');
  // One textarea, certificates separated by blank lines / PEM boundaries. A
  // repeating sub-form would be more "correct" and much worse to use: people
  // paste these straight out of an IdP console.
  const [certsText, setCertsText] = useState('');
  const [emailAttr, setEmailAttr] = useState('');
  const [nameAttr, setNameAttr] = useState('');
  const [groupsAttr, setGroupsAttr] = useState('');
  const [signRequests, setSignRequests] = useState(false);
  const [encryptAssertions, setEncryptAssertions] = useState(false);
  // The validated write, held while the step-up dialog is open.
  const [pendingWrite, setPendingWrite] = useState<((stepUpToken: string) => ReturnType<typeof api.putOwnOrgIdpConfig>) | null>(null);

  // Mirror the stored config whenever the page (re)loads it — including back to
  // the empty form after a disconnect. In the wizard an unset attribute starts
  // from the chosen provider's preset. Keyed on VALUES (not the `wizard` object,
  // which a parent may rebuild every render and would wipe the admin's typing).
  const inWizard = !!wizard;
  const presetEmail = wizard?.presetAttributes?.email;
  const presetName = wizard?.presetAttributes?.name;
  const presetGroups = wizard?.presetAttributes?.groups;
  useEffect(() => {
    setProtocol(inWizard ? 'saml' : (config?.protocol ?? 'oidc'));
    setEntityId(config?.samlEntityId ?? '');
    setSsoUrl(config?.samlSsoUrl ?? '');
    setSloUrl(config?.samlSloUrl ?? '');
    setCertsText((config?.samlCertificates ?? []).join('\n\n'));
    setEmailAttr(config?.samlAttributes?.email ?? presetEmail ?? '');
    setNameAttr(config?.samlAttributes?.name ?? presetName ?? '');
    setGroupsAttr(config?.samlAttributes?.groups ?? presetGroups ?? '');
    setSignRequests(config?.samlSignAuthnRequests ?? false);
    setEncryptAssertions(config?.samlEncryptAssertions ?? false);
  }, [config, inWizard, presetEmail, presetName, presetGroups]);

  const certificates = parseCertificates(certsText);
  const samlSelected = protocol === 'saml';

  /** Pre-fill from imported IdP metadata; the admin reviews and saves. */
  const applyMetadata = (m: ParsedIdpMetadata) => {
    setEntityId(m.entityId);
    setSsoUrl(m.ssoUrl);
    setSloUrl(m.sloUrl ?? '');
    setCertsText(m.certificates.join('\n\n'));
    if (m.wantsSignedRequests) setSignRequests(true);
  };

  const handleSave = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (readOnly) return;

    if (samlSelected) {
      if (!entityId.trim()) { form.setError('The identity provider entity ID is required'); return; }
      if (!ssoUrl.trim()) { form.setError('The identity provider SSO URL is required'); return; }
      if (!ssoUrl.trim().startsWith('https://')) { form.setError('The SSO URL must use https'); return; }
      if (sloUrl.trim() && !sloUrl.trim().startsWith('https://')) { form.setError('The single-logout URL must use https'); return; }
      if (certificates.length === 0) { form.setError('At least one signing certificate is required'); return; }
      if (certificates.length > 3) { form.setError('At most three certificates can be trusted at once'); return; }
    }

    // Send the protocol together with the SAML fields. The server preserves the
    // OIDC fields it isn't given, so saving here never disturbs the OIDC card —
    // and switching back to OIDC finds it intact.
    const desired: Partial<OrgIdpConfigCreate> = {
      protocol,
      ...(samlSelected || certificates.length > 0
        ? {
          samlEntityId: entityId.trim(),
          samlSsoUrl: ssoUrl.trim(),
          samlSloUrl: sloUrl.trim(),
          samlCertificates: certificates,
          samlAttributes: {
            email: emailAttr.trim(),
            name: nameAttr.trim(),
            groups: groupsAttr.trim(),
          },
          samlSignAuthnRequests: signRequests,
          samlEncryptAssertions: encryptAssertions,
        }
        : {}),
      // A connection created by the wizard starts disabled until it is tested.
      ...(wizard && !config ? { enabled: false } : {}),
    };

    form.reset();
    if (config) {
      const patch = changedIdpFields(config, desired);
      if (Object.keys(patch).length === 0) {
        form.setSuccess('No changes to save.');
        if (wizard) onSaved(config);
        return;
      }
      setPendingWrite(() => (token: string) => api.patchOwnOrgIdpConfig(orgId, patch, token));
    } else {
      setPendingWrite(() => (token: string) => api.putOwnOrgIdpConfig(orgId, desired, token));
    }
  };

  const executeWrite = async (stepUpToken: string) => {
    const write = pendingWrite;
    setPendingWrite(null);
    if (!write) return;
    const res = await form.run(() => write(stepUpToken), { successMessage: 'SAML configuration saved.' });
    const saved = res?.data?.config;
    if (saved) onSaved(saved);
  };

  const body = (
    <>
      <form onSubmit={handleSave} className="space-y-4">
        <ReadOnlyNotice show={readOnly} />
        <ErrorAlert message={form.error} />
        <SuccessAlert message={form.success} />

        <fieldset disabled={readOnly} className="space-y-4">
          {!wizard && (
            <FormField
              label="Protocol"
              id="idp-protocol"
              hint="Which protocol this organization signs in over. Switching keeps the other protocol's settings, so you can move back without re-entering them."
            >
              <Select
                id="idp-protocol"
                value={protocol}
                onChange={(e) => setProtocol(e.target.value as IdpProtocol)}
                disabled={form.loading}
              >
                <option value="oidc">OpenID Connect (OIDC)</option>
                <option value="saml">SAML 2.0</option>
              </Select>
            </FormField>
          )}

          {!samlSelected && (
            <Callout variant="neutral">
              This organization signs in over OIDC. The SAML settings below are kept but not used;
              choose <strong>SAML 2.0</strong> above and save to switch.
            </Callout>
          )}

          <SpValues orgId={orgId} protocol="saml" />

          <SamlMetadataImport orgId={orgId} disabled={readOnly} onImported={applyMetadata} />

          <FormField label="Identity provider entity ID" id="saml-entity-id" required={samlSelected}>
            <Input
              id="saml-entity-id"
              type="text"
              value={entityId}
              onChange={(e) => setEntityId(e.target.value)}
              placeholder="https://idp.example.com/saml/metadata"
              className="font-mono text-sm"
              disabled={form.loading}
            />
          </FormField>

          <FormField
            label="Identity provider SSO URL"
            id="saml-sso-url"
            required={samlSelected}
            hint="The HTTP-Redirect single sign-on endpoint we send authentication requests to. Must use https."
          >
            <Input
              id="saml-sso-url"
              type="url"
              value={ssoUrl}
              onChange={(e) => setSsoUrl(e.target.value)}
              placeholder="https://idp.example.com/sso/saml"
              className="font-mono text-sm"
              disabled={form.loading}
            />
          </FormField>

          <FormField
            label="Identity provider single-logout URL"
            id="saml-slo-url"
            hint="Optional (HTTP-Redirect binding). When set, signing out of Pipeline Builder also signs the person out of the identity provider, and the provider can sign people out of Pipeline Builder."
          >
            <Input
              id="saml-slo-url"
              type="url"
              value={sloUrl}
              onChange={(e) => setSloUrl(e.target.value)}
              placeholder="https://idp.example.com/slo/saml"
              className="font-mono text-sm"
              disabled={form.loading}
            />
          </FormField>

          <FormField
            label="Signing certificate(s)"
            id="saml-certificates"
            required={samlSelected}
            hint={`Paste the identity provider's signing certificate (PEM or base64). To rotate, paste BOTH the new and the old certificate — assertions signed by either are accepted while both are listed — then remove the old one once the provider has cut over. ${certificates.length} certificate${certificates.length === 1 ? '' : 's'} detected; up to 3 allowed.`}
          >
            <Textarea
              id="saml-certificates"
              rows={6}
              value={certsText}
              onChange={(e) => setCertsText(e.target.value)}
              placeholder={'-----BEGIN CERTIFICATE-----\nMIID…\n-----END CERTIFICATE-----'}
              className="font-mono text-xs"
              disabled={form.loading}
            />
          </FormField>

          {certificates.length > 1 && (
            <Callout variant="warning" title="A certificate rotation window is open.">
              More than one signing certificate is trusted, so assertions signed by the old
              certificate are still accepted. Remove the retired certificate once your identity
              provider has finished cutting over.
            </Callout>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label="Email attribute" id="saml-attr-email" hint="Leave empty to try the common names.">
              <Input
                id="saml-attr-email"
                type="text"
                value={emailAttr}
                onChange={(e) => setEmailAttr(e.target.value)}
                placeholder="email"
                className="font-mono text-xs"
                disabled={form.loading}
              />
            </FormField>
            <FormField label="Name attribute" id="saml-attr-name" hint="Optional display name.">
              <Input
                id="saml-attr-name"
                type="text"
                value={nameAttr}
                onChange={(e) => setNameAttr(e.target.value)}
                placeholder="displayName"
                className="font-mono text-xs"
                disabled={form.loading}
              />
            </FormField>
            <FormField label="Groups attribute" id="saml-attr-groups" hint="Drives group-to-role mapping.">
              <Input
                id="saml-attr-groups"
                type="text"
                value={groupsAttr}
                onChange={(e) => setGroupsAttr(e.target.value)}
                placeholder="groups"
                className="font-mono text-xs"
                disabled={form.loading}
              />
            </FormField>
          </div>

          <div className="space-y-2">
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={signRequests} onChange={(e) => setSignRequests(e.target.checked)} disabled={form.loading} className="mt-0.5" />
              <span>
                Sign AuthnRequests
                <span className="block text-xs text-fg-muted">
                  Sign each authentication request with this deployment&apos;s SP signing key (its certificate is in the SP
                  metadata). Turn on when the identity provider requires signed requests. Logout messages are always signed.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={encryptAssertions} onChange={(e) => setEncryptAssertions(e.target.checked)} disabled={form.loading} className="mt-0.5" />
              <span>
                Identity provider encrypts assertions
                <span className="block text-xs text-fg-muted">
                  The provider encrypts each assertion to the SP encryption certificate. When on, a plaintext assertion is
                  refused; when off, an encrypted one is. Re-import the SP metadata at the provider after changing this.
                </span>
              </span>
            </label>
          </div>

          <Button type="submit" loading={form.loading}>
            {wizard?.submitLabel ?? 'Save SAML settings'}
          </Button>
        </fieldset>
      </form>

      {pendingWrite && (
        <StepUpModal
          action="Change your organization's SAML connection"
          requireStrongFactor
          onConfirmed={executeWrite}
          onClose={() => setPendingWrite(null)}
        />
      )}
    </>
  );

  return wizard ? body : <SamlCard>{body}</SamlCard>;
}

function SamlCard({ children }: { children: ReactNode }) {
  return (
    <SectionCard
      icon={KeyRound}
      title="SAML 2.0"
      description="Federate with a SAML identity provider. Sign-in must start here — responses that begin at the identity provider are refused."
    >
      {children}
    </SectionCard>
  );
}
