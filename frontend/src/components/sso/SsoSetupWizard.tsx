// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Check, ChevronLeft, ChevronRight, KeyRound, ShieldCheck } from 'lucide-react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { OrgSamlSettings } from '@/components/settings/OrgSamlSettings';
import { OrgSsoSettings } from '@/components/settings/OrgSsoSettings';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SectionCard } from '@/components/ui/SectionCard';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { IdpProtocol, OrgIdpConfigDto, SsoTestReport } from '@/types';
import { findPreset, presetsFor, type SsoProviderPreset } from './providers';
import { SpValues } from './SpValues';
import { SsoEnableToggle } from './SsoEnableToggle';
import { SsoRequiredToggle } from './SsoRequiredToggle';
import { SsoTestConnection } from './SsoTestConnection';
import { DOMAIN_SETTINGS_HREF, useVerifiedDomains, VerifiedDomainPicker } from './VerifiedDomainPicker';

/** The six steps, in order. */
export const WIZARD_STEPS = [
  'Protocol & provider',
  'Service-provider values',
  'Identity-provider details',
  'Domains',
  'Test connection',
  'Enable',
] as const;

export type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;

/** Where "Resume setup" lands for a stored config: the first unfinished step. */
export function resumeStep(config: OrgIdpConfigDto): WizardStep {
  if (!config.lastTest?.ok || config.lastTest.protocol !== config.protocol) return 5;
  return 6;
}

/** Best preset guess for a stored config (so editing keeps the right hints). */
function presetForConfig(config: OrgIdpConfigDto | null, protocol: IdpProtocol): SsoProviderPreset {
  const options = presetsFor(protocol);
  if (protocol === 'oidc' && config?.provider) {
    const byProvider = options.find((p) => p.oidcProvider === config.provider && p.id !== 'okta-oidc' && p.id !== 'entra-oidc');
    if (byProvider) return byProvider;
  }
  return options[options.length - 1];
}

/**
 * The SSO SETUP WIZARD — six short steps:
 *
 *   1. pick the protocol (OIDC / SAML) and a provider preset;
 *   2. copy this deployment's SP values (from the server) into the IdP;
 *   3. enter the IdP's details — or, for SAML, import its metadata — and save
 *      (a new connection is created DISABLED);
 *   4. pick which VERIFIED domains it serves (with a link to verify one);
 *   5. run a TEST CONNECTION — a dry run that creates nothing;
 *   6. enable it, and optionally require SSO (unlocked by a passing test).
 *
 * Every write goes through the same strong step-up the IdP routes demand. The
 * page reopens the wizard at a given step to edit an existing connection.
 */
export function SsoSetupWizard({
  orgId,
  config,
  readOnly,
  initialStep = 1,
  onSaved,
  onDone,
}: {
  orgId: string;
  config: OrgIdpConfigDto | null;
  readOnly: boolean;
  initialStep?: WizardStep;
  onSaved: (config: OrgIdpConfigDto) => void;
  /** Leave the wizard (back to the status summary). Absent while nothing is saved yet. */
  onDone?: () => void;
}) {
  const [step, setStep] = useState<WizardStep>(initialStep);
  const [protocol, setProtocol] = useState<IdpProtocol>(config?.protocol ?? 'oidc');
  const [presetId, setPresetId] = useState<string>(presetForConfig(config, config?.protocol ?? 'oidc').id);
  const preset = findPreset(presetId) ?? presetForConfig(config, protocol);

  // Switching protocol picks that protocol's generic preset.
  const chooseProtocol = (p: IdpProtocol) => {
    setProtocol(p);
    setPresetId(presetForConfig(p === config?.protocol ? config : null, p).id);
  };

  const canVisit = (target: WizardStep): boolean => target <= 3 || !!config;
  const next = () => setStep((s) => (Math.min(6, s + 1) as WizardStep));
  const back = () => setStep((s) => (Math.max(1, s - 1) as WizardStep));

  // Steps 3 and 4 own their own submit button, so the wizard renders no "Next"
  // for them; whatever was focused (the Next button, or a control in the step
  // that just unmounted) is gone and focus falls back to <body>, stranding a
  // keyboard user at the top of the document. Moving focus to the new step's
  // heading puts them at the start of the step instead — and, because the
  // heading sits in a live region, a screen reader hears which step it is.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mountedStepRef = useRef(step);
  useEffect(() => {
    // Not on first render: opening the wizard must not steal focus from
    // whatever the person clicked to get here.
    if (mountedStepRef.current === step) return;
    mountedStepRef.current = step;
    headingRef.current?.focus();
  }, [step]);

  return (
    <div role="region" aria-label="Single sign-on setup">
    <SectionCard
      icon={ShieldCheck}
      title={config ? 'Edit single sign-on' : 'Set up single sign-on'}
      description="Connect your identity provider in six short steps. Nothing changes for your members until you enable it."
      actions={onDone ? <Button variant="ghost" size="sm" onClick={onDone}>Close</Button> : undefined}
    >
      <ol className="mb-5 flex flex-wrap gap-2" aria-label="Setup steps">
        {WIZARD_STEPS.map((label, i) => {
          const n = (i + 1) as WizardStep;
          const current = n === step;
          const done = n < step;
          return (
            <li key={label}>
              <button
                type="button"
                onClick={() => canVisit(n) && setStep(n)}
                disabled={!canVisit(n)}
                aria-current={current ? 'step' : undefined}
                className={[
                  'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs border',
                  current ? 'border-brand bg-brand text-white' : 'border-default',
                  !canVisit(n) ? 'opacity-50 cursor-not-allowed' : '',
                ].join(' ')}
              >
                {done ? <Check className="w-3 h-3" /> : <span>{n}</span>}
                {label}
              </button>
            </li>
          );
        })}
      </ol>

      {/* Always mounted (an aria-live region added together with its text is
          not announced) and always filled, so every step change is read out. */}
      <div role="status" aria-live="polite" className="mb-4">
        <h3 ref={headingRef} tabIndex={-1} className="h3 outline-none">
          Step {step} of {WIZARD_STEPS.length}: {WIZARD_STEPS[step - 1]}
        </h3>
      </div>

      {step === 1 && (
        <StepProtocol
          protocol={protocol}
          presetId={preset.id}
          config={config}
          onProtocol={chooseProtocol}
          onPreset={setPresetId}
        />
      )}

      {step === 2 && (
        <div className="space-y-3">
          <Callout variant="neutral" title={`${preset.label} (${protocol === 'saml' ? 'SAML 2.0' : 'OpenID Connect'})`}>
            {preset.hint}
          </Callout>
          <SpValues orgId={orgId} protocol={protocol} />
        </div>
      )}

      {step === 3 && (
        protocol === 'saml' ? (
          <OrgSamlSettings
            orgId={orgId}
            config={config}
            readOnly={readOnly}
            wizard={{ presetAttributes: preset.samlAttributes, submitLabel: 'Save and continue' }}
            onSaved={(c) => { onSaved(c); setStep(4); }}
          />
        ) : (
          <OrgSsoSettings
            orgId={orgId}
            config={config}
            readOnly={readOnly}
            wizard={{ presetProvider: preset.oidcProvider, submitLabel: 'Save and continue' }}
            onSaved={(c) => { onSaved(c); setStep(4); }}
          />
        )
      )}

      {step === 4 && config && (
        <StepDomains orgId={orgId} config={config} readOnly={readOnly} onSaved={onSaved} onContinue={() => setStep(5)} />
      )}

      {step === 5 && config && (
        <StepTest orgId={orgId} config={config} readOnly={readOnly} onSaved={onSaved} />
      )}

      {step === 6 && config && (
        <div className="space-y-5">
          <SsoEnableToggle orgId={orgId} config={config} readOnly={readOnly} onSaved={onSaved} />
          <SsoRequiredToggle orgId={orgId} config={config} readOnly={readOnly} onSaved={onSaved} />
        </div>
      )}

      <div className="mt-6 flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={back} disabled={step === 1}>
          <ChevronLeft className="w-4 h-4 mr-1" />Back
        </Button>
        {step === 6 ? (
          onDone && <Button size="sm" onClick={onDone}>Finish</Button>
        ) : step === 3 || step === 4 ? null : (
          <Button size="sm" onClick={next} disabled={!canVisit((step + 1) as WizardStep)}>
            Next<ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        )}
      </div>
    </SectionCard>
    </div>
  );
}

function StepProtocol({
  protocol,
  presetId,
  config,
  onProtocol,
  onPreset,
}: {
  protocol: IdpProtocol;
  presetId: string;
  config: OrgIdpConfigDto | null;
  onProtocol: (p: IdpProtocol) => void;
  onPreset: (id: string) => void;
}) {
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="text-sm font-medium mb-2">Protocol</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {([
            ['oidc', 'OpenID Connect', 'Okta, Entra ID, Google, Cognito, Keycloak… — a client ID and secret.'],
            ['saml', 'SAML 2.0', 'Okta, Entra ID, Google Workspace, ADFS, Shibboleth… — metadata and certificates.'],
          ] as const).map(([value, label, blurb]) => (
            <label key={value} className={`flex gap-2 rounded-lg border p-3 cursor-pointer ${protocol === value ? 'border-brand' : 'border-default'}`}>
              <input type="radio" name="sso-protocol" value={value} checked={protocol === value} onChange={() => onProtocol(value)} />
              <span>
                <span className="flex items-center gap-1 font-medium text-sm">{value === 'saml' && <KeyRound className="w-3.5 h-3.5" />}{label}</span>
                <span className="block text-xs text-fg-muted">{blurb}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {config && config.protocol !== protocol && (
        <Callout variant="warning">
          This organization currently signs in over {config.protocol === 'saml' ? 'SAML' : 'OIDC'}. Saving the next
          steps switches it to {protocol === 'saml' ? 'SAML' : 'OIDC'} — the other protocol&apos;s settings are kept.
          The last test result is cleared, so test again before requiring SSO.
        </Callout>
      )}
      <fieldset>
        <legend className="text-sm font-medium mb-2">Identity provider</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {presetsFor(protocol).map((p) => (
            <label key={p.id} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm cursor-pointer ${presetId === p.id ? 'border-brand' : 'border-default'}`}>
              <input type="radio" name="sso-preset" value={p.id} checked={presetId === p.id} onChange={() => onPreset(p.id)} />
              {p.label}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

function StepDomains({
  orgId,
  config,
  readOnly,
  onSaved,
  onContinue,
}: {
  orgId: string;
  config: OrgIdpConfigDto;
  readOnly: boolean;
  onSaved: (config: OrgIdpConfigDto) => void;
  onContinue: () => void;
}) {
  const [domains, setDomains] = useState<string[]>(config.allowedEmailDomains);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const verified = useVerifiedDomains(orgId);
  useEffect(() => { setDomains(config.allowedEmailDomains); }, [config.allowedEmailDomains]);

  // The step-up modal closes the moment it hands the token over, so without a
  // busy flag the button is live again while the PATCH is still on the wire —
  // a second click re-opens step-up and sends the write twice. The ref stops a
  // late failure writing state into an unmounted step (the success path
  // advances the wizard, which unmounts this one).
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const changed = [...domains].sort().join(',') !== [...config.allowedEmailDomains].sort().join(',');

  const save = async (stepUpToken: string) => {
    setPending(false);
    setSaving(true);
    setError(null);
    try {
      const res = await api.patchOwnOrgIdpConfig(orgId, { allowedEmailDomains: domains }, stepUpToken);
      if (res.data?.config) onSaved(res.data.config);
      onContinue();
    } catch (err) {
      if (alive.current) setError(formatError(err, 'Could not save the domains'));
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-muted">
        Single sign-on serves people whose email is in a domain your organization has verified (a DNS TXT record).
        It is also the set &ldquo;require single sign-on&rdquo; applies to.
      </p>
      <VerifiedDomainPicker orgId={orgId} value={domains} onChange={setDomains} disabled={readOnly} />
      {verified.domains !== null && verified.domains.length === 0 && (
        <p className="text-xs text-fg-muted">
          You can continue and test now, but a test (and every sign-in) is refused until the email&apos;s domain is
          verified — except for Google Workspace, which verifies its own domains.{' '}
          <Link href={DOMAIN_SETTINGS_HREF} className="underline">Verify a domain</Link>.
        </p>
      )}
      <ErrorAlert message={error} onDismiss={() => setError(null)} />
      <Button
        size="sm"
        readOnly={readOnly}
        loading={saving}
        disabled={saving || pending}
        onClick={() => (changed ? setPending(true) : onContinue())}
      >
        {changed ? 'Save and continue' : 'Continue'}
      </Button>
      {pending && (
        <StepUpModal
          action="Change the domains your single sign-on serves"
          requireStrongFactor
          onConfirmed={save}
          onClose={() => setPending(false)}
        />
      )}
    </div>
  );
}

function StepTest({
  orgId,
  config,
  readOnly,
  onSaved,
}: {
  orgId: string;
  config: OrgIdpConfigDto;
  readOnly: boolean;
  onSaved: (config: OrgIdpConfigDto) => void;
}) {
  const onReport = (report: SsoTestReport) => {
    if (report.recorded) {
      onSaved({
        ...config,
        lastTest: { at: report.testedAt, ok: report.ok, protocol: report.protocol, ...(report.reason ? { reason: report.reason } : {}) },
      });
    }
  };
  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-muted">
        Sign in at your identity provider as a normal member (not a platform administrator). The report shows the
        email, name and groups it asserted and which group → role mappings would apply — or exactly why a sign-in
        would be refused.{!config.enabled && ' The connection is not enabled yet, so no member is affected by testing it.'}
      </p>
      {config.lastTest && (
        <p className="text-xs text-fg-muted">
          Last test: {config.lastTest.ok ? 'succeeded' : `failed (${config.lastTest.reason ?? 'error'})`}.
        </p>
      )}
      <SsoTestConnection orgId={orgId} readOnly={readOnly} onReport={onReport} />
    </div>
  );
}
