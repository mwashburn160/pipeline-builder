// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { KeyRound, LogIn, ShieldAlert, Smartphone } from 'lucide-react';
import api from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Modal } from '@/components/ui/Modal';
import { useFetch } from '@/hooks/useFetch';
import { formatError, providerLabel } from '@/lib/constants';
import { PASSKEY_ENROLMENT_HREF } from '@/lib/security-links';
import { stepUpWithPasskey } from '@/lib/passkeys';
import { runProviderReauth } from '@/lib/step-up-reauth';
import { webauthnErrorMessage } from '@/lib/webauthn';
import type { AuthFactors, ReauthProvider } from '@/types';

interface Props {
  /** Short description of the action being gated, shown to the user. */
  action: string;
  /**
   * Dialog heading. Defaults to "Confirm it's you"; a destructive action passes
   * its own question ("Sign this device out?") because this dialog IS the
   * confirmation — see `details`.
   */
  title?: string;
  /**
   * What the action costs, stated here rather than in a separate ConfirmDialog
   * ahead of it. ONE dialog confirms and steps up: the double modal it replaces
   * asked the same person the same question twice, and taught them to click
   * through both without reading either.
   */
  details?: ReactNode;
  /** Called with the short-lived step-up token once the user re-verifies.
   *  The caller MUST pass this token to the subsequent destructive API
   *  call as the second argument; api methods that require step-up
   *  forward it via the `X-Step-Up-Token` header. */
  onConfirmed: (stepUpToken: string) => void | Promise<void>;
  /**
   * The route accepts ONLY a second factor (#8): a passkey or an
   * authenticator-app code. Hides the password field and the provider buttons,
   * which would mint a token the server refuses with `STEP_UP_METHOD_REQUIRED`.
   *
   * Set it on the routes whose backend gate names those methods — impersonation,
   * KMS, IdP settings, platform-admin grants — and the layout also sets it when
   * a refusal comes back with that code, so a stale tab re-prompts correctly.
   */
  requireStrongFactor?: boolean;
  /**
   * Something the caller still needs before it can act (a required reason left
   * empty, an invalid form field): every way to confirm is disabled and this
   * says why. Validating AFTER the step-up spent a single-use token (and the
   * person's fingerprint or code) on a request that could only be refused.
   */
  confirmDisabledReason?: string | null;
  onClose: () => void;
}

/** Fallback when the profile can't be read: offer the password, which is what
 *  most accounts have — the server is the real gate either way. */
const PASSWORD_ONLY: AuthFactors = { hasPassword: true, passkeyCount: 0, hasTotp: false, providers: [] };

/** What to call a provider option in the button. */
function optionLabel(option: ReauthProvider): string {
  if (option.type === 'sso') {
    return option.orgName ? `${option.orgName} single sign-on` : 'single sign-on';
  }
  return providerLabel(option.provider);
}

/**
 * Re-verification prompt before destructive actions (grant/revoke platform-admin,
 * KMS rotation, namespace YAML download, org delete, bulk-delete users, ownership
 * transfer, PAT creation, …).
 *
 * Step-up is factor-agnostic: the modal reads the account's factors from
 * `GET /user/profile` (`authFactors`) and offers only what the user has, in
 * descending order of how hard each is to steal —
 *   - "Use a passkey" (POST /api/auth/step-up/webauthn/…), offered FIRST when
 *     the account has one: it is the strongest factor here and the quickest
 *     (a fingerprint, not a typed secret);
 *   - an authenticator-app code (POST /api/auth/step-up/totp), which a recovery
 *     code also satisfies — second because it proves possession of a device, and
 *     is the one factor available on a machine with no passkey;
 *   - a password field (POST /api/auth/step-up), and/or
 *   - "Sign in again with <provider>" for each linked social/SSO provider, which
 *     runs the provider round trip in a popup (src/lib/step-up-reauth).
 * Accounts created through Google/GitHub/SSO have no password at all, and used to
 * be locked out of every step-up-gated action.
 *
 * Every path returns the same 60s step-up token, which is handed to
 * `onConfirmed` and replayed by the caller's API call; the backend's
 * `requireStepUp` middleware enforces it.
 *
 * IT IS ALSO THE CONFIRMATION. A destructive action passes `title` + `details`
 * and opens THIS dialog only — no ConfirmDialog in front of it. One dialog, one
 * decision: the pair asked the same person the same question twice and taught
 * them to click through both. (Actions the server does NOT step-up gate — key
 * revocation, deliberately, so a compromised key is always killable — still use
 * a plain ConfirmDialog; the rule is one dialog, not one component.)
 *
 * It opens focused on the factor the account actually has — the passkey button,
 * the authenticator field, or the password box — which for a TOTP-only account
 * is the difference between typing a code and hunting for the field.
 */
export function StepUpModal({ action, title, details, onConfirmed, requireStrongFactor = false, confirmDisabledReason = null, onClose }: Props) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [pendingProvider, setPendingProvider] = useState<string | null>(null);
  const [passkeyPending, setPasskeyPending] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [totpPending, setTotpPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The control the dialog opens on. Which one that is isn't known until the
  // account's factors arrive — a TOTP-only account has no password field at all
  // — so it is attached by callback ref to whichever control wins, and Modal
  // focuses it when it appears (it used to focus "Close" and stay there).
  const focusRef = useRef<HTMLElement | null>(null);
  const assignFocus = useCallback((el: HTMLElement | null) => { focusRef.current = el; }, []);
  // Lets Cancel abort a provider round trip that's still waiting on the popup.
  const abortRef = useRef<AbortController | null>(null);

  // Fail soft: a failed profile read shows the password field rather than
  // blocking the action, so the error is folded into the same fallback.
  const profile = useFetch<AuthFactors>(
    async () => (await api.getProfile()).data?.user?.authFactors ?? PASSWORD_ONLY,
    [],
  );
  const factors = profile.loading ? null : profile.data ?? PASSWORD_ONLY;

  // Abandoning the dialog must also stop a popup round trip that's in flight.
  useEffect(() => () => abortRef.current?.abort(), []);

  const finish = useCallback(async (token: string) => {
    await onConfirmed(token);
    onClose();
  }, [onConfirmed, onClose]);

  const handleSubmit = useCallback(async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (confirmDisabledReason) return;
    if (!password) {
      setError('Password is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.stepUpVerify(password);
      if (res.success && res.data?.stepUpToken) {
        await finish(res.data.stepUpToken);
      } else {
        setError(res.message || 'Verification failed');
      }
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSubmitting(false);
    }
  }, [password, finish, confirmDisabledReason]);

  const handlePasskey = useCallback(async () => {
    setPasskeyPending(true);
    setError(null);
    try {
      await finish(await stepUpWithPasskey());
    } catch (err) {
      // A dismissed browser prompt is a cancel, not a failure — say nothing.
      setError(webauthnErrorMessage(err, 'Could not confirm with that passkey'));
    } finally {
      setPasskeyPending(false);
    }
  }, [finish]);

  const handleTotp = useCallback(async () => {
    const code = totpCode.trim();
    if (!code) { setError('Enter the code from your authenticator app'); return; }
    setTotpPending(true);
    setError(null);
    try {
      const res = await api.stepUpWithTotp(code);
      if (res.success && res.data?.stepUpToken) {
        await finish(res.data.stepUpToken);
      } else {
        setError(res.message || 'Verification failed');
      }
    } catch (err) {
      // The server's wording is specific (wrong code vs. locked out); showing it
      // verbatim beats re-deriving a message the backend may disagree with.
      setError(formatError(err, 'Could not confirm with that code'));
    } finally {
      setTotpPending(false);
    }
  }, [totpCode, finish]);

  const handleProvider = useCallback(async (option: ReauthProvider) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setPendingProvider(option.type === 'sso' ? option.orgId : option.provider);
    setError(null);
    try {
      await finish(await runProviderReauth(option, controller.signal));
    } catch (err) {
      setError(formatError(err, `Could not confirm with ${optionLabel(option)}`));
    } finally {
      abortRef.current = null;
      setPendingProvider(null);
    }
  }, [finish]);

  const handleClose = useCallback(() => {
    abortRef.current?.abort();
    onClose();
  }, [onClose]);

  const inFlight = submitting || pendingProvider !== null || passkeyPending || totpPending;
  // Disables every confirm control while the caller's own input is incomplete.
  const busy = inFlight || !!confirmDisabledReason;
  // On a strong-factor-only route the password and provider paths are hidden:
  // they can still MINT a step-up token, but the server refuses it, so offering
  // them would only produce a confusing second failure.
  const hasPassword = !requireStrongFactor && (factors?.hasPassword ?? false);
  const hasPasskeys = (factors?.passkeyCount ?? 0) > 0;
  const hasTotp = factors?.hasTotp ?? false;
  const providers = requireStrongFactor ? [] : (factors?.providers ?? []);

  // Where the dialog opens: the quickest factor the account actually holds,
  // in the same order the options are offered below.
  const preferred = !factors ? null
    : hasPasskeys ? 'passkey'
      : hasTotp ? 'totp'
        : hasPassword ? 'password'
          : providers.length > 0 ? 'provider' : null;

  return (
    <Modal
      title={title ?? "Confirm it's you"}
      titleIcon={<ShieldAlert className="h-5 w-5 text-warning shrink-0" />}
      onClose={handleClose}
      initialFocusRef={focusRef}
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        <p className="text-sm text-fg-muted">
          About to: <strong>{action}</strong>
        </p>

        {/* WHY this is being asked, in words. The code around here calls it
            "step-up", "strong step-up" and "assurance"; none of those mean
            anything to the person staring at the dialog. Two sentences, one for
            each gate, stating the reason for THIS action. */}
        <p className="text-xs text-fg-muted">
          {requireStrongFactor
            ? 'This action changes who can get into your organization, so a password alone isn’t enough: passwords get phished and reused. Confirm with something only you physically hold — a passkey or your authenticator app.'
            : 'Confirming proves it’s still you at the keyboard, not someone who found this session open. It won’t sign you out.'}
        </p>

        {/* What it costs — this dialog is the confirmation as well as the gate. */}
        {details && <div className="space-y-2 text-sm text-fg-muted">{details}</div>}

        {!factors ? (
          <p className="flex items-center gap-2 text-xs text-fg-muted">
            <LoadingSpinner size="sm" /> Checking how you can confirm…
          </p>
        ) : (
          <>
            {/* Passkey first: the strongest factor offered here, and the one
                that takes a touch rather than a typed secret. */}
            {hasPasskeys && (
              <div className="space-y-2">
                <p className="text-xs text-fg-muted">Confirm with a passkey.</p>
                <Button
                  type="button"
                  fullWidth
                  ref={preferred === 'passkey' ? assignFocus : undefined}
                  className="inline-flex items-center justify-center gap-2"
                  disabled={busy}
                  onClick={() => void handlePasskey()}
                >
                  {passkeyPending ? <LoadingSpinner size="sm" /> : <KeyRound className="w-4 h-4" />}
                  Use a passkey
                </Button>
              </div>
            )}

            {/* Authenticator app — the factor that works on any machine, with or
                without a passkey. A recovery code is accepted here too, which is
                why the field is not digit-constrained. */}
            {hasTotp && (
              <div className="space-y-2">
                <p className="text-xs text-fg-muted">
                  {hasPasskeys
                    ? 'Or enter the code from your authenticator app:'
                    : 'Enter the code from your authenticator app. A recovery code works too.'}
                </p>
                <div className="flex gap-2">
                  <Input
                    type="text"
                    ref={preferred === 'totp' ? assignFocus : undefined}
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (!confirmDisabledReason) void handleTotp(); } }}
                    autoComplete="one-time-code"
                    placeholder="123456"
                    aria-label="Authentication code"
                    className="flex-1"
                    disabled={inFlight}
                  />
                  <Button
                    type="button"
                    className="inline-flex items-center justify-center gap-2 shrink-0"
                    disabled={busy || !totpCode.trim()}
                    onClick={() => void handleTotp()}
                  >
                    {totpPending ? <LoadingSpinner size="sm" /> : <Smartphone className="w-4 h-4" />}
                    Verify
                  </Button>
                </div>
              </div>
            )}

            {hasPassword && (
              <>
                <p className="text-xs text-fg-muted">
                  {hasPasskeys || hasTotp ? 'Or re-enter your password:' : 'Re-enter your password to confirm.'}
                </p>

                <Input
                  ref={preferred === 'password' ? assignFocus : undefined}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  placeholder="Password"
                  className="w-full"
                  disabled={inFlight}
                />
              </>
            )}

            {providers.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-fg-muted">
                  {hasPassword || hasPasskeys || hasTotp
                    ? 'Or confirm by signing in again:'
                    : 'Sign in again with your provider to confirm. A window opens for the sign-in.'}
                </p>
                {providers.map((option, index) => {
                  const key = option.type === 'sso' ? `sso:${option.orgId}` : `oauth:${option.provider}`;
                  const pending = pendingProvider === (option.type === 'sso' ? option.orgId : option.provider);
                  return (
                    <Button
                      key={key}
                      type="button"
                      variant="secondary"
                      fullWidth
                      ref={preferred === 'provider' && index === 0 ? assignFocus : undefined}
                      className="inline-flex items-center justify-center gap-2"
                      disabled={busy}
                      onClick={() => void handleProvider(option)}
                    >
                      {pending ? <LoadingSpinner size="sm" /> : <LogIn className="w-4 h-4" />}
                      Sign in again with {optionLabel(option)}
                    </Button>
                  );
                })}
              </div>
            )}

            {requireStrongFactor && !hasPasskeys && !hasTotp && (
              <p className="text-xs text-fg-muted">
                This account has neither a passkey nor an authenticator app, so there is no
                way to confirm this action yet. Add one from{' '}
                <a href={PASSKEY_ENROLMENT_HREF} className="action-link">
                  Security → Factors
                </a>
                , then sign in again and retry.
              </p>
            )}

            {!requireStrongFactor && !hasPassword && !hasPasskeys && !hasTotp && providers.length === 0 && (
              <p className="text-xs text-fg-muted">
                This account has no way to confirm sensitive actions. Add a passkey
                from{' '}
                <a href={PASSKEY_ENROLMENT_HREF} className="action-link">
                  Security → Factors
                </a>
                , set a password, or link a sign-in provider — or ask an administrator for help.
              </p>
            )}
          </>
        )}

        {confirmDisabledReason && (
          <p className="text-xs text-warning-strong" role="status" data-testid="step-up-blocked">{confirmDisabledReason}</p>
        )}
        <ErrorAlert message={error} />

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={handleClose} disabled={submitting}>
            Cancel
          </Button>
          {hasPassword && (
            <Button type="submit" className="inline-flex items-center gap-2" disabled={busy || !password}>
              {submitting && <LoadingSpinner size="sm" />}
              Confirm
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}
