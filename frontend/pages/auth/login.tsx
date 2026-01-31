import { useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { Button, Input, Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui';
import { GitBranch } from 'lucide-react';
import { ApiError } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      await login(email, password);
      window.location.href = '/dashboard';
    } catch (err) {
      if (err instanceof ApiError) {
        // Handle specific status codes
        if (err.statusCode === 401) {
          setError('Invalid email or password');
        } else if (err.statusCode === 403) {
          setError('Account is disabled or not verified');
        } else if (err.statusCode === 429) {
          setError('Too many attempts. Please try again later');
        } else {
          setError(err.message);
        }
      } else {
        setError(err instanceof Error ? err.message : 'Login failed');
      }
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="flex justify-center mb-8">
          <Link href="/" className="flex items-center space-x-2">
            <div className="h-12 w-12 rounded-xl bg-primary-600 flex items-center justify-center">
              <GitBranch className="h-7 w-7 text-white" />
            </div>
            <span className="text-2xl font-bold text-gray-900 dark:text-white">Pipeline Builder</span>
          </Link>
        </div>

        <Card>
          <CardHeader className="text-center">
            <CardTitle>Welcome back</CardTitle>
            <CardDescription>Sign in to your account to continue</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="p-3 text-sm text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg">
                  {error}
                </div>
              )}

              <Input
                id="email"
                type="email"
                label="Email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />

              <Input
                id="password"
                type="password"
                label="Password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />

              <Button type="submit" className="w-full" size="lg" isLoading={isLoading}>
                Sign in
              </Button>
            </form>

            <div className="mt-6 text-center text-sm">
              <span className="text-gray-500 dark:text-gray-400">
                Don&apos;t have an account?{' '}
              </span>
              <Link href="/auth/register" className="text-primary-600 hover:text-primary-500 font-medium">
                Sign up
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
