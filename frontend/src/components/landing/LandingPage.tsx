import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { motion } from 'framer-motion';
import {
  Shield, BarChart3, Cloud,
  Bot, Globe, Zap, ArrowRight, ArrowLeft, Check, KeyRound, LogIn, Sparkles,
  Menu, X, Moon, Sun, Eye, EyeOff, Smartphone, Building2, HelpCircle, ShieldAlert,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useDarkMode } from '@/hooks/useDarkMode';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import api from '@/lib/api';
import { startOAuthLogin } from '@/lib/oauth-intent';
import { peekReturnPath } from '@/lib/return-to';
import { formatError, providerLabel } from '@/lib/constants';
import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, cancelPasskeyCeremony } from '@/lib/passkeys';
import { webauthnErrorMessage } from '@/lib/webauthn';

// sessionStorage key carrying the OAuth "intent" across the provider redirect.
// Must match the callback page (pages/auth/callback/[provider].tsx).

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

const fadeUp = {
  hidden: { opacity: 0, y: 16 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.05, duration: 0.35, ease: 'easeOut' as const },
  }),
};

// ---------------------------------------------------------------------------
// Nav
// ---------------------------------------------------------------------------

function NavBar() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { isDark, toggle: toggleDark } = useDarkMode();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 32);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <nav className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
      scrolled || mobileOpen
        ? 'bg-surface/90 backdrop-blur-lg border-b border-default shadow-sm'
        : 'bg-transparent'
    }`}>
      <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
        <a href="#top" className="font-serif text-lg font-bold text-fg" aria-label="Pipeline Builder home">
          Pipeline Builder
        </a>
        <div className="flex items-center gap-2">
          <button onClick={toggleDark} className="p-2 text-fg-muted hover:text-fg transition-colors" aria-label="Toggle dark mode">
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          <Link href="/auth/register" className="hidden sm:inline-flex btn btn-primary text-sm px-4 py-1.5">
            Get Started
          </Link>
          <button onClick={() => setMobileOpen(!mobileOpen)} className="sm:hidden p-2 text-fg-muted" aria-label="Menu">
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>
      {/* Mobile menu */}
      {mobileOpen && (
        <div className="sm:hidden border-t border-default bg-surface px-6 py-4 space-y-3">
          <a href="#signin" onClick={() => setMobileOpen(false)} className="block text-sm text-fg-muted">Sign in</a>
          <Link href="/auth/register" onClick={() => setMobileOpen(false)} className="block btn btn-primary text-sm text-center">Get Started</Link>
        </div>
      )}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Sign-in helpers
// ---------------------------------------------------------------------------

/** How long the identifier has to stop changing before we ask the backend about
 *  its domain. Long enough that typing an address is ONE request, short enough
 *  that the answer is there by the time the person reaches for the password. */
const SSO_DISCOVERY_DEBOUNCE_MS = 500;

/** The lowercased domain of an email-shaped identifier, else null (a username
 *  has no domain to discover, so it never costs a request). Mirrors the
 *  platform's `emailDomain` — deliberately permissive: the backend decides. */
function emailDomain(identifier: string): string | null {
  const value = identifier.trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null;
  const domain = value.slice(at + 1);
  return domain.includes('.') && !domain.includes(' ') ? domain : null;
}

/** The operator command for the case the dashboard can't reach — nobody able to
 *  sign in to approve a reset (platform `src/scripts/mfa-recover.ts`). */
const MFA_RECOVER_COMMAND = 'node scripts/mfa-recover.js --email <your address>';

/**
 * What to do when every second factor is gone.
 *
 * Shown on demand at the two places the dead end is actually reached: under the
 * code step (the app is gone AND the recovery codes are gone) and under the
 * org-policy refusal (the requirement bites and there is no factor to meet it).
 * Recovery is never self-service — anything that removed a factor on request
 * would be a way around it — so the honest answer is WHO to ask: two admins of
 * the organization (one requests, a different one approves), a platform
 * administrator for an org with no second admin, or the operator command when
 * nobody can sign in at all.
 */
function LostFactorHelp() {
  return (
    <div className="rounded-xl border border-default bg-surface-muted p-3 text-left space-y-2">
      <p className="text-xs font-normal leading-relaxed text-fg-muted">
        Two-factor authentication can’t be turned off from a sign-in page — there is
        deliberately no self-service route, because anything that removed your second
        factor on request would be a way around it.
      </p>
      <p className="text-xs font-normal leading-relaxed text-fg-muted">
        Ask an owner or admin of your organization to reset your two-factor authentication
        from its Members page; a <strong>second</strong> owner or admin approves it. If your
        organization has no second admin, a platform administrator can reset it instead.
      </p>
      <p className="text-xs font-normal leading-relaxed text-fg-muted">
        The reset removes every passkey, the authenticator app and the recovery codes, signs
        the account out everywhere, and is recorded in the audit trail under the people who
        did it. You then have a few days to sign in with your password and enrol a new factor
        — your organization&apos;s policy is not relaxed for anyone else.
      </p>
      <p className="text-xs font-normal leading-relaxed text-fg-muted">
        If nobody can sign in to do that, whoever operates Pipeline Builder runs:
      </p>
      <code className="block p-2 rounded-lg text-2xs font-mono bg-surface text-fg break-all">
        {MFA_RECOVER_COMMAND}
      </code>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hero — headline left, sign-in right
// ---------------------------------------------------------------------------

function Hero() {
  const { login, completeMfaLogin, completeRequiredPasswordChange, loginWithPasskey, isLoading } = useAuth();
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
  const [providers, setProviders] = useState<string[]>([]);
  const [oauthBusy, setOauthBusy] = useState<string | null>(null);
  // Passkeys. WebAuthn support gates the explicit button; CONDITIONAL-UI support
  // is a separate, narrower question (Safari and Firefox had WebAuthn for years
  // without it), asked inside the effect that arms autofill.
  const [passkeySupported, setPasskeySupported] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const sessionExpired = router.query.expired === '1';

  useEffect(() => {
    let cancelled = false;
    api.listOAuthProviders()
      .then((res) => { if (!cancelled) setProviders(res.data?.providers ?? []); })
      .catch(() => { if (!cancelled) setProviders([]); });
    return () => { cancelled = true; };
  }, []);

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
      if (!url) throw new Error('Your organization’s identity provider could not be reached.');
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

  return (
    <section id="top" className="pt-24 pb-10 px-6">
      <div className="max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-5 gap-10 items-start">
        {/* Left — 3 cols */}
        <div className="lg:col-span-3 pt-2">
          <motion.div
            className="inline-flex items-center gap-1.5 mb-3 px-3 py-1 rounded-full text-xs font-medium bg-surface border border-default text-fg-muted"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
          >
            <Sparkles className="w-3.5 h-3.5 text-brand" strokeWidth={2} />
            Self-service CI/CD for AWS
          </motion.div>
          <motion.h1
            className="text-3xl sm:text-4xl font-bold leading-tight mb-3"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.05 }}
          >
            CI/CD pipelines from code or{' '}
            <span className="text-brand">AI</span>
          </motion.h1>
          <motion.p
            className="text-fg-muted text-sm mb-4 leading-relaxed max-w-lg"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1 }}
          >
            Turn a Git URL or a prompt into a working pipeline — deployed as native
            AWS CodePipeline in your own account. 119 plugins, per-org compliance,
            zero lock-in.
          </motion.p>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3, delay: 0.18 }}
          >
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-fg-muted mb-5">
              {['Dashboard', 'AI Prompt', 'CLI', 'REST API', 'CDK'].map((t) => (
                <span key={t} className="flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5 text-success" strokeWidth={2} />
                  {t}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Link href="/auth/register" className="btn btn-primary px-5 py-2 text-sm">
                Get started free <ArrowRight className="w-3.5 h-3.5 ml-1.5 inline" />
              </Link>
              <a href="#how" className="btn btn-secondary px-5 py-2 text-sm">See how it works</a>
              <span className="text-xs text-fg-muted">
                Apache-2.0 · No credit card
              </span>
            </div>
          </motion.div>
        </div>

        {/* Right — 2 cols, sign-in card */}
        <motion.div
          id="signin"
          className="lg:col-span-2"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
        >
          <Card className="p-5">
            <h2 className="font-bold mb-4">{pwChange ? 'Choose a new password' : mfaChallengeId ? 'Two-factor authentication' : 'Sign in'}</h2>

            {sessionExpired && !error && !mfaChallengeId && !pwChange && (
              <div className="alert-warning mb-3" role="status" aria-live="polite">
                <p>Your session expired. Sign in again and we&apos;ll take you back to where you were.</p>
              </div>
            )}
            <ErrorAlert message={error} className="mb-3" />

            {/* The org's MFA deadline has passed and this account has no factor
                to meet it, so there is nothing to sign in with. Say who can
                unblock them rather than repeat "enrol a factor" at somebody who
                cannot get far enough in to do it. */}
            {mfaPolicyBlocked && !mfaChallengeId && (
              <div className="alert-warning mb-3" role="status" aria-live="polite">
                <p className="flex items-start gap-2">
                  <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                  <span>{mfaPolicyBlocked}</span>
                </p>
                <ul className="mt-2 space-y-1.5 text-sm text-fg list-disc pl-8">
                  <li>
                    If you already have a passkey on this device, use{' '}
                    <strong>Sign in with a passkey</strong> below — it satisfies the requirement
                    on its own.
                  </li>
                  <li>
                    If you saved recovery codes when you set up a passkey, sign in again — you
                    will be asked for one.
                  </li>
                  <li>
                    Otherwise two owners or admins of your organization can reset your two-factor
                    authentication, which gives you a few days to sign in and enrol — see below.
                  </li>
                </ul>
                <div className="mt-3">
                  <LostFactorHelp />
                </div>
              </div>
            )}

            {/* Second factor. Replaces the whole card body rather than appearing
                below it: the password is already proven and re-showing the field
                only invites people to retype it. */}
            {pwChange ? (
              <form onSubmit={handlePasswordChangeSubmit} className="space-y-3">
                <p className="text-sm text-fg-muted flex items-start gap-2">
                  <KeyRound className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                  <span>
                    Your organization now requires passwords of at least <strong>{pwChange.minLength}</strong> characters,
                    and yours is shorter. Choose a new one to continue — it also signs you out everywhere else.
                  </span>
                </p>
                <Input
                  id="signin-new-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  autoFocus
                  minLength={pwChange.minLength}
                  placeholder={`New password (${pwChange.minLength}+ characters)`}
                  aria-label="New password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  disabled={pwChangeBusy}
                />
                <Input
                  id="signin-new-password-confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  placeholder="Confirm new password"
                  aria-label="Confirm new password"
                  value={confirmNewPassword}
                  onChange={(e) => setConfirmNewPassword(e.target.value)}
                  disabled={pwChangeBusy}
                />
                <Button type="submit" fullWidth disabled={pwChangeBusy || !newPassword || !confirmNewPassword} className="text-sm">
                  {pwChangeBusy
                    ? <><LoadingSpinner size="sm" className="mr-2" /> Saving...</>
                    : <><LogIn className="w-4 h-4 mr-1.5" /> Change password and sign in</>
                  }
                </Button>
                <Button type="button" variant="secondary" fullWidth onClick={cancelPasswordChange} disabled={pwChangeBusy} className="text-sm">
                  <ArrowLeft className="w-4 h-4 mr-1.5" /> Use a different account
                </Button>
              </form>
            ) : mfaChallengeId ? (
              <form onSubmit={handleMfaSubmit} className="space-y-3">
                <p className="text-sm text-fg-muted flex items-start gap-2">
                  <Smartphone className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                  <span>Enter the 6-digit code from your authenticator app.</span>
                </p>
                {/* The recovery code is named HERE, in the sentence, not left to
                    a placeholder that vanishes the moment anyone types: this is
                    the exact point where someone discovers their phone is gone. */}
                <p className="text-sm text-fg-muted flex items-start gap-2">
                  <KeyRound className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                  <span>
                    Phone lost or wiped — or you sign in with a passkey you no longer have? Use one of
                    the recovery codes you saved when you set up two-factor authentication — they go in
                    this same box, and each one works once.
                  </span>
                </p>
                <Input
                  id="signin-mfa-code"
                  type="text"
                  // `one-time-code` is what lets iOS/Android offer the code from
                  // the SMS/authenticator sheet instead of making people switch apps.
                  autoComplete="one-time-code"
                  inputMode="text"
                  required
                  autoFocus
                  placeholder="123456 or a recovery code"
                  aria-label="Authentication code"
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  disabled={mfaBusy}
                />
                <Button type="submit" fullWidth disabled={mfaBusy || !mfaCode.trim()} className="text-sm">
                  {mfaBusy
                    ? <><LoadingSpinner size="sm" className="mr-2" /> Verifying...</>
                    : <><LogIn className="w-4 h-4 mr-1.5" /> Verify</>
                  }
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  fullWidth
                  onClick={cancelMfa}
                  disabled={mfaBusy}
                  className="text-sm"
                >
                  <ArrowLeft className="w-4 h-4 mr-1.5" /> Use a different account
                </Button>
                {/* The dead end the code step used to have no answer for. Folded
                    away by default — most people have a code — and honest when
                    opened: recovery is an operator command, not a self-service
                    button. */}
                <button
                  type="button"
                  onClick={() => setLostFactorOpen((v) => !v)}
                  aria-expanded={lostFactorOpen}
                  className="w-full inline-flex items-center justify-center gap-1.5 text-xs text-fg-muted hover:text-fg focus:outline-none focus:ring-2 focus:ring-brand rounded py-1"
                >
                  <HelpCircle className="w-3.5 h-3.5" aria-hidden="true" />
                  Lost your phone and your codes?
                </button>
                {lostFactorOpen && <LostFactorHelp />}
              </form>
            ) : (
            <form onSubmit={ssoRequired ? startSso : handleSignIn} className="space-y-3">
              <Input
                id="signin-identifier"
                type="text"
                // `webauthn` is what puts discoverable passkeys into this
                // field's autofill dropdown; it is inert without a conditional
                // -UI ceremony waiting, so it is safe to always declare.
                autoComplete="username webauthn"
                required
                placeholder="Email or username"
                aria-label="Email or username"
                value={identifier}
                onChange={(e) => {
                  setIdentifier(e.target.value);
                  // What a refused attempt told us belonged to the OLD address.
                  if (ssoAccount) setSsoAccount(null);
                  if (breakGlass) setBreakGlass(false);
                  if (mfaPolicyBlocked) setMfaPolicyBlocked(null);
                }}
                // Anyone who tabs straight past gets the answer now rather than
                // after the debounce.
                onBlur={() => { void discoverSso(identifier); }}
                disabled={isLoading || ssoBusy}
              />
              {/* An SSO-backed domain gets NO password field. The backend refuses
                  a password (and a social grant) for these accounts anyway, so
                  offering one only produces a rejection the person can't act on. */}
              {ssoRequired ? (
                <>
                  <p className="text-sm text-fg-muted flex items-start gap-2" role="status">
                    <Building2 className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                    <span>
                      {ssoAccount
                        ? 'This account signs in through your organization’s identity provider, so a password here won’t work.'
                        : `${ssoDomain} is managed by your organization — sign-in happens at its identity provider.`}
                    </span>
                  </p>
                  <Button type="submit" fullWidth disabled={ssoBusy} className="text-sm">
                    {ssoBusy
                      ? <><LoadingSpinner size="sm" className="mr-2" /> Redirecting…</>
                      : <><LogIn className="w-4 h-4 mr-1.5" /> Continue with {ssoProviderName}</>}
                  </Button>
                  {!ssoAccount && (
                    <button
                      type="button"
                      onClick={() => setBreakGlass(true)}
                      className="w-full text-xs text-fg-muted hover:text-fg underline py-1"
                    >
                      Organization owner? Sign in with your password or passkey
                    </button>
                  )}
                </>
              ) : (
                <>
                  <div className="relative">
                    <Input
                      id="signin-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      required
                      className="pr-10"
                      placeholder="Password"
                      aria-label="Password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={isLoading}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      disabled={isLoading}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      aria-pressed={showPassword}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded text-fg-muted hover:text-fg focus:outline-none focus:ring-2 focus:ring-brand"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
                    </button>
                  </div>
                  <Button type="submit" fullWidth disabled={isLoading} className="text-sm">
                    {isLoading
                      ? <><LoadingSpinner size="sm" className="mr-2" /> Signing in...</>
                      : <><LogIn className="w-4 h-4 mr-1.5" /> Sign in</>
                    }
                  </Button>
                  {ssoOffered && (
                    <Button type="button" variant="secondary" fullWidth disabled={ssoBusy} className="text-sm" onClick={(e) => { void startSso(e); }}>
                      {ssoBusy
                        ? <><LoadingSpinner size="sm" className="mr-2" /> Redirecting…</>
                        : <><Building2 className="w-4 h-4 mr-1.5" /> Continue with single sign-on</>}
                    </Button>
                  )}
                </>
              )}
            </form>
            )}

            {/* Passkeys and social sign-in are bypasses for a federated account —
                the backend refuses both with the same SSO_REQUIRED — so they go
                away with the password field. */}
            {!mfaChallengeId && !pwChange && !ssoRequired && (passkeySupported || providers.length > 0) && (
              <div className="mt-4">
                <div className="flex items-center gap-3 mb-3">
                  <span className="flex-1 h-px bg-[var(--pb-border)]" />
                  <span className="text-2xs uppercase tracking-wide text-fg-muted">or</span>
                  <span className="flex-1 h-px bg-[var(--pb-border)]" />
                </div>
                <div className="space-y-2">
                  {/* Explicit passkey sign-in. Shown even where autofill works —
                      the dropdown is easy to miss, and one visible button is
                      better than an invisible affordance. */}
                  {passkeySupported && (
                    <Button
                      type="button"
                      variant="secondary"
                      fullWidth
                      onClick={handlePasskeySignIn}
                      disabled={isLoading || passkeyBusy || oauthBusy !== null}
                      className="text-sm"
                    >
                      {passkeyBusy
                        ? <><LoadingSpinner size="sm" className="mr-2" /> Waiting for your passkey…</>
                        : <><KeyRound className="w-4 h-4 mr-1.5" /> Sign in with a passkey</>}
                    </Button>
                  )}
                  {providers.map((p) => (
                    <Button
                      key={p}
                      type="button"
                      variant="secondary"
                      fullWidth
                      onClick={() => startOAuth(p)}
                      disabled={isLoading || oauthBusy !== null}
                      className="text-sm"
                    >
                      {oauthBusy === p
                        ? <><LoadingSpinner size="sm" className="mr-2" /> Redirecting…</>
                        : <><LogIn className="w-4 h-4 mr-1.5" /> Sign in with {providerLabel(p)}</>}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {!mfaChallengeId && !pwChange && (
              <p className="text-xs text-fg-muted mt-4 text-center">
                New here?{' '}
                <Link href="/auth/register" className="text-brand hover:underline">
                  Create account
                </Link>
              </p>
            )}
          </Card>
        </motion.div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Strengths — the three positioning pillars (why this, not a generic CI/CD tool)
// ---------------------------------------------------------------------------

const strengths = [
  {
    icon: Cloud,
    title: 'Own your infrastructure',
    text: 'Pipelines deploy as native AWS CodePipeline in your own account — standard resources you can inspect, extend, and keep. Zero lock-in.',
  },
  {
    icon: Shield,
    title: 'Governed by default',
    text: 'Per-org compliance rules, role-based access, and a tamper-evident audit trail apply to every build — governance without the bottleneck.',
  },
  {
    icon: Sparkles,
    title: 'Generate, don’t configure',
    text: 'AI turns a Git URL or a plain-English prompt into a working, plugin-wired pipeline in minutes — no YAML archaeology.',
  },
];

function Strengths() {
  return (
    <section className="py-12 px-6 bg-surface-muted">
      <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-8">
        {strengths.map((s, i) => (
          <motion.div
            key={s.title}
            className="flex flex-col gap-2"
            variants={fadeUp}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            custom={i}
          >
            <s.icon className="w-6 h-6 text-brand" strokeWidth={1.5} />
            <h3 className="font-semibold text-fg">{s.title}</h3>
            <p className="text-sm text-fg-muted leading-relaxed">{s.text}</p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// AI + Providers
// ---------------------------------------------------------------------------

const aiProviders = [
  { name: 'Anthropic', icon: Bot },
  { name: 'OpenAI', icon: Sparkles },
  { name: 'Google', icon: Globe },
  { name: 'xAI', icon: Zap },
  { name: 'Bedrock', icon: Cloud },
];

function AI() {
  return (
    <section id="how" className="py-16 px-6 scroll-mt-16">
      <div className="max-w-4xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-8 items-center">
        <motion.div
          initial={{ opacity: 0, x: -12 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4 }}
        >
          <div className="text-2xs uppercase tracking-wide text-brand font-semibold mb-2">How it works</div>
          <h2 className="text-2xl font-bold mb-3">Paste a Git URL, get a pipeline</h2>
          <p className="text-sm text-fg-muted mb-4 leading-relaxed">
            AI reads your repo, picks the right plugins, and wires up build, test, and
            deploy stages. You review the plan and ship — no YAML to hand-write.
          </p>
          <div className="flex flex-wrap gap-2">
            {aiProviders.map((p) => (
              <span key={p.name} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs bg-surface border border-default">
                <p.icon className="w-3 h-3 text-brand" strokeWidth={1.5} />
                {p.name}
              </span>
            ))}
          </div>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, x: 12 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4, delay: 0.08 }}
        >
          <TerminalBlock title="terminal" code={`$ curl -X POST /api/pipelines/generate \\
  -d '{ "prompt": "Node.js + tests + CDK deploy" }'

{ "stages": [
    { "plugin": "nodejs" },
    { "plugin": "jest" },
    { "plugin": "cdk-deploy" }
  ]
}`} />
        </motion.div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Features — the full value-prop set, grouped so it's comprehensive but scannable
// ---------------------------------------------------------------------------

const featureGroups = [
  {
    icon: Sparkles,
    title: 'Generate',
    items: ['AI from a Git URL or prompt', '119 plugins across 10 categories', 'Golden-path templates', 'Dashboard, CLI, REST API & CDK'],
  },
  {
    icon: Cloud,
    title: 'Deploy',
    items: ['Native AWS CodePipeline + CodeBuild', 'Runs in your own AWS account', 'Per-org container registry', 'Zero lock-in'],
  },
  {
    icon: Shield,
    title: 'Govern',
    items: ['Per-org compliance rules & scans', 'Role-based access control', 'Tamper-evident audit trail', 'SSO / OAuth + step-up auth'],
  },
  {
    icon: BarChart3,
    title: 'Measure',
    items: ['Execution analytics', 'Team usage analytics', 'DORA metrics & trends', 'Observability + quotas'],
  },
];

function Features() {
  return (
    <section className="py-14 px-6">
      <div className="max-w-5xl mx-auto">
        <motion.h2
          className="text-2xl font-bold text-center mb-2"
          initial={{ opacity: 0, y: 8 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4 }}
        >
          Everything you get
        </motion.h2>
        <p className="text-sm text-fg-muted text-center mb-8">
          Generate, deploy, govern, and measure — in one self-service platform.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {featureGroups.map((g, i) => (
            <motion.div
              key={g.title}
              variants={fadeUp}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              custom={i}
            >
              <Card className="h-full p-5">
                <div className="flex items-center gap-2 mb-3">
                  <g.icon className="w-5 h-5 text-brand" strokeWidth={1.5} />
                  <h3 className="font-semibold">{g.title}</h3>
                </div>
                <ul className="space-y-2">
                  {g.items.map((item) => (
                    <li key={item} className="flex items-start gap-1.5 text-sm text-fg-muted">
                      <Check className="w-3.5 h-3.5 mt-0.5 shrink-0 text-success" strokeWidth={2} />
                      {item}
                    </li>
                  ))}
                </ul>
              </Card>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// CTA
// ---------------------------------------------------------------------------

function CTA() {
  return (
    <section className="py-16 px-6 bg-surface-muted">
      <div className="max-w-md mx-auto text-center">
        <h2 className="text-2xl font-bold mb-3">Ship your first pipeline today</h2>
        <p className="text-sm text-fg-muted mb-5">
          Generate it from a repo or a prompt — deployed in your own AWS account, governed from day one.
        </p>
        <Link href="/auth/register" className="btn btn-primary px-6 py-2.5 text-sm">
          Get started free <ArrowRight className="w-3.5 h-3.5 ml-1.5 inline" />
        </Link>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function Footer() {
  return (
    <footer className="border-t border-default py-6 px-6">
      <div className="max-w-5xl mx-auto flex items-center justify-between text-xs text-fg-muted">
        <span className="font-serif font-bold text-sm text-fg">Pipeline Builder</span>
        <span>Apache 2.0</span>
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Terminal block
// ---------------------------------------------------------------------------

function TerminalBlock({ title, code }: { title: string; code: string }) {
  return (
    <div className="rounded-lg border border-default bg-surface overflow-hidden shadow-sm">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-default bg-surface-muted">
        <span className="w-2 h-2 rounded-full bg-red-400/60" />
        <span className="w-2 h-2 rounded-full bg-yellow-400/60" />
        <span className="w-2 h-2 rounded-full bg-green-400/60" />
        <span className="ml-2 text-2xs text-fg-muted">{title}</span>
      </div>
      <pre className="p-3 text-2xs leading-relaxed font-mono text-fg-muted overflow-x-auto">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <NavBar />
      <Hero />
      <Strengths />
      <AI />
      <Features />
      <CTA />
      <Footer />
    </div>
  );
}
