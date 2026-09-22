// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Pencil, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SectionCard } from '@/components/ui/SectionCard';
import { formatDateTime } from '@/lib/format';
import type { OrgIdpConfigDto, SsoTestReport } from '@/types';
import { SsoEnableToggle } from './SsoEnableToggle';
import { SsoRequiredToggle } from './SsoRequiredToggle';
import { SsoTestConnection } from './SsoTestConnection';
import { resumeStep, type WizardStep } from './SsoSetupWizard';

/** The one-line name of what the org is connected to. */
function connectionLabel(config: OrgIdpConfigDto): string {
  if (config.protocol === 'saml') return config.samlEntityId ?? 'SAML identity provider';
  return config.provider === 'cognito' ? 'AWS Cognito' : config.provider === 'google' ? 'Google' : (config.discoveryUrl ?? 'OpenID Connect provider');
}

/**
 * What an already-configured organization sees instead of the setup wizard: the
 * connection's state at a glance (protocol, IdP, enabled, SSO required, last
 * test, domains, SLO / signing / encryption for SAML) with the everyday
 * controls — Edit (reopens the wizard at the right step), Test connection, the
 * enable and "SSO required" switches. Group mappings, SCIM and Disconnect sit
 * below it on the page.
 */
export function SsoStatusSummary({
  orgId,
  config,
  readOnly,
  onSaved,
  onEdit,
}: {
  orgId: string;
  config: OrgIdpConfigDto;
  readOnly: boolean;
  onSaved: (config: OrgIdpConfigDto) => void;
  onEdit: (step: WizardStep) => void;
}) {
  const resume = resumeStep(config);
  const setupComplete = config.enabled && !!config.lastTest?.ok;

  const onReport = (report: SsoTestReport) => {
    if (report.recorded) {
      onSaved({ ...config, lastTest: { at: report.testedAt, ok: report.ok, protocol: report.protocol, ...(report.reason ? { reason: report.reason } : {}) } });
    }
  };

  return (
    <SectionCard
      icon={ShieldCheck}
      title="Single sign-on"
      description="Your organization's identity-provider connection."
      actions={(
        <div className="flex gap-2">
          {!setupComplete && (
            <Button size="sm" variant="secondary" readOnly={readOnly} onClick={() => onEdit(resume)}>Resume setup</Button>
          )}
          <Button size="sm" variant="outline" readOnly={readOnly} onClick={() => onEdit(3)}>
            <Pencil className="w-3.5 h-3.5 mr-1" />Edit
          </Button>
        </div>
      )}
    >
      <div className="space-y-5">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm" data-testid="sso-summary">
          <dt className="text-fg-muted">Protocol</dt>
          <dd>{config.protocol === 'saml' ? 'SAML 2.0' : 'OpenID Connect'}</dd>
          <dt className="text-fg-muted">Identity provider</dt>
          <dd className="font-mono text-xs break-all">{connectionLabel(config)}</dd>
          <dt className="text-fg-muted">Status</dt>
          <dd className="flex flex-wrap gap-2">
            <Badge color={config.enabled ? 'green' : 'gray'}>{config.enabled ? 'Enabled' : 'Disabled'}</Badge>
            <Badge color={config.ssoRequired ? 'indigo' : 'gray'}>{config.ssoRequired ? 'SSO required' : 'SSO optional'}</Badge>
          </dd>
          <dt className="text-fg-muted">Last test</dt>
          <dd>
            {config.lastTest
              ? (
                <span className={config.lastTest.ok ? 'text-success' : 'text-danger'}>
                  {config.lastTest.ok ? 'Succeeded' : `Failed (${config.lastTest.reason ?? 'error'})`} · {formatDateTime(config.lastTest.at)}
                </span>
              )
              : <em className="text-fg-muted">Not tested since the last change</em>}
          </dd>
          <dt className="text-fg-muted">Domains</dt>
          <dd className="flex items-center gap-2">
            <span>{config.allowedEmailDomains.length ? config.allowedEmailDomains.join(', ') : 'All verified domains'}</span>
            <Button size="xs" variant="link" readOnly={readOnly} onClick={() => onEdit(4)}>Change</Button>
          </dd>
          {config.protocol === 'saml' && (
            <>
              <dt className="text-fg-muted">Single logout</dt>
              <dd>{config.samlSloUrl ? 'On' : 'Off (no IdP logout URL)'}</dd>
              <dt className="text-fg-muted">Signed requests / encrypted assertions</dt>
              <dd>{config.samlSignAuthnRequests ? 'Signed' : 'Unsigned'} / {config.samlEncryptAssertions ? 'Encrypted' : 'Plaintext'}</dd>
            </>
          )}
        </dl>

        <SsoTestConnection orgId={orgId} readOnly={readOnly} onReport={onReport} />
        <SsoEnableToggle orgId={orgId} config={config} readOnly={readOnly} onSaved={onSaved} />
        <SsoRequiredToggle orgId={orgId} config={config} readOnly={readOnly} onSaved={onSaved} />
      </div>
    </SectionCard>
  );
}
