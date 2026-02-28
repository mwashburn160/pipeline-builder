import { useState, useEffect } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { UserPlus, CheckCircle, Check } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useFeatures } from '@/hooks/useFeatures';
import { LoadingSpinner } from '@/components/ui/Loading';
import type { Plan } from '@/types';
import api from '@/lib/api';

/** Border color class per plan tier. */
const PLAN_COLORS: Record<string, string> = {
  developer: 'border-green-500',
  pro: 'border-blue-500',
  unlimited: 'border-purple-500',
};

/** Badge color classes per plan tier. */
const PLAN_BADGE_COLORS: Record<string, string> = {
  developer: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  pro: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  unlimited: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
};

/**
 * Formats a price in cents as a monthly dollar string.
 * @param cents - Price in cents (0 returns "Free").
 * @returns Formatted price string, e.g. "$9.99/mo".
 */
function formatPrice(cents: number): string {
  if (cents === 0) return 'Free';
  return `$${(cents / 100).toFixed(2)}/mo`;
}

/** User registration page. Collects credentials, optional organization name, and billing plan selection. */
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
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!billingEnabled) return;
    api.getPlans().then((res) => {
      if (res.success && res.data?.plans) {
        setPlans(res.data.plans);
      }
    }).catch(() => {
      // Plans will fall back to empty — user can still register on default plan
    });
  }, [billingEnabled]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (!username || !email || !password) {
      setError('Please fill in all required fields');
      return;
    }

    if (username.length < 3) {
      setError('Username must be at least 3 characters');
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Please enter a valid email address');
      return;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    try {
      await register(username, email, password, organizationName || undefined, billingEnabled ? selectedPlan : undefined);
      setSuccess(true);
      setTimeout(() => router.push('/auth/login'), 2000);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Registration failed. Please try again.');
    }
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 py-12 px-4 sm:px-6 lg:px-8 transition-colors">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.3 }}
          className="max-w-md w-full space-y-8 text-center"
        >
          <div className="alert-success">
            <CheckCircle className="mx-auto h-12 w-12 mb-4" />
            <h3 className="text-lg font-medium">Registration successful!</h3>
            <p className="mt-2 text-sm">Redirecting to login...</p>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <>
    <Head>
      <title>Register - Pipeline Builder</title>
    </Head>
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 py-12 px-4 sm:px-6 lg:px-8 transition-colors">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="max-w-2xl w-full space-y-8"
      >
        <div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900 dark:text-gray-100">
            Create your account
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600 dark:text-gray-400">
            Already have an account?{' '}
            <Link href="/auth/login" className="font-medium text-blue-600 dark:text-blue-400 hover:text-blue-500 dark:hover:text-blue-300 transition-colors">
              Sign in
            </Link>
          </p>
        </div>

        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          {error && (
            <div className="alert-error">
              <p>{error}</p>
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label htmlFor="username" className="label">
                Username *
              </label>
              <input
                id="username"
                name="username"
                type="text"
                autoComplete="username"
                required
                className="input"
                placeholder="johndoe"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={isLoading}
              />
            </div>

            <div>
              <label htmlFor="email" className="label">
                Email *
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                className="input"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isLoading}
              />
            </div>

            <div>
              <label htmlFor="organizationName" className="label">
                Organization Name (optional)
              </label>
              <input
                id="organizationName"
                name="organizationName"
                type="text"
                className="input"
                placeholder="My Company"
                value={organizationName}
                onChange={(e) => setOrganizationName(e.target.value)}
                disabled={isLoading}
              />
            </div>

            {/* Plan Selection */}
            {plans.length > 0 && (
              <div>
                <label className="label mb-3">Choose a plan</label>
                <div className="grid grid-cols-3 gap-3">
                  {plans.map((plan) => {
                    const isSelected = selectedPlan === plan.id;
                    const borderColor = PLAN_COLORS[plan.id] || 'border-gray-300';
                    const badgeColor = PLAN_BADGE_COLORS[plan.id] || 'bg-gray-100 text-gray-800';

                    return (
                      <button
                        key={plan.id}
                        type="button"
                        onClick={() => setSelectedPlan(plan.id)}
                        disabled={isLoading}
                        className={`relative rounded-lg border-2 p-4 text-left transition-all ${
                          isSelected
                            ? `${borderColor} bg-white dark:bg-gray-800 shadow-md`
                            : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-gray-300 dark:hover:border-gray-600'
                        }`}
                      >
                        {isSelected && (
                          <div className="absolute top-2 right-2">
                            <Check className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                          </div>
                        )}
                        <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${badgeColor}`}>
                          {plan.name}
                        </span>
                        <p className="mt-2 text-lg font-bold text-gray-900 dark:text-gray-100">
                          {formatPrice(plan.prices.monthly)}
                        </p>
                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                          {plan.description}
                        </p>
                        <ul className="mt-3 space-y-1">
                          {plan.features.slice(0, 3).map((feature) => (
                            <li key={feature} className="flex items-start text-xs text-gray-600 dark:text-gray-400">
                              <Check className="w-3 h-3 mr-1 mt-0.5 text-green-500 flex-shrink-0" />
                              {feature}
                            </li>
                          ))}
                        </ul>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div>
              <label htmlFor="password" className="label">
                Password *
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                className="input"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isLoading}
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Must be at least 8 characters</p>
            </div>

            <div>
              <label htmlFor="confirmPassword" className="label">
                Confirm Password *
              </label>
              <input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                className="input"
                placeholder="••••••••"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={isLoading}
              />
            </div>
          </div>

          <div>
            <button
              type="submit"
              disabled={isLoading}
              className="btn btn-primary w-full justify-center"
            >
              {isLoading ? (
                <>
                  <LoadingSpinner size="sm" className="mr-2" />
                  Creating account...
                </>
              ) : (
                <>
                  <UserPlus className="w-4 h-4 mr-2" />
                  Create account
                </>
              )}
            </button>
          </div>
        </form>
      </motion.div>
    </div>
    </>
  );
}
