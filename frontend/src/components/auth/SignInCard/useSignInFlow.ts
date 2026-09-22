// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '@/hooks/useAuth';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { storeSsoIntent } from '@/lib/sso-intent';
import { startOAuthLogin } from '@/lib/oauth-intent';
import { peekReturnPath } from '@/lib/return-to';
import { formatError, providerLabel } from '@/lib/constants';
import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, cancelPasskeyCeremony } from '@/lib/passkeys';
import { webauthnErrorMessage } from '@/lib/webauthn';

/** How long the identifier has to stop changing before we ask the backend about
 *  its domain. Long enough that typing an address is ONE request, short enough
 *  that the answer is there by the time the person reaches for the password. */
const SSO_DISCOVERY_DEBOUNCE_MS = 500;

/** The lowercased domain of an email-shaped identifier, else null (a username
 *  has no domain to discover, so it never costs a request). Mirrors the
 *  platform's `emailDomain` — deliberately permissive: the backend decides. */
export function emailDomain(identifier: string): string | null {
  const value = identifier.trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null;
  const domain = value.slice(at + 1);
  return domain.includes('.') && !domain.includes(' ') ? domain : null;
}

/**
 * Everything the sign-in card does: the password leg, the second-factor and
 * required-password-change steps, SSO discovery and hand-off, passkeys (the
 * conditional-UI autofill ceremony armed on mount and the explicit button) and
 * social sign-in. The step components only render what this returns.
 */
export function useSignInFlow() {
  const { login, completeMfaLogin, completeRequiredPasswordChange, loginWithPasskey, isSubmitting } = useAuth();
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the password was right but the account has an authenticator app.
  // Its presence is what swaps the card over to the code step; clearing it goes
  // back to the password form with nothing else disturbed.
  const [mfaChallengeId, setMfaChallengeId] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaBusy, setMfaBusy] = useState(false);
  // "I have no code and no recovery code left" — the operator-recovery panel.
  const [lostFactorOpen, setLostFactorOpen] = useState(false);
  // Set when the org's MFA requirement refused the sign-in itself (401
  // MFA_REQUIRED): the password was fine, the session simply cannot be minted
  // without a factor. A red error would be misleading — nothing was wrong with
  // what they typed — so it gets its own panel naming who can unblock them.
  const [mfaPolicyBlocked, setMfaPolicyBlocked] = useState<string | null>(null);
  // Set when the password was right but no longer meets the org's password
  // policy: no session was opened, and the card asks for a NEW password.
  const [pwChange, setPwChange] = useState<{ challengeId: string; minLength: number } | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [pwChangeBusy, setPwChangeBusy] = useState(false);
  // Enterprise SSO. `ssoDomain` is what DISCOVERY found (an org's IdP serves the
  // domain — and, per the cache below, whether the org REQUIRES it; we are told
  // nothing else); `ssoAccount` is what a refused password attempt named
  // (`SSO_REQUIRED` carries the org, so the flow can start against it directly
  // and the button can name the provider). A required domain or a refused
  // attempt means: no password path here — except the owner BREAK-GLASS below.
  const [ssoDomain, setSsoDomain] = useState<string | null>(null);
  // "Organization owner? Sign in with a password": owners are exempt from their
  // org's "SSO required" policy, but discovery can't say who is an owner (that
  // would tell an anonymous caller), so the page offers the password path on
  // request and the server decides — a non-owner gets SSO_REQUIRED back.
  const [breakGlass, setBreakGlass] = useState(false);
  const [ssoAccount, setSsoAccount] = useState<{ orgId: string; provider?: string } | null>(null);
  const [ssoBusy, setSsoBusy] = useState(false);
  // One answer per domain per page load — typing an address must not spend the
  // pre-auth rate-limit budget a keystroke at a time. A failed lookup caches
  // `false`: discovery is a hint, and the password path still refuses a covered
  // account with SSO_REQUIRED, which surfaces the same SSO action.
  const ssoByDomain = useRef(new Map<string, 'required' | 'offered' | 'none'>());
  // Latest identifier, read by the in-flight lookup so an answer that arrives
  // after the person has typed on is discarded rather than applied.
  const identifierRef = useRef(identifier);
  identifierRef.current = identifier;
  // Enabled SSO/OAuth providers. Fail-soft: an empty list (none configured, or
  // the endpoint 404s) renders no extra UI — password login is unchanged.
  const [oauthBusy, setOauthBusy] = useState<string | null>(null);
  // Passkeys. WebAuthn support gates the explicit button; CONDITIONAL-UI support
  // is a separate, narrower question (Safari and Firefox had WebAuthn for years
  // without it), asked inside the effect that arms autofill.
  const [passkeySupported, setPasskeySupported] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const sessionExpired = router.query.expired === '1';

  // Fail-soft: no answer means no social buttons, never a broken sign-in form.
  const oauthProviders = useFetch<string[]>(
    async (signal) => (await api.listOAuthProviders({ signal })).data?.providers ?? [],
    [],
  );
  const providers = oauthProviders.data ?? [];

  /**
   * Ask whether this identifier's DOMAIN is federated, and remember the answer.
   *
   * The question is about the domain and nothing else — the endpoint answers the
   * same for an address with an account and one without — so asking it while
   * somebody types reveals nothing about who exists. What comes back is a bare
   * boolean: which org backs the domain, and which IdP it runs, stay on the
   * server (the flow is started by email through `startSsoByEmail`).
   */
  const discoverSso = useCallback(async (value: string) => {
    const domain = emailDomain(value);
    if (!domain) { setSsoDomain(null); return; }

    const known = ssoByDomain.current.get(domain);
    if (known !== undefined) { setSsoDomain(known !== 'none' ? domain : null); return; }

    let mode: 'required' | 'offered' | 'none' = 'none';
    try {
      const res = await api.discoverSso(value.trim());
      if (res.data?.sso === true) mode = res.data.required === true ? 'required' : 'offered';
    } catch {
      // Fail soft — never block a sign-in on a hint.
    }
    ssoByDomain.current.set(domain, mode);
    const sso = mode !== 'none';
    // The person may have typed on: only apply an answer that still matches.
    setSsoDomain((current) => (emailDomain(identifierRef.current) === domain ? (sso ? domain : null) : current));
  }, []);

  /** Debounced discovery while typing. The blur handler runs the same lookup
   *  immediately, for anyone who tabs straight on to the next field. */
  useEffect(() => {
    const domain = emailDomain(identifier);
    if (!domain) { setSsoDomain(null); return; }
    const timer = window.setTimeout(() => { void discoverSso(identifier); }, SSO_DISCOVERY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [identifier, discoverSso]);

  /**
   * Arm passkey sign-in.
   *
   * Where the browser supports conditional UI we start the ceremony on mount and
   * leave it waiting: it surfaces inside the identifier field's autofill
   * dropdown, so a returning user signs in by picking their account — no button,
   * no typing. Anything that ends the ceremony (the person cancels, or another
   * sign-in path aborts it) simply stops it; `webauthnErrorMessage` keeps a
   * cancel silent, and a genuine failure shows once.
   *
   * The pending ceremony is aborted on unmount — a WebAuthn request outliving
   * the component would block the next one the page tries to start.
   */
  useEffect(() => {
    let cancelled = false;
    setPasskeySupported(browserSupportsWebAuthn());
    void (async () => {
      if (!browserSupportsWebAuthn() || !(await browserSupportsWebAuthnAutofill())) return;
      if (cancelled) return;
      try {
        await loginWithPasskey({ autofill: true });
      } catch (err) {
        if (cancelled) return;
        const message = webauthnErrorMessage(err, 'Passkey sign-in failed');
        if (message) setError(message);
      }
    })();
    return () => {
      cancelled = true;
      cancelPasskeyCeremony();
    };
  }, [loginWithPasskey]);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMfaPolicyBlocked(null);
    // Only one WebAuthn ceremony may be in flight per page, and the autofill one
    // started on mount is still waiting — drop it before using a password.
    cancelPasskeyCeremony();
    if (!identifier || !password) { setError('Enter your email and password'); return; }
    try {
      const result = await login(identifier, password);
      if (result.status === 'mfa_required') {
        // The password is proven and discarded; only the challenge handle is
        // kept, so nothing reusable sits in component state while the person
        // fishes their phone out.
        setPassword('');
        setMfaCode('');
        setLostFactorOpen(false);
        setMfaChallengeId(result.challengeId);
      } else if (result.status === 'password_change_required') {
        setPassword('');
        setPwChange({ challengeId: result.challengeId, minLength: result.minLength });
      }
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;

      // The account is federated (SSO discovery missed it, or they signed in by
      // username). The rejection names the org, so the SSO action can start the
      // flow against it directly and say which provider it goes to.
      if (code === 'SSO_REQUIRED') {
        const details = (err as { details?: { orgId?: string; provider?: string } } | null)?.details;
        setPassword('');
        setSsoAccount({ orgId: details?.orgId ?? '', provider: details?.provider });
        return;
      }

      // The org's MFA requirement refused the session, not the credentials.
      if (code === 'MFA_REQUIRED') {
        setPassword('');
        setMfaPolicyBlocked(formatError(err, 'Your organization requires two-factor authentication.'));
        return;
      }

      setError(formatError(err, 'Sign in failed'));
    }
  };

  /**
   * Hand the browser to the org's identity provider.
   *
   * Two ways in, one destination. When a refused password attempt named the org
   * we initiate against it (`getSsoUrl`); when domain discovery is all we have,
   * the backend resolves the org from the address (`startSsoByEmail`) so the
   * login page never has to be told which tenant owns the domain. Either way the
   * response is the IdP URL plus a single-use state, and the return leg —
   * `/auth/sso/[orgId]/callback` for OIDC, `/auth/sso/[orgId]/saml` for SAML —
   * is decided by what the backend registered with the IdP, not by us.
   */
  const startSso = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    cancelPasskeyCeremony();
    setSsoBusy(true);
    try {
      const res = ssoAccount?.orgId
        ? await api.getSsoUrl(ssoAccount.orgId)
        : await api.startSsoByEmail(identifier.trim());
      const url = res.data?.url;
      const state = res.data?.state;
      if (!url || !state) throw new Error('Your organization’s identity provider could not be reached.');
      // The landing page completes only a sign-in this tab started (login CSRF).
      storeSsoIntent(state);
      window.location.href = url;
    } catch (err) {
      setError(formatError(err, 'Could not start single sign-on'));
      setSsoBusy(false);
    }
  };

  /** Second leg: the code from the authenticator app, or a recovery code. */
  const handleMfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!mfaChallengeId || !mfaCode.trim()) { setError('Enter the code from your authenticator app'); return; }
    setMfaBusy(true);
    try {
      const result = await completeMfaLogin(mfaChallengeId, mfaCode.trim());
      if (result?.status === 'password_change_required') {
        setMfaChallengeId(null);
        setMfaCode('');
        setPwChange({ challengeId: result.challengeId, minLength: result.minLength });
      }
    } catch (err) {
      // A dead challenge is the one refusal that isn't opaque, and the one case
      // where retrying the code is pointless — drop back to the password form
      // rather than keep asking for codes nothing will accept.
      if ((err as { code?: string } | null)?.code === 'TOTP_INVALID_CHALLENGE') setMfaChallengeId(null);
      setError(formatError(err, 'Verification failed'));
    } finally {
      setMfaBusy(false);
    }
  };

  /** Last leg of a sign-in whose password is below the org policy: a new one. */
  const handlePasswordChangeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!pwChange) return;
    if (newPassword.length < pwChange.minLength) {
      setError(`Your organization requires at least ${pwChange.minLength} characters`);
      return;
    }
    if (newPassword !== confirmNewPassword) { setError('Passwords do not match'); return; }
    setPwChangeBusy(true);
    try {
      await completeRequiredPasswordChange(pwChange.challengeId, newPassword);
    } catch (err) {
      // A dead handle can't be retried — back to the password form.
      if ((err as { code?: string } | null)?.code === 'PASSWORD_CHANGE_CHALLENGE_INVALID') setPwChange(null);
      setError(formatError(err, 'Could not change your password'));
    } finally {
      setPwChangeBusy(false);
    }
  };

  const cancelPasswordChange = () => {
    setPwChange(null);
    setNewPassword('');
    setConfirmNewPassword('');
    setError(null);
  };

  /** Abandon the code step and start over with the password. */
  const cancelMfa = () => {
    setMfaChallengeId(null);
    setMfaCode('');
    setLostFactorOpen(false);
    setError(null);
  };

  /** The explicit "Sign in with a passkey" path, for browsers without autofill
   *  (and for anyone who'd rather click than find the dropdown). */
  const handlePasskeySignIn = async () => {
    setError(null);
    // Replaces the waiting autofill request, which would otherwise refuse this one.
    cancelPasskeyCeremony();
    setPasskeyBusy(true);
    try {
      await loginWithPasskey();
    } catch (err) {
      const message = webauthnErrorMessage(err, 'Passkey sign-in failed');
      if (message) setError(message);
    } finally {
      setPasskeyBusy(false);
    }
  };

  // Either signal means the same thing to this card: this identifier signs in
  // at an identity provider, so there is no password to collect — unless the
  // person asked for the owner break-glass path on a REQUIRED domain.
  const ssoMode = ssoDomain ? ssoByDomain.current.get(ssoDomain) : undefined;
  const ssoRequired = ssoAccount !== null || (ssoMode === 'required' && !breakGlass);
  // SSO is available but not required (or an owner took the password path):
  // offer it next to the password form.
  const ssoOffered = !ssoRequired && ssoDomain !== null && ssoAccount === null;
  // A refused attempt names the provider ("Continue with Okta"); discovery
  // deliberately doesn't, and a SAML config has no provider name at all — both
  // fall back to the plain phrase rather than inventing one.
  const ssoProviderName = ssoAccount?.provider && !['saml', 'generic-oidc'].includes(ssoAccount.provider)
    ? providerLabel(ssoAccount.provider)
    : 'single sign-on';

  // Start the OAuth dance: fetch the provider authorize URL (backend mints the
  // CSRF state), stash a "login" intent under that state so the callback page
  // can complete it, then hand the browser to the provider.
  const startOAuth = async (provider: string) => {
    setError(null);
    setOauthBusy(provider);
    try {
      await startOAuthLogin(provider, peekReturnPath() ?? undefined);
    } catch (err) {
      setError(formatError(err, `Could not sign in with ${providerLabel(provider)}`));
      setOauthBusy(null);
    }
  };


  /** Typing a different identifier drops everything learned about the old one. */
  const changeIdentifier = (value: string) => {
    setIdentifier(value);
    // What a refused attempt told us belonged to the OLD address.
    if (ssoAccount) setSsoAccount(null);
    if (breakGlass) setBreakGlass(false);
    if (mfaPolicyBlocked) setMfaPolicyBlocked(null);
  };

  return {
    isSubmitting, sessionExpired, error,
    identifier, changeIdentifier, password, setPassword, showPassword, setShowPassword, handleSignIn,
    mfaChallengeId, mfaCode, setMfaCode, mfaBusy, handleMfaSubmit, cancelMfa, lostFactorOpen, setLostFactorOpen,
    mfaPolicyBlocked,
    pwChange, newPassword, setNewPassword, confirmNewPassword, setConfirmNewPassword, pwChangeBusy,
    handlePasswordChangeSubmit, cancelPasswordChange,
    discoverSso, ssoDomain, ssoAccount, ssoRequired, ssoOffered, ssoProviderName, ssoBusy, startSso, setBreakGlass,
    passkeySupported, passkeyBusy, handlePasskeySignIn,
    providers, oauthBusy, startOAuth,
  };
}

export type SignInFlow = ReturnType<typeof useSignInFlow>;
