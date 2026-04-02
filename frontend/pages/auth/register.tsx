import { useState, useEffect } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { UserPlus, CheckCircle, Check, ArrowLeft } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useFeatures } from '@/hooks/useFeatures';
import { LoadingSpinner } from '@/components/ui/Loading';
import type { Plan } from '@/types';
import api from '@/lib/api';

function formatPrice(cents: number): string {
  return cents === 0 ? 'Free' : `$${(cents / 100).toFixed(2)}/mo`;
}

export default function RegisterPage() {
  const router = useRouter();
  const { register, isLoading } = useAuth();
  const features = useFeatures();
  const billingEnabled = features.isEnabled('billing');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [selectedPlan, setSelectedPlan] = useState('developer');
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState(false);

  const validateField = (field: string, value: string) => {
    let err = '';
    if (field === 'username' && value && value.length < 3) err = 'Min 3 characters';
    if (field === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) err = 'Invalid email';
    if (field === 'password' && value && value.length < 8) err = 'Min 8 characters';
    if (field === 'confirmPassword' && value && password && value !== password) err = 'Passwords do not match';
    setFieldErrors(prev => ({ ...prev, [field]: err }));
  };

  useEffect(() => {
    if (!billingEnabled) return;
    api.getPlans().then((res) => {
      if (res.success && res.data?.plans) setPlans(res.data.plans);
    }).catch(() => {});
  }, [billingEnabled]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    if (!username || !email || !password) { setError('Fill in all required fields'); return; }
    if (username.length < 3) { setError('Username must be at least 3 characters'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('Enter a valid email'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    if (password !== confirmPassword) { setError('Passwords do not match'); return; }

    try {
      await register(username, email, password, organizationName || undefined, billingEnabled ? selectedPlan : undefined);
      setSuccess(true);
      setTimeout(() => router.push('/'), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    }
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="card p-8 max-w-xs text-center" role="status" aria-live="polite">
          <CheckCircle className="w-10 h-10 text-[var(--pb-success)] mx-auto mb-3" />
          <p className="font-bold">Account created!</p>
          <p className="text-sm text-[var(--pb-text-muted)] mt-1">Redirecting...</p>
        </motion.div>
      </div>
    );
  }

  return (
    <>
      <Head><title>Create Account - Pipeline Builder</title></Head>
      <div className="min-h-screen px-6 py-10">
        <div className="max-w-sm mx-auto mb-6">
          <Link href="/" className="inline-flex items-center gap-1 text-sm text-[var(--pb-text-muted)] hover:text-[var(--pb-text)] transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </Link>
        </div>

        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="max-w-sm mx-auto">
          <h1 className="text-xl font-bold text-center mb-1">Create account</h1>
          <p className="text-sm text-[var(--pb-text-muted)] text-center mb-6">
            Have an account? <Link href="/" className="text-[var(--pb-brand)] hover:underline">Sign in</Link>
          </p>

          <div className="card p-5">
            <form onSubmit={handleSubmit} className="space-y-3">
              {error && <div className="alert-error text-sm">{error}</div>}

              <div>
                <input id="reg-username" type="text" autoComplete="username" required className={`input ${fieldErrors.username ? 'input-error' : ''}`} placeholder="Username" aria-label="Username" value={username} onChange={(e) => setUsername(e.target.value)} onBlur={() => validateField('username', username)} disabled={isLoading} />
                {fieldErrors.username && <p className="form-error mt-1">{fieldErrors.username}</p>}
              </div>
              <div>
                <input id="reg-email" type="email" autoComplete="email" required className={`input ${fieldErrors.email ? 'input-error' : ''}`} placeholder="Email" aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => validateField('email', email)} disabled={isLoading} />
                {fieldErrors.email && <p className="form-error mt-1">{fieldErrors.email}</p>}
              </div>
              <input id="reg-org" type="text" className="input" placeholder="Organization (optional)" aria-label="Organization name" value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} disabled={isLoading} />
              <div>
                <input id="reg-password" type="password" autoComplete="new-password" required className={`input ${fieldErrors.password ? 'input-error' : ''}`} placeholder="Password (min 8 chars)" aria-label="Password" value={password} onChange={(e) => setPassword(e.target.value)} onBlur={() => validateField('password', password)} disabled={isLoading} />
                {fieldErrors.password && <p className="form-error mt-1">{fieldErrors.password}</p>}
              </div>
              <div>
                <input id="reg-confirm" type="password" autoComplete="new-password" required className={`input ${fieldErrors.confirmPassword ? 'input-error' : ''}`} placeholder="Confirm password" aria-label="Confirm password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} onBlur={() => validateField('confirmPassword', confirmPassword)} disabled={isLoading} />
                {fieldErrors.confirmPassword && <p className="form-error mt-1">{fieldErrors.confirmPassword}</p>}
              </div>

              {plans.length > 0 && (
                <div className="grid grid-cols-3 gap-2 pt-1">
                  {plans.map((plan) => (
                    <button
                      key={plan.id}
                      type="button"
                      onClick={() => setSelectedPlan(plan.id)}
                      disabled={isLoading}
                      className={`rounded-lg border-2 p-2.5 text-left transition-all text-xs ${
                        selectedPlan === plan.id
                          ? 'border-[var(--pb-brand)] bg-[var(--pb-surface)]'
                          : 'border-[var(--pb-border)] hover:border-[var(--pb-text-muted)]'
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        <p className="font-bold">{plan.name}</p>
                        {selectedPlan === plan.id && <Check className="w-3 h-3 text-[var(--pb-brand)] shrink-0" />}
                      </div>
                      <p className="text-[var(--pb-brand)] font-bold mt-0.5">{formatPrice(plan.prices.monthly)}</p>
                    </button>
                  ))}
                </div>
              )}

              <button type="submit" disabled={isLoading} className="btn btn-primary btn-full text-sm mt-1">
                {isLoading
                  ? <><LoadingSpinner size="sm" className="mr-2" /> Creating...</>
                  : <><UserPlus className="w-4 h-4 mr-1.5" /> Create account</>
                }
              </button>
            </form>
          </div>
        </motion.div>
      </div>
    </>
  );
}
