// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { SectionCard } from '@/components/ui/SectionCard';
import { Callout } from '@/components/ui/Callout';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Select } from '@/components/ui/Select';
import { FormField } from '@/components/ui/FormField';
import { ReadonlyField } from '@/components/ui/ReadonlyField';
import { CopyButton } from '@/components/ui/CopyButton';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SuccessAlert } from '@/components/ui/SuccessAlert';
import { ReadOnlyNotice } from '@/components/ui/ReadOnlyNotice';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { useFormState } from '@/hooks/useFormState';
import api from '@/lib/api';
import type { IdpProtocol, OrgIdpConfigCreate, OrgIdpConfigDto } from '@/types';
import { changedIdpFields } from './idp-diff';

/**
 * SAML 2.0 connection editor (#4), on the org SSO settings page.
 *
 * Owns the PROTOCOL SELECTOR for the whole page: an org federates over OIDC or
 * over SAML, never both, and this is where that choice is made. The OIDC
 * connection form above keeps its own fields — switching protocols does not
 * erase them, so an org can move back without re-entering a connection.
 *
 * Two halves, in the order an administrator actually works through them:
 *
 *   1. WHAT TO GIVE THE IDENTITY PROVIDER — the SP entity ID, the ACS URL and
 *      the metadata URL. These are derived from the org id and this
 *      deployment's URL, so they are shown BEFORE anything is saved: you need
 *      them to create the application on the IdP side in the first place.
 *   2. WHAT THE IDENTITY PROVIDER GIVES BACK — its entity ID, its SSO URL, its
 *      signing certificate(s), and which assertion attributes carry email, name
 *      and groups.
 *
 * CERTIFICATES ARE A LIST, and that is the whole rotation story: during a
 * rotation both the outgoing and the incoming certificate are trusted, so
 * assertions signed by either verify and nobody is locked out mid-cutover. The
 * old one is removed once the IdP has cut over — until it is, the overlap window
 * is open and the change is in the audit log as `sso.saml.certificate.rotate`.
 * The full procedure is in docs/runbooks/secret-rotation.md.
 *
 * Gated on `org:idp` plus a step-up confirmation (the same gate the OIDC
 * connection uses) and on the `sso` entitlement — all enforced server-side.
 * Like the OIDC editor, it CREATES with `PUT` when the org has no connection yet
 * and otherwise `PATCH`es only the fields that changed.
 * Single Logout is out of scope for this release: signing out of Pipeline
 * Builder does not sign the person out of their identity provider.
 */
export function OrgSamlSettings({
  orgId,
  config,
  readOnly,
  onSaved,
}: {
  orgId: string;
  /** The org's stored config, or null when none exists yet. Supplied by the
   *  page, which loads it once for both editors. */
  config: OrgIdpConfigDto | null;
  readOnly: boolean;
  /** Fired with the saved config so the page (and the group-mapping editor
   *  below it) sees the new protocol without a reload. */
  onSaved: (config: OrgIdpConfigDto) => void;
}) {
  const form = useFormState();
  const [protocol, setProtocol] = useState<IdpProtocol>('oidc');
  const [entityId, setEntityId] = useState('');
  const [ssoUrl, setSsoUrl] = useState('');
  // One textarea, certificates separated by blank lines / PEM boundaries. A
  // repeating sub-form would be more "correct" and much worse to use: people
  // paste these straight out of an IdP console.
  const [certsText, setCertsText] = useState('');
  const [emailAttr, setEmailAttr] = useState('');
  const [nameAttr, setNameAttr] = useState('');
  const [groupsAttr, setGroupsAttr] = useState('');
  // The validated write, held while the step-up dialog is open.
  const [pendingWrite, setPendingWrite] = useState<((stepUpToken: string) => ReturnType<typeof api.putOwnOrgIdpConfig>) | null>(null);

  // Mirror the stored config whenever the page (re)loads it — including back to
  // the empty form after a disconnect.
  useEffect(() => {
    setProtocol(config?.protocol ?? 'oidc');
    setEntityId(config?.samlEntityId ?? '');
    setSsoUrl(config?.samlSsoUrl ?? '');
    setCertsText((config?.samlCertificates ?? []).join('\n\n'));
    setEmailAttr(config?.samlAttributes?.email ?? '');
    setNameAttr(config?.samlAttributes?.name ?? '');
    setGroupsAttr(config?.samlAttributes?.groups ?? '');
  }, [config]);

  // The SP values are derived server-side; before the first save there is no
  // config to read them from, so fall back to deriving the same shape here from
  // the page's own origin. Same values, so an admin is never blocked from
  // configuring their IdP first.
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const sp = config?.samlSp ?? {
    entityId: `${origin}/api/auth/sso/${orgId}/saml/metadata`,
    acsUrl: `${origin}/api/auth/sso/${orgId}/saml/acs`,
    metadataUrl: `${origin}/api/auth/sso/${orgId}/saml/metadata`,
  };

  /**
   * Split the textarea into certificates.
   *
   * PEM blocks are kept whole (their own internal newlines are meaningful);
   * anything that isn't a PEM block is treated as one bare-base64 certificate
   * per blank-line-separated chunk, which is how IdP consoles that hand out raw
   * base64 present them.
   */
  const parseCertificates = (text: string): string[] => {
    const pemBlocks = text.match(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g);
    if (pemBlocks && pemBlocks.length > 0) return pemBlocks.map((b) => b.trim());
    return text.split(/\n\s*\n/).map((c) => c.replace(/\s+/g, '')).filter(Boolean);
  };

  const certificates = parseCertificates(certsText);
  const samlSelected = protocol === 'saml';

  const handleSave = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (readOnly) return;

    if (samlSelected) {
      if (!entityId.trim()) { form.setError('The identity provider entity ID is required'); return; }
      if (!ssoUrl.trim()) { form.setError('The identity provider SSO URL is required'); return; }
      if (!ssoUrl.trim().startsWith('https://')) { form.setError('The SSO URL must use https'); return; }
      if (certificates.length === 0) { form.setError('At least one signing certificate is required'); return; }
      if (certificates.length > 3) { form.setError('At most three certificates can be trusted at once'); return; }
    }

    // Send the protocol together with the SAML fields. The server preserves the
    // OIDC fields it isn't given, so saving here never disturbs the connection
    // form above — and switching back to OIDC finds it intact.
    const desired: Partial<OrgIdpConfigCreate> = {
      protocol,
      ...(samlSelected || certificates.length > 0
        ? {
          samlEntityId: entityId.trim(),
          samlSsoUrl: ssoUrl.trim(),
          samlCertificates: certificates,
          samlAttributes: {
            email: emailAttr.trim(),
            name: nameAttr.trim(),
            groups: groupsAttr.trim(),
          },
        }
        : {}),
    };

    form.reset();
    if (config) {
      const patch = changedIdpFields(config, desired);
      if (Object.keys(patch).length === 0) { form.setSuccess('No changes to save.'); return; }
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

  return (
    <SectionCard
      icon={KeyRound}
      title="SAML 2.0"
      description="Federate with a SAML identity provider. Sign-in must start here — responses that begin at the identity provider are refused."
    >
      <form onSubmit={handleSave} className="space-y-4">
        <ReadOnlyNotice show={readOnly} />
        <ErrorAlert message={form.error} />
        <SuccessAlert message={form.success} />

        <fieldset disabled={readOnly} className="space-y-4">
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

          {!samlSelected && (
            <Callout variant="neutral">
              This organization signs in over OIDC. The SAML settings below are kept but not used;
              choose <strong>SAML 2.0</strong> above and save to switch.
            </Callout>
          )}

          <div className="rounded-lg bg-gray-50 dark:bg-gray-800/50 p-3 space-y-3">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Give these to your identity provider
            </p>
            <div className="flex items-start gap-2">
              <ReadonlyField
                label="Service provider entity ID"
                value={sp.entityId}
                className="flex-1 min-w-0"
                valueClassName="font-mono text-xs break-all"
              />
              <div className="pt-5"><CopyButton text={sp.entityId} /></div>
            </div>
            <div className="flex items-start gap-2">
              <ReadonlyField
                label="Assertion Consumer Service (ACS) URL"
                value={sp.acsUrl}
                className="flex-1 min-w-0"
                valueClassName="font-mono text-xs break-all"
              />
              <div className="pt-5"><CopyButton text={sp.acsUrl} /></div>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Most identity providers can import everything at once from the metadata document at{' '}
              <a href={sp.metadataUrl} className="underline font-mono break-all" target="_blank" rel="noreferrer">
                {sp.metadataUrl}
              </a>
              . Bind the ACS to <strong>HTTP-POST</strong>. Sign both the response and the assertion —
              an unsigned assertion is refused. We do not sign authentication requests, so no
              certificate is needed from us.
            </p>
          </div>

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
            label="Signing certificate(s)"
            id="saml-certificates"
            required={samlSelected}
            hint={`Paste the identity provider's signing certificate (PEM or base64). To rotate, paste BOTH the new and the old certificate — assertions signed by either are accepted while both are listed — then remove the old one once the provider has cut over. ${certificates.length} certificate${certificates.length === 1 ? '' : 's'} detected; up to 3 allowed.`}
          >
            <Textarea
              id="saml-certificates"
              rows={8}
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
            <FormField label="Groups attribute" id="saml-attr-groups" hint="Drives group-to-role mapping below.">
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

          <p className="text-xs text-gray-500 dark:text-gray-400">
            Single logout is not supported in this release: signing out of Pipeline Builder ends this
            session only, and does not sign the person out of your identity provider.
          </p>

          <Button type="submit" loading={form.loading}>
            Save SAML settings
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
    </SectionCard>
  );
}
